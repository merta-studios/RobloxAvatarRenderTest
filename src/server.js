import express from "express";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import puppeteer from "puppeteer-core";
import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
} from "discord.js";

import { commands } from "./commands.js";
import { config, validateBotConfig } from "./config.js";
import { isAllowedRobloxAssetUrl, resolveRobloxUser, RobloxError } from "./roblox.js";

validateBotConfig();
let busy = false;
let activeJob = null;

const app = express();
app.disable("x-powered-by");
app.get("/health", (_request, response) => response.json({ ok: true, busy, job: activeJob }));

async function fetchAllowedRobloxUrl(initialUrl, signal) {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (!isAllowedRobloxAssetUrl(currentUrl)) throw new Error("Unerlaubtes Redirect-Ziel");
    const result = await fetch(currentUrl, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "AvatarRenderTest/1.0" },
    });
    if (result.status < 300 || result.status >= 400) return result;
    const location = result.headers.get("location");
    if (!location) return result;
    currentUrl = new URL(location, currentUrl).href;
  }
  throw new Error("Zu viele Redirects");
}

app.get("/roblox-proxy", async (request, response) => {
  const url = String(request.query.url || "");
  if (!isAllowedRobloxAssetUrl(url)) return response.status(400).json({ error: "URL nicht erlaubt" });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const upstream = await fetchAllowedRobloxUrl(url, controller.signal);
    if (!upstream.ok || !upstream.body) return response.status(upstream.status).end();

    const declaredSize = Number(upstream.headers.get("content-length") || 0);
    if (declaredSize > config.maxProxyBytes) return response.status(413).json({ error: "Asset zu groß" });

    response.status(upstream.status);
    for (const header of ["content-type", "content-length", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) response.setHeader(header, value);
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > config.maxProxyBytes) callback(new Error("Asset überschreitet das Größenlimit"));
        else callback(null, chunk);
      },
    });
    await pipeline(upstream.body, limiter, response);
  } catch (error) {
    if (!response.headersSent) response.status(error?.name === "AbortError" ? 504 : 502).json({ error: "Roblox-Asset konnte nicht geladen werden" });
    else response.destroy(error);
  } finally {
    clearTimeout(timeout);
  }
});

app.use(express.static("dist", { index: "index.html", maxAge: "1h" }));
app.get("/render", (_request, response) => response.sendFile("index.html", { root: "dist" }));

async function renderAvatar(userId, onProgress) {
  let browser;
  try {
    onProgress("browser", "Speichersparender 3D-Renderer wird gestartet …");
    browser = await puppeteer.launch({
      executablePath: config.chromiumPath,
      headless: true,
      protocolTimeout: config.renderTimeoutMs,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--no-zygote",
        "--renderer-process-limit=1",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--window-size=640,640",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 640, deviceScaleFactor: 1 });
    page.on("console", (message) => {
      if (message.type() === "error") console.error("Renderer:", message.text());
    });
    page.on("pageerror", (error) => console.error("Renderer page error:", error));

    await page.goto(`http://127.0.0.1:${config.port}/render?userId=${userId}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    let lastPhase = "";
    const progressTimer = setInterval(async () => {
      try {
        const state = await page.evaluate(() => window.__renderState);
        if (state?.phase && state.phase !== lastPhase) {
          lastPhase = state.phase;
          onProgress(state.phase, state.message);
        }
      } catch { /* Browser is closing. */ }
    }, 1500);

    try {
      await page.waitForFunction(() => window.__renderState?.done === true, {
        polling: 500,
        timeout: config.renderTimeoutMs,
      });
      const state = await page.evaluate(() => window.__renderState);
      if (state.error) throw new Error(state.error);
      onProgress("capture", "Finales PNG wird erzeugt …");
      const canvas = await page.$("canvas");
      if (!canvas) throw new Error("Renderer hat keine Bildfläche erzeugt.");
      return await canvas.screenshot({ type: "png", optimizeForSpeed: true });
    } finally {
      clearInterval(progressTimer);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const statusColor = 0x5865f2;
function progressEmbed(user, text, startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return new EmbedBuilder()
    .setColor(statusColor)
    .setTitle(`Avatar-Render: ${user.name}`)
    .setDescription(`⏳ ${text}`)
    .addFields(
      { name: "Roblox User-ID", value: String(user.id), inline: true },
      { name: "Laufzeit", value: `${seconds} s`, inline: true },
    )
    .setFooter({ text: "Es läuft immer nur ein Render gleichzeitig." });
}

async function handleRender(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ Dieser Command ist nur für Administratoren erlaubt.", ephemeral: true });
    return;
  }
  if (busy) {
    await interaction.reply({
      content: `⛔ Der Server rendert bereits${activeJob ? ` **${activeJob}**` : " einen Avatar"}. Bitte warte bis diese Aufgabe fertig ist.`,
      ephemeral: true,
    });
    return;
  }

  busy = true;
  const requestedName = interaction.options.getString("username", true);
  activeJob = requestedName;
  const startedAt = Date.now();
  let heartbeat;
  let lastMessage = "Anfrage wird geprüft …";
  let editChain = Promise.resolve();

  const update = (message, force = false) => {
    lastMessage = message;
    if (!interaction.deferred && !interaction.replied) return;
    editChain = editChain.then(() => interaction.editReply({ embeds: [progressEmbed(activeJobUser, lastMessage, startedAt)] })).catch(console.error);
  };
  let activeJobUser = { id: "–", name: requestedName };

  try {
    await interaction.deferReply();
    update("Roblox-Username wird aufgelöst …", true);
    heartbeat = setInterval(() => update(lastMessage, true), 12_000);

    const controller = new AbortController();
    const resolveTimeout = setTimeout(() => controller.abort(), 20_000);
    try {
      activeJobUser = await resolveRobloxUser(requestedName, controller.signal);
      activeJob = activeJobUser.name;
    } finally {
      clearTimeout(resolveTimeout);
    }
    update("Avatar-Daten wurden gefunden. Render wird vorbereitet …", true);

    const png = await renderAvatar(activeJobUser.id, (_phase, message) => update(message));
    clearInterval(heartbeat);
    heartbeat = undefined;
    await editChain;

    const attachment = new AttachmentBuilder(png, { name: `avatar-${activeJobUser.id}.png` });
    const doneEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`✅ Avatar von ${activeJobUser.name} gerendert`)
      .setDescription("Das Bild wurde lokal aus den 3D-Avatar-Assets gerendert – ohne Roblox Thumbnail API.")
      .setImage(`attachment://avatar-${activeJobUser.id}.png`)
      .addFields(
        { name: "Display Name", value: activeJobUser.displayName || activeJobUser.name, inline: true },
        { name: "User-ID", value: String(activeJobUser.id), inline: true },
        { name: "Dauer", value: `${Math.floor((Date.now() - startedAt) / 1000)} s`, inline: true },
      );
    await interaction.editReply({ embeds: [doneEmbed], files: [attachment] });
  } catch (error) {
    console.error("Render failed:", error);
    const friendly = error instanceof RobloxError ? error.message
      : error?.name === "TimeoutError" ? "Der Render hat das Zeitlimit überschritten."
      : `Render fehlgeschlagen: ${error?.message || "Unbekannter Fehler"}`;
    await editChain;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("❌ Render fehlgeschlagen").setDescription(friendly)], files: [] }).catch(console.error);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    busy = false;
    activeJob = null;
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", (readyClient) => console.log(`Discord: eingeloggt als ${readyClient.user.tag}`));
client.on("interactionCreate", (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "render_avatar") void handleRender(interaction);
});

const server = app.listen(config.port, "0.0.0.0", async () => {
  console.log(`HTTP: Port ${config.port}`);
  try {
    const rest = new REST({ version: "10" }).setToken(config.token);
    const route = config.guildId
      ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
      : Routes.applicationCommands(config.applicationId);
    await rest.put(route, { body: commands });
    console.log(`Discord-Command registriert (${config.guildId ? "Test-Server" : "global"}).`);
    await client.login(config.token);
  } catch (error) {
    console.error("Bot-Start fehlgeschlagen:", error);
    server.close(() => process.exit(1));
  }
});

async function shutdown(signal) {
  console.log(`${signal}: fahre herunter …`);
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
