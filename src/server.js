import express from "express";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import util from "node:util";
import { setDefaultResultOrder } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
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

import { getBuildInfo } from "./build-info.js";
import { commands } from "./commands.js";
import { config, validateBotConfig } from "./config.js";
import { createDiscordNet } from "./discord-net.js";
import { isAllowedRobloxAssetUrl, openCloudAssetDeliveryUrl, resolveRobloxUser, RobloxError } from "./roblox.js";

const dnsOrder = process.env.DNS_RESULT_ORDER === "verbatim" ? "verbatim" : "ipv4first";
setDefaultResultOrder(dnsOrder);
net.setDefaultAutoSelectFamily(config.autoSelectFamily);

/**
 * Discord/Cloudflare beantwortet Anfragen mit fremdem User-Agent mit einer
 * HTML-Fehlerseite (z. B. "error 1010") statt mit JSON. Alle eigenen Anfragen an
 * die Discord-API laufen deshalb mit einem regelkonformen Bot-User-Agent.
 */
const DISCORD_USER_AGENT = "DiscordBot (https://github.com/merta-studios/RobloxAvatarRenderTest, 1.0.0)";

const configWarnings = validateBotConfig();
let busy = false;
let activeJob = null;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const logError = (...args) => console.error(new Date().toISOString(), ...args);
const discordNet = createDiscordNet({ log });

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rohe TCP-Verbindungsprobe (Happy Eyeballs aus): nur IPv4, mit hartem Zeitlimit. */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - startedAt, error: null });
    });
    socket.once("error", (error) => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - startedAt, error });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - startedAt, error: new Error(`Timeout nach ${timeoutMs} ms überschritten.`) });
    });
  });
}

/**
 * Netzwerk-Diagnose vor dem Login: zeigt in den Logs, auf welcher Ebene eine
 * Verbindung zu Discord hängt (DNS → TCP → TLS/REST → WebSocket).
 */
async function diagnoseNetwork() {
  try {
    const addresses = await dnsLookup("gateway.discord.gg", { all: true });
    log(`[diagnose] DNS gateway.discord.gg: ${addresses.map((entry) => `${entry.address} (${entry.family === 4 ? "IPv4" : "IPv6"})`).join(", ")}`);
  } catch (error) {
    reportError("[diagnose] DNS-Auflösung von gateway.discord.gg fehlgeschlagen", error);
  }

  try {
    const probe = await tcpProbe("gateway.discord.gg", 443, 10_000);
    if (probe.ok) log(`[diagnose] TCP gateway.discord.gg:443 verbunden in ${probe.ms} ms.`);
    else logError(`[diagnose] TCP gateway.discord.gg:443 FEHLER: ${describeError(probe.error)}`);
  } catch (error) {
    reportError("[diagnose] TCP-Probe auf gateway.discord.gg:443 fehlgeschlagen", error);
  }

  // Kein unauthentifizierter REST-Call auf /gateway: genau das löst auf
  // geteilten Hosting-IPs Cloudflare 1015 aus und verlängert die Sperre.
  log(`[diagnose] REST-Hosts: ${discordNet.bases.join(", ")}. /gateway wird nicht unauthentifiziert angefragt.`);
}

/** Baut aus einer Nicht-JSON-Antwort (HTML/Cloudflare) eine kurze, aussagekräftige Log-Zeile. */
function describeHttpProblem(result) {
  const text = result?.text || "";
  const jsonTitle = result?.json?.title;
  const cloudflareCode = /error code:?\s*(\d{3,4})/i.exec(text)?.[1]
    || /Cloudflare Ray ID.*?\b(1\d{3})\b/i.exec(text)?.[1]
    || (/1015/.test(jsonTitle || text) ? "1015" : null);
  const title = jsonTitle || /<title[^>]*>([^<]{0,120})<\/title>/i.exec(text)?.[1]?.trim();
  const parts = [`HTTP ${result?.status ?? "?"}`, `content-type=${result?.contentType || "?"}`];
  if (title) parts.push(`title="${title}"`);
  if (cloudflareCode) parts.push(`cloudflare-error=${cloudflareCode}`);
  if (result?.cfRay) parts.push(`cf-ray=${result.cfRay}`);
  if (result?.retryAfter) parts.push(`retry-after=${result.retryAfter}`);
  if (!title && !cloudflareCode && text) parts.push(`body="${redactSecrets(text.slice(0, 160).replace(/\s+/g, " "))}"`);
  return parts.join(", ");
}

/**
 * Prüft vor dem Gateway-Login den Token über REST (mit Host-Failover).
 * Ein Cloudflare-1015 ist KEIN Grund, den Login zu überspringen: der
 * WebSocket zu gateway.discord.gg bleibt in der Regel erreichbar.
 *
 * @returns {Promise<{ok: boolean, fatal: boolean, restOk: boolean, reason: string|null}>}
 */
async function preflightDiscordAuth() {
  if (discordNet.availableBaseCount() === 0) {
    const waitS = Math.round(discordNet.msUntilAnyHost() / 1000);
    log(`[preflight] REST-Hosts noch im Cloudflare-Cooldown (nächster in ${waitS} s). Gateway-Login ohne REST.`);
    return { ok: true, fatal: false, restOk: false, reason: `REST-Cooldown ${waitS}s, Gateway-Fallback.` };
  }

  const result = await discordNet.probe("/gateway/bot", {
    authorized: true,
    token: config.token,
    timeoutMs: config.restTimeoutMs,
    headers: { "user-agent": DISCORD_USER_AGENT },
  });

  if (result.ok && result.json?.url) {
    const limit = result.json.session_start_limit;
    log(`[preflight] Token akzeptiert über ${result.base}. Gateway ${redactSecrets(result.json.url)}, empfohlene Shards: ${result.json.shards}${limit ? `, Session-Starts übrig: ${limit.remaining}/${limit.total} (Reset in ${Math.round((limit.reset_after ?? 0) / 1000)} s)` : ""}.`);
    if (limit && limit.remaining <= 0) {
      return { ok: true, fatal: false, restOk: false, reason: `Session-Start-Limit erschöpft, Reset in ${Math.round((limit.reset_after ?? 0) / 1000)} s. Gateway-Fallback.` };
    }
    return { ok: true, fatal: false, restOk: true, reason: null };
  }

  if (result.status === 401 || result.fatal) {
    logError("[preflight] Discord lehnt den Token ab (HTTP 401 Unauthorized). Bitte im Developer Portal unter Bot → Reset Token einen neuen Token erzeugen und DISCORD_TOKEN in Render aktualisieren (ohne Präfix 'Bot ', ohne Anführungszeichen/Leerzeichen).");
    return { ok: false, fatal: true, restOk: false, reason: "Ungültiger Bot-Token (HTTP 401)." };
  }

  logError(`[preflight] Discord-REST nicht nutzbar (${result.reason || describeHttpProblem(result)}). Der Gateway-Login läuft trotzdem (wss://gateway.discord.gg).`);
  return { ok: true, fatal: false, restOk: false, reason: result.reason || `REST HTTP ${result.status}` };
}

const botState = {
  status: "offline", // offline | connecting | ready | reconnecting | waiting
  readyAt: null,
  userTag: null,
  loginAttempt: 0,
  nextRetryAt: null,
  lastGatewayError: null,
  lastLoginError: null,
  lastPreflight: null,
  commandRegistration: { state: "pending", startedAt: null, target: null, count: 0, durationMs: null, error: null },
};

const app = express();
app.disable("x-powered-by");
app.get("/health", (_request, response) => {
  const discordReady = Boolean(client?.isReady());
  const healthy = discordReady || !config.healthRequireDiscord || config.skipDiscord;
  response.status(healthy ? 200 : 503).json({
    ok: healthy,
    build: getBuildInfo(),
    busy,
    job: activeJob,
    uptime: Math.round(process.uptime()),
    discord: {
      ready: discordReady,
      status: botState.status,
      user: botState.userTag,
      readyAt: botState.readyAt,
      loginAttempt: botState.loginAttempt,
      nextRetryAt: botState.nextRetryAt,
      ping: client?.ws?.ping ?? null,
      gateway: client?.ws?.gateway ?? null,
      lastError: botState.lastGatewayError,
      lastLoginError: botState.lastLoginError,
      lastPreflight: botState.lastPreflight,
      rest: discordNet.snapshot(),
    },
    commands: botState.commandRegistration,
  });
});

async function fetchAllowedRobloxUrl(initialUrl, signal, extraHeaders = {}) {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (!isAllowedRobloxAssetUrl(currentUrl)) throw new Error("Unerlaubtes Redirect-Ziel");
    const result = await fetch(currentUrl, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "AvatarRenderTest/1.0", ...extraHeaders },
    });
    if (result.status < 300 || result.status >= 400) return result;
    const location = result.headers.get("location");
    if (!location) return result;
    currentUrl = new URL(location, currentUrl).href;
  }
  throw new Error("Zu viele Redirects");
}

/**
 * Lädt ein Roblox-Asset für den Proxy. Mit konfiguriertem OpenCloud-API-Key
 * läuft die Anfrage für assetdelivery.roblox.com zuerst über die offizielle
 * OpenCloud Asset-Delivery-API (funktioniert auch für UGC, das seit April 2025
 * unauthentifiziert HTTP 401 liefert); schlägt sie fehl, folgt der normale
 * assetdelivery-Pfad mit Retry.
 *
 * @returns {Promise<{upstream: Response, via: string}>}
 */
async function fetchUpstreamWithFallbacks(url, extraHeaders, controller) {
  const isAssetDelivery = (() => {
    try { return new URL(url).hostname === "assetdelivery.roblox.com"; } catch { return false; }
  })();

  if (config.openCloudApiKey && isAssetDelivery) {
    const openCloudUrl = openCloudAssetDeliveryUrl(url);
    if (openCloudUrl) {
      try {
        const apiResponse = await fetchAllowedRobloxUrl(openCloudUrl, controller.signal, {
          ...extraHeaders,
          "x-api-key": config.openCloudApiKey,
        });
        if (apiResponse.ok) {
          const data = await apiResponse.json().catch(() => null);
          const location = data?.location || data?.locations?.[0]?.location;
          if (location && isAllowedRobloxAssetUrl(location)) {
            const content = await fetchAllowedRobloxUrl(location, controller.signal, extraHeaders);
            if (content.ok && content.body) {
              log(`[proxy] OpenCloud: ${url.slice(0, 140)} → ${location.slice(0, 100)}`);
              return { upstream: content, via: "opencloud" };
            }
            log(`[proxy] OpenCloud-Location HTTP ${content.status}: ${location.slice(0, 140)}`);
          } else {
            log(`[proxy] OpenCloud ohne location-Feld: ${openCloudUrl.slice(0, 140)}`);
          }
        } else {
          log(`[proxy] OpenCloud HTTP ${apiResponse.status} ${openCloudUrl.slice(0, 140)} – Fallback auf assetdelivery`);
        }
      } catch (error) {
        reportError("[proxy] OpenCloud-Fallback", error);
      }
    }
  }

  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const upstream = await fetchAllowedRobloxUrl(url, controller.signal, extraHeaders);
    if (upstream.ok) return { upstream, via: "assetdelivery" };
    const retryable = [429, 500, 502, 503, 504].includes(upstream.status);
    if (!retryable || attempt === 2) return { upstream, via: "assetdelivery" };
    try { await upstream.body?.cancel?.(); } catch { /* ignore */ }
    const wait = 400 * 2 ** attempt;
    log(`[proxy] HTTP ${upstream.status} ${url.slice(0, 160)} – Retry in ${wait} ms (${attempt + 1}/2)`);
    await sleep(wait);
  }
  // Nicht erreichbar: alle Pfade oben enden in `return`.
  return { upstream: null, via: "assetdelivery" };
}

app.get("/roblox-proxy", async (request, response) => {
  const url = String(request.query.url || "");
  if (!isAllowedRobloxAssetUrl(url)) return response.status(400).json({ error: "URL nicht erlaubt" });

  const extraHeaders = {};
  for (const name of ["roblox-assetformat", "roblox-place-id"]) {
    const value = request.get(name);
    if (value) extraHeaders[name] = value;
  }

  const controller = new AbortController();
  // Header-Phase (bis die erste Antwort da ist) und Stream-Phase getrennt
  // begrenzen: Der Browser bricht nach 60 s ohne Header ab, große Assets dürfen
  // beim Streamen aber deutlich länger brauchen (langsamer CDN auf 0,1 CPU).
  let headerTimer = setTimeout(() => controller.abort(), 50_000);
  let streamTimer = null;
  try {
    const { upstream } = await fetchUpstreamWithFallbacks(url, extraHeaders, controller);
    clearTimeout(headerTimer);
    headerTimer = null;
    if (!upstream || !upstream.ok || !upstream.body) {
      log(`[proxy] HTTP ${upstream?.status ?? "?"} ${url.slice(0, 220)}`);
      return response.status(upstream?.status ?? 502).end();
    }

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
    streamTimer = setTimeout(() => controller.abort(), 180_000);
    await pipeline(upstream.body, limiter, response);
  } catch (error) {
    if (!response.headersSent) response.status(error?.name === "AbortError" ? 504 : 502).json({ error: "Roblox-Asset konnte nicht geladen werden" });
    else response.destroy(error);
  } finally {
    clearTimeout(headerTimer);
    clearTimeout(streamTimer);
  }
});

app.use(express.static("dist", { index: "index.html", maxAge: "1h" }));
app.get("/render", (_request, response) => response.sendFile("index.html", { root: "dist" }));

function logRenderFailure(userId, state, pageError, consoleErrors, failedRequests) {
  const phase = state?.phase || "unbekannt";
  const labels = state?.assetLabels || [];
  logError(`[render] userId=${userId}: Fehler in Phase ${phase}: ${state?.error || "unbekannt"}`);
  logError(`[render] userId=${userId}: assetLabels=${JSON.stringify(labels.slice(-12))}`);
  if (pageError) logError(`[render] userId=${userId}: pageError=${pageError}`);
  if (consoleErrors.length) logError(`[render] userId=${userId}: console=${consoleErrors.slice(-20).join(" | ")}`);
  if (failedRequests.length) logError(`[render] userId=${userId}: requestfailed=${failedRequests.slice(-20).join(" | ")}`);
}

async function renderAvatar(userId, onProgress) {
  let browser;
  const startedAt = Date.now();
  const elapsed = () => `+${Math.round((Date.now() - startedAt) / 1000)} s`;
  let lastPhase = "";
  let lastMessage = "";
  let pageCrashed = null;
  let pageError = null;
  const consoleErrors = [];
  const failedRequests = [];
  try {
    onProgress("browser", "Speichersparender 3D-Renderer wird gestartet …");
    browser = await puppeteer.launch({
      executablePath: config.chromiumPath,
      headless: true,
      protocolTimeout: config.renderTimeoutMs,
      dumpio: config.debug,
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
      if (message.type() === "error") {
        const text = message.text();
        consoleErrors.push(text);
        console.error("Renderer:", text);
      }
    });
    page.on("pageerror", (error) => {
      pageError = redactSecrets(error?.message || String(error));
      console.error("Renderer page error:", pageError);
    });
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.url()} (${request.failure()?.errorText || "?"})`);
    });
    page.on("error", (error) => {
      pageCrashed = error;
      logError(`[render] userId=${userId}: Chromium-Tab abgestürzt: ${error?.message || error}`);
    });

    await page.goto(`http://127.0.0.1:${config.port}/render?userId=${userId}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    log(`[render] userId=${userId}: Chromium gestartet und Renderer-Seite geladen (${elapsed()}).`);

    const progressTimer = setInterval(async () => {
      try {
        const state = await page.evaluate(() => window.__renderState);
        if (!state) return;
        if (state.message) lastMessage = state.message;
        if (state.phase && state.phase !== lastPhase) {
          lastPhase = state.phase;
          log(`[render] userId=${userId}: Phase ${state.phase} – ${state.message || "–"} (${elapsed()})`);
          onProgress(state.phase, state.message);
        }
      } catch { /* Browser is closing. */ }
    }, 1500);

    try {
      try {
        await page.waitForFunction(() => window.__renderState?.done === true, {
          polling: 500,
          timeout: config.renderTimeoutMs,
        });
      } catch (error) {
        if (pageCrashed) {
          throw new Error("Chromium ist während des Renders abgestürzt – meist das Speicherlimit (freier Tarif: ~500 MB). Eventuell hilft ein größerer Tarif.");
        }
        if (error?.name === "TimeoutError") {
          if (!lastPhase && pageError) {
            throw new Error(`Der Renderer konnte nicht initialisiert werden: ${pageError}`);
          }
          throw new Error(`Der Render hat das Zeitlimit von ${Math.round(config.renderTimeoutMs / 1000)} s überschritten (letzte Phase: „${lastPhase || "unbekannt"}“, zuletzt: „${lastMessage || "–"}“).`);
        }
        throw error;
      }
      const state = await page.evaluate(() => window.__renderState);
      if (state?.error) {
        logRenderFailure(userId, state, pageError, consoleErrors, failedRequests);
        const failure = new Error(state.error);
        failure.diagnostics = {
          phase: state.phase,
          message: state.message,
          assetLabels: (state.assetLabels || []).slice(-12),
          pageError,
          consoleErrors: consoleErrors.slice(-20),
          failedRequests: failedRequests.slice(-20),
          buildId: state.buildId || getBuildInfo().id,
        };
        throw failure;
      }
      onProgress("capture", "Finales PNG wird erzeugt …");
      const canvas = await page.$("canvas");
      if (!canvas) throw new Error("Renderer hat keine Bildfläche erzeugt.");
      const png = await canvas.screenshot({ type: "png", optimizeForSpeed: true });
      log(`[render] userId=${userId}: PNG erzeugt, ${(png.length / 1024).toFixed(0)} KB (${elapsed()}).`);
      const skippedAssets = Array.isArray(state?.skippedAssets) ? state.skippedAssets : [];
      if (skippedAssets.length) {
        log(`[render] userId=${userId}: ${skippedAssets.length} Asset(s) übersprungen: ${skippedAssets.slice(0, 12).join(", ")}`);
      }
      return { png, skippedAssets };
    } finally {
      clearInterval(progressTimer);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

app.get("/render-debug", async (request, response) => {
  if (!config.debugRenderEndpoint) {
    return response.status(404).json({ error: "DEBUG_RENDER_ENDPOINT ist nicht aktiv." });
  }
  const userId = Number(request.query.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return response.status(400).json({ error: "userId fehlt oder ungültig" });
  }
  if (busy) {
    return response.status(409).json({ error: "Renderer ist beschäftigt", job: activeJob });
  }
  busy = true;
  activeJob = `debug:${userId}`;
  try {
    const { png, skippedAssets } = await renderAvatar(userId, () => {});
    response.json({ ok: true, userId, bytes: png.length, skippedAssets, build: getBuildInfo() });
  } catch (error) {
    response.status(500).json({
      ok: false,
      userId,
      error: error instanceof Error ? error.message : String(error),
      diagnostics: error?.diagnostics || null,
      build: getBuildInfo(),
    });
  } finally {
    busy = false;
    activeJob = null;
  }
});

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

    const { png, skippedAssets } = await renderAvatar(activeJobUser.id, (_phase, message) => update(message));
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
    if (skippedAssets?.length) {
      const list = skippedAssets.slice(0, 8).map((id) => `rbxassetid://${id}`).join(", ");
      const more = skippedAssets.length > 8 ? ` (+${skippedAssets.length - 8} weitere)` : "";
      doneEmbed.addFields({
        name: `⚠️ ${skippedAssets.length} Asset(s) übersprungen`,
        value: `Roblox liefert diese Assets ohne Authentifizierung nicht mehr (HTTP 401 seit April 2025). ${list}${more}. Mit \`ROBLOX_OPENCLOUD_API_KEY\` werden sie nachgeladen.`,
      });
    }
    await interaction.editReply({ embeds: [doneEmbed], files: [attachment] });
  } catch (error) {
    reportError("[render] Render fehlgeschlagen", error);
    const friendly = error instanceof RobloxError ? error.message
      : error?.name === "TimeoutError" ? "Der Render hat das Zeitlimit überschritten."
      : (error?.message || "Unbekannter Fehler");
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

let client;
let verboseLogin = false;

/** Frischer Client je Login-Versuch; Logs alter Instanzen werden über isCurrent() unterdrückt. */
function createClient() {
  const newClient = new Client({
    intents: [GatewayIntentBits.Guilds],
    shards: [0],
    shardCount: 1,
    // Host-Failover + Gateway-Fallback sitzen in discordNet.makeRequest.
    // rejectOnRateLimit verhindert, dass discord.js bei Cloudflare 1015 6 h blockiert.
    rest: {
      timeout: config.restTimeoutMs,
      retries: 1,
      userAgentAppendix: "RobloxAvatarRenderTest",
      ...discordNet.restClientOptions(),
    },
  });
  const isCurrent = () => newClient === client;

  newClient.on(Events.ClientReady, (readyClient) => {
    if (!isCurrent()) return;
    verboseLogin = false;
    botState.status = "ready";
    botState.readyAt = new Date().toISOString();
    botState.userTag = readyClient.user.tag;
    log(`[gateway] Discord: eingeloggt als ${readyClient.user.tag} (ID ${readyClient.user.id}).`);
    log(`[gateway] Endpunkt ${newClient.ws.gateway}, Shards ${newClient.ws.shards.size}, Ping ${newClient.ws.ping} ms, Guilds im Cache: ${newClient.guilds.cache.size}.`);
  });
  newClient.on(Events.ShardReconnecting, (shardId) => {
    if (!isCurrent()) return;
    botState.status = "reconnecting";
    log(`[gateway] Shard ${shardId}: Verbindung wird wiederhergestellt …`);
  });
  newClient.on(Events.ShardResume, (shardId, replayed) => {
    if (!isCurrent()) return;
    botState.status = "ready";
    log(`[gateway] Shard ${shardId}: Sitzung fortgesetzt (${replayed} Events erneut zugestellt).`);
  });
  newClient.on(Events.ShardDisconnect, (event, shardId) => {
    if (!isCurrent()) return;
    botState.status = "reconnecting";
    log(`[gateway] Shard ${shardId}: Verbindung getrennt (Code ${event.code}${event.reason ? `, Grund: ${event.reason}` : ""}).`);
  });
  newClient.on(Events.ShardError, (error, shardId) => {
    if (!isCurrent()) return;
    botState.lastGatewayError = redactSecrets(error?.message || String(error));
    reportError(`[gateway] Shard ${shardId}`, error);
  });
  newClient.on(Events.Warn, (info) => {
    if (!isCurrent()) return;
    log(`[discord] Warnung: ${redactSecrets(info)}`);
  });
  newClient.on(Events.Error, (error) => {
    if (!isCurrent()) return;
    botState.lastGatewayError = redactSecrets(error?.message || String(error));
    reportError("[discord]", error);
  });
  newClient.on(Events.Invalidated, () => {
    if (!isCurrent()) return;
    botState.status = "offline";
    logError("[gateway] Sitzung invalidiert (Token zurückgezogen oder Session abgelaufen). Es wird automatisch neu verbunden.");
    void restartLogin("Sitzung invalidiert");
  });
  // Während der Login-Phase laufen die Debug-Logs automatisch mit (verboseLogin),
  // danach nur noch mit DISCORD_DEBUG=true. Tokens werden grundsätzlich geschwärzt.
  newClient.on(Events.Debug, (message) => {
    if (isCurrent() && (verboseLogin || config.debug)) log(`[debug] ${redactSecrets(message)}`);
  });

  newClient.on("interactionCreate", (interaction) => {
    if (!isCurrent()) return;
    if (interaction.isChatInputCommand() && interaction.commandName === "render_avatar") void handleRender(interaction);
  });

  return newClient;
}

/**
 * Ein einzelner Login-Versuch. `client.login()` gilt erst dann als erfolgreich,
 * wenn der Gateway auch wirklich READY meldet – sonst würde ein aufgelöstes
 * Login-Promise ohne Ready-Event den Bot „online“ erscheinen lassen, obwohl er offline ist.
 */
async function loginOnce() {
  const previous = client;
  client = createClient();
  const current = client;
  if (previous) await previous.destroy().catch(() => {});

  const ready = new Promise((resolve, reject) => {
    current.once(Events.ClientReady, resolve);
    current.once(Events.Invalidated, () => reject(new Error("Discord hat die Sitzung invalidiert (Token ungültig oder zurückgezogen).")));
  });

  try {
    await withTimeout(Promise.all([current.login(config.token), ready]), config.loginTimeoutMs, "Discord-Login");
  } catch (error) {
    // Wichtig: awaiten, damit Sockets und laufende REST-Anfragen des gescheiterten
    // Versuchs wirklich abgeräumt sind, bevor der nächste Versuch startet.
    await current.destroy().catch(() => {});
    if (client === current) client = undefined;
    throw error;
  }
}

/** Login-Schleife mit exponentiellem Backoff. Läuft (Standard) unbegrenzt weiter, statt den Prozess sterben zu lassen. */
async function connectWithRetries() {
  const unlimited = config.loginAttempts === 0;
  const startedAt = Date.now();
  verboseLogin = true;

  for (let attempt = 1; unlimited || attempt <= config.loginAttempts; attempt += 1) {
    const label = unlimited ? `${attempt}` : `${attempt}/${config.loginAttempts}`;
    botState.loginAttempt = attempt;
    botState.status = `connecting (Versuch ${label})`;

    // Vor jedem Versuch prüfen, ob die REST-API mit diesem Token antwortet.
    const preflight = await preflightDiscordAuth();
    botState.lastPreflight = preflight.reason ?? "ok";
    if (preflight.fatal) {
      botState.status = "offline";
      botState.lastLoginError = preflight.reason;
      verboseLogin = false;
      logError("[login] Abbruch: Der hinterlegte Token ist ungültig. Ein Neustart würde nichts ändern – bitte DISCORD_TOKEN korrigieren.");
      return false;
    }

    const via = preflight.restOk ? "REST + Gateway" : "Gateway-Direktverbindung (REST blockiert/Cooldown)";
    log(`[login] Versuch ${label}: Verbinde mit dem Discord-Gateway über ${via} (Timeout: ${config.loginTimeoutMs / 1000} s) …`);
    try {
      await loginOnce();
      verboseLogin = false;
      botState.lastLoginError = null;
      botState.nextRetryAt = null;
      log(`[login] Login abgeschlossen nach ${((Date.now() - startedAt) / 1000).toFixed(1)} s (Versuch ${label}${discordNet.gatewayFallback ? ", Gateway-Fallback" : ""}).`);
      return true;
    } catch (error) {
      botState.lastLoginError = redactSecrets(error?.message || String(error));
      reportError(`[login] Versuch ${label} fehlgeschlagen`, error);
    }

    if (!unlimited && attempt >= config.loginAttempts) break;
    // REST-1015 nicht alle paar Sekunden nachfeuern: mind. Backoff, und wenn REST
    // noch im Cooldown ist und der Gateway-Versuch scheiterte, etwas länger warten.
    const restWait = discordNet.availableBaseCount() === 0 ? Math.min(discordNet.msUntilAnyHost(), 60_000) : 0;
    const delay = Math.max(
      Math.min(config.loginBackoffMs * 2 ** Math.min(attempt - 1, 10), config.loginBackoffMaxMs),
      restWait,
    );
    botState.status = "waiting";
    botState.nextRetryAt = new Date(Date.now() + delay).toISOString();
    log(`[login] Nächster Versuch in ${Math.round(delay / 1000)} s …`);
    await sleep(delay);
  }

  verboseLogin = false;
  botState.status = "offline";
  logError(`[login] Alle ${config.loginAttempts} Versuche fehlgeschlagen nach ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
  return false;
}

/** Command-Registrierung per REST, mit Zeitlimits auf beiden Ebenen. */
async function registerCommands() {
  const guildScoped = Boolean(config.guildId);
  const target = guildScoped ? `Guild ${config.guildId}` : "global";
  botState.commandRegistration = { state: "registering", startedAt: new Date().toISOString(), target, count: 0, durationMs: null, error: null };
  log(`[commands] Registriere ${commands.length} Command(s) (${target}) über REST …`);
  const registrationStartedAt = Date.now();
  try {
    const rest = new REST({
      version: "10",
      timeout: config.restTimeoutMs,
      retries: 1,
      userAgentAppendix: "RobloxAvatarRenderTest",
      ...discordNet.restClientOptions(),
    }).setToken(config.token);
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
    logError("[commands] Der Bot bleibt online, der Slash-Command ist aber ggf. nicht verfügbar. Status: GET /health.");
  }
}

let botRunning = false;

/** Startet die Login-Schleife erneut (z. B. nach invalidierter Sitzung), ohne den Prozess zu beenden. */
async function restartLogin(reason) {
  if (botRunning) return;
  log(`[login] Neuer Verbindungsaufbau (Auslöser: ${reason}).`);
  await startBot({ diagnose: false });
}

async function startBot({ diagnose = true } = {}) {
  if (botRunning) return;
  botRunning = true;
  try {
    const startedAt = Date.now();
    const build = getBuildInfo();
    log(`[startup] Start (Node ${process.version}, PID ${process.pid}, build=${build.id}, git=${build.gitCommit}, branch=${build.gitBranch}).`);
    log(`[startup] App-ID ${config.applicationId}, Commands ${config.guildId ? `nur für Guild ${config.guildId}` : "global"}, REST-Timeout ${config.restTimeoutMs / 1000} s, Login-Timeout ${config.loginTimeoutMs / 1000} s, Login-Versuche ${config.loginAttempts === 0 ? "unbegrenzt" : config.loginAttempts} (Backoff ${config.loginBackoffMs / 1000}–${config.loginBackoffMaxMs / 1000} s), DNS-Reihenfolge ${dnsOrder}, Healthcheck erfordert Discord: ${config.healthRequireDiscord ? "ja" : "nein"}, Debug-Logs ${config.debug ? "an" : "aus"}.`);
    for (const warning of configWarnings) logError(`[startup] Warnung: ${warning}`);

    // 1) Netzwerk-Diagnose vor dem Login: zeigt in den Logs, auf welcher Ebene es hängt (DNS → TCP → TLS/REST → WebSocket).
    if (diagnose) await diagnoseNetwork();

    // 2) Preflight + Gateway-Login mit Backoff. Erst wenn der Bot online ist, wird registriert.
    const connected = await connectWithRetries();
    if (!connected) {
      logError(`[login] Kein Login möglich nach ${((Date.now() - startedAt) / 1000).toFixed(1)} s. Prozess wird beendet, damit die Plattform einen Neustart versuchen kann.`);
      shutdownNow(1);
      return;
    }

    // 3) Danach Command-Registrierung per REST (mit Host-Failover). Bei 1015
    //    bleibt der Bot online und die Registrierung wird im Hintergrund wiederholt.
    await registerCommands();
    if (botState.commandRegistration.state !== "registered") {
      void retryCommandRegistration();
    }
  } finally {
    botRunning = false;
  }
}

async function retryCommandRegistration() {
  for (let attempt = 1; attempt <= 30 && botState.commandRegistration.state !== "registered"; attempt += 1) {
    const wait = Math.max(15_000, Math.min(discordNet.msUntilAnyHost() || 30_000, 15 * 60 * 1000));
    log(`[commands] Erneuter Registrierungsversuch ${attempt} in ${Math.round(wait / 1000)} s …`);
    await sleep(wait);
    await registerCommands();
  }
}

const server = app.listen(config.port, "0.0.0.0", () => {
  const build = getBuildInfo();
  log(`[http] HTTP: Port ${config.port} (Healthcheck: /health).`);
  log(`[startup] Build ${build.id} git=${build.gitCommit} branch=${build.gitBranch} node=${build.node}.`);
  if (config.skipDiscord) {
    botState.status = "skipped";
    log("[startup] SKIP_DISCORD=true – Discord-Login übersprungen, Render-Pfad bleibt aktiv.");
  } else {
    void startBot();
  }
});

function shutdownNow(exitCode) {
  client?.destroy();
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
