import express from "express";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import util from "node:util";
import puppeteer from "puppeteer-core";
import {
  AttachmentBuilder,
  Client,
  Events,
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

const log = (...args) => console.log(new Date().toISOString(), ...args);
const logError = (...args) => console.error(new Date().toISOString(), ...args);

function redactSecrets(value) {
  if (typeof value !== "string" || !config.token) return value;
  return value.split(config.token).join("[REDACTED]");
}

function describeError(error) {
  const parts = [`name=${error?.name || "Error"}`, `message=${error?.message || "unbekannt"}`];
  if (error?.code) parts.push(`code=${error.code}`);
  if (error?.status) parts.push(`status=${error.status}`);
  if (error?.method) parts.push(`method=${error.method}`);
  if (error?.url) parts.push(`url=${redactSecrets(error.url)}`);
  if (error?.retryAfter) parts.push(`retryAfter=${error.retryAfter}`);
  if (error?.cause) {
    parts.push(`cause=${redactSecrets(`${error.cause.name || "?"}: ${error.cause.message || ""}`).trim()}`);
  }
  return parts.join(", ");
}

function reportError(context, error) {
  logError(`${context}: ${describeError(error)}`);
  if (config.debug && error && typeof error === "object") {
    logError(`${context} (Details):`, util.inspect(error, { depth: 4, colors: false }));
  }
}

/** Wettlauf gegen ein hartes Zeitlimit; verhindert, dass ein Promise (z. B. REST oder Login) endlos hängt. */
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}: Timeout nach ${Math.round(timeoutMs / 1000)} s überschritten.`));
    }, timeoutMs);
  });
  Promise.resolve(promise).catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const botState = {
  status: "offline", // offline | connecting | ready | reconnecting
  readyAt: null,
  userTag: null,
  lastGatewayError: null,
  commandRegistration: { state: "pending", startedAt: null, target: null, count: 0, durationMs: null, error: null },
};

const app = express();
app.disable("x-powered-by");
app.get("/health", (_request, response) => {
  const discordReady = client.isReady();
  const healthy = discordReady || !config.healthRequireDiscord;
  response.status(healthy ? 200 : 503).json({
    ok: healthy,
    busy,
    job: activeJob,
    uptime: Math.round(process.uptime()),
    discord: {
      ready: discordReady,
      status: botState.status,
      user: botState.userTag,
      readyAt: botState.readyAt,
      ping: client.ws?.ping ?? null,
      gateway: client.ws?.gateway ?? null,
      lastError: botState.lastGatewayError,
    },
    commands: botState.commandRegistration,
  });
});

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
    reportError("[render] Render fehlgeschlagen", error);
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

client.on(Events.ClientReady, (readyClient) => {
  botState.status = "ready";
  botState.readyAt = new Date().toISOString();
  botState.userTag = readyClient.user.tag;
  log(`[gateway] Discord: eingeloggt als ${readyClient.user.tag} (ID ${readyClient.user.id}).`);
  log(`[gateway] Endpunkt ${client.ws.gateway}, Shards ${client.ws.shards.size}, Ping ${client.ws.ping} ms, Guilds im Cache: ${client.guilds.cache.size}.`);
});
client.on(Events.ShardReconnecting, (shardId) => {
  botState.status = "reconnecting";
  log(`[gateway] Shard ${shardId}: Verbindung wird wiederhergestellt …`);
});
client.on(Events.ShardResume, (shardId, replayed) => {
  botState.status = "ready";
  log(`[gateway] Shard ${shardId}: Sitzung fortgesetzt (${replayed} Events erneut zugestellt).`);
});
client.on(Events.ShardDisconnect, (event, shardId) => {
  botState.status = "reconnecting";
  log(`[gateway] Shard ${shardId}: Verbindung getrennt (Code ${event.code}${event.reason ? `, Grund: ${event.reason}` : ""}).`);
});
client.on(Events.ShardError, (error, shardId) => {
  botState.lastGatewayError = redactSecrets(error?.message || String(error));
  reportError(`[gateway] Shard ${shardId}`, error);
});
client.on(Events.Warn, (info) => log(`[discord] Warnung: ${redactSecrets(info)}`));
client.on(Events.Error, (error) => {
  botState.lastGatewayError = redactSecrets(error?.message || String(error));
  reportError("[discord]", error);
});
client.on(Events.Invalidated, () => {
  botState.status = "offline";
  logError("[gateway] Sitzung invalidiert (Token zurückgezogen?). Neustart erforderlich.");
});
if (config.debug) client.on(Events.Debug, (message) => log(`[debug] ${redactSecrets(message)}`));

client.on("interactionCreate", (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "render_avatar") void handleRender(interaction);
});

async function startBot() {
  const startedAt = Date.now();
  log(`[startup] Start (Node ${process.version}, PID ${process.pid}).`);
  log(`[startup] App-ID ${config.applicationId}, Commands ${config.guildId ? `nur für Guild ${config.guildId}` : "global"}, REST-Timeout ${config.restTimeoutMs / 1000} s, Login-Timeout ${config.loginTimeoutMs / 1000} s, Healthcheck erfordert Discord: ${config.healthRequireDiscord ? "ja" : "nein"}, Debug-Logs ${config.debug ? "an" : "aus"}.`);

  // 1) Gateway-Login zuerst: Erst wenn der Bot online ist, wird die Command-Registrierung versucht.
  botState.status = "connecting";
  log(`[login] Verbinde mit dem Discord-Gateway (Timeout: ${config.loginTimeoutMs / 1000} s) …`);
  try {
    await withTimeout(client.login(config.token), config.loginTimeoutMs, "Discord-Login");
  } catch (error) {
    reportError("[login] Login fehlgeschlagen", error);
    logError(`[login] Abbruch nach ${((Date.now() - startedAt) / 1000).toFixed(1)} s. Prozess wird beendet, damit die Plattform einen Neustart versuchen kann.`);
    shutdownNow(1);
    return;
  }
  log(`[login] Login abgeschlossen nach ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);

  // 2) Danach Command-Registrierung per REST, mit Zeitlimits auf beiden Ebenen.
  const guildScoped = Boolean(config.guildId);
  const target = guildScoped ? `Guild ${config.guildId}` : "global";
  botState.commandRegistration = { state: "registering", startedAt: new Date().toISOString(), target, count: 0, durationMs: null, error: null };
  log(`[commands] Registriere ${commands.length} Command(s) (${target}) über REST …`);
  const registrationStartedAt = Date.now();
  try {
    const rest = new REST({ version: "10", timeout: config.restTimeoutMs, retries: 2 }).setToken(config.token);
    const route = guildScoped
      ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
      : Routes.applicationCommands(config.applicationId);
    // Gesamt-Deadline: bis zu 3 Versuche (1 + 2 Retries) à REST-Timeout, plus 5 s Puffer.
    const deadline = config.restTimeoutMs * 3 + 5_000;
    const registered = await withTimeout(rest.put(route, { body: commands }), deadline, "Command-Registrierung");
    const list = Array.isArray(registered) ? registered : [registered];
    const durationMs = Date.now() - registrationStartedAt;
    botState.commandRegistration = { state: "registered", startedAt: botState.commandRegistration.startedAt, target, count: list.length, durationMs, error: null };
    log(`[commands] ${list.length} Command(s) registriert (${target}) in ${(durationMs / 1000).toFixed(1)} s: ${list.map((command) => command.name).join(", ") || "–"}`);
  } catch (error) {
    const durationMs = Date.now() - registrationStartedAt;
    botState.commandRegistration = { state: "failed", startedAt: botState.commandRegistration.startedAt, target, count: 0, durationMs, error: redactSecrets(error?.message || String(error)) };
    reportError(`[commands] Registrierung fehlgeschlagen nach ${(durationMs / 1000).toFixed(1)} s`, error);
    logError("[commands] Der Bot bleibt online, der Slash-Command ist aber ggf. nicht verfügbar. Status: GET /health. (Die Anfrage läuft möglicherweise im Hintergrund weiter.)");
  }
}

const server = app.listen(config.port, "0.0.0.0", () => {
  log(`[http] HTTP: Port ${config.port} (Healthcheck: /health).`);
  void startBot();
});

function shutdownNow(exitCode) {
  client.destroy();
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 10_000).unref();
}

function shutdown(signal) {
  log(`[shutdown] ${signal} empfangen – fahre herunter …`);
  shutdownNow(0);
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logError("[process] Unbehandelte Promise-Ablehnung:", reason));
process.on("uncaughtException", (error) => {
  reportError("[process] Unbehandelter Fehler", error);
  process.exit(1);
});
