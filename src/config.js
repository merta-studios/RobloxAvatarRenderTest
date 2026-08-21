const integer = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} muss zwischen ${min} und ${max} liegen.`);
  }
  return value;
};

export const config = {
  token: process.env.DISCORD_TOKEN?.trim().replace(/^Bot\s+/i, ""),
  applicationId: process.env.DISCORD_APPLICATION_ID?.trim(),
  guildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
  port: integer("PORT", 10000, 1, 65535),
  renderTimeoutMs: integer("RENDER_TIMEOUT_SECONDS", 420, 60, 840) * 1000,
  chromiumPath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  maxProxyBytes: integer("MAX_ASSET_MB", 30, 5, 60) * 1024 * 1024,
  restTimeoutMs: integer("REST_TIMEOUT_SECONDS", 20, 5, 300) * 1000,
  loginTimeoutMs: integer("LOGIN_TIMEOUT_SECONDS", 90, 10, 600) * 1000,
  // 0 = unbegrenzt weiterversuchen (Standard): Der Prozess gibt nie auf, sondern
  // versucht es mit wachsendem Backoff erneut. So bleibt der Bot nicht dauerhaft offline.
  loginAttempts: integer("LOGIN_ATTEMPTS", 0, 0, 100),
  loginBackoffMs: integer("LOGIN_BACKOFF_SECONDS", 5, 0, 60) * 1000,
  loginBackoffMaxMs: integer("LOGIN_BACKOFF_MAX_SECONDS", 300, 5, 3600) * 1000,
  // Standardmäßig false: Ein 503-Healthcheck lässt Render den Container töten,
  // während der Bot noch auf Discord wartet – daraus wird eine Neustart-Schleife.
  healthRequireDiscord: (process.env.HEALTH_REQUIRE_DISCORD ?? "false") === "true",
  autoSelectFamily: process.env.AUTO_SELECT_FAMILY === "true",
  debug: process.env.DISCORD_DEBUG === "true",
  // E2E / lokaler Render-Pfad ohne Discord-Gateway.
  skipDiscord: (process.env.SKIP_DISCORD ?? "false") === "true",
  // GET /render-debug?userId=… (kein Discord). Nur bewusst einschalten.
  debugRenderEndpoint: (process.env.DEBUG_RENDER_ENDPOINT ?? "false") === "true",
  // Optionaler OpenCloud-API-Key mit Scope legacy-asset:manage
  // (https://create.roblox.com/dashboard/credentials).
  // Roblox liefert UGC-Assets (Kleidung, Accessoires) seit April 2025 nur noch
  // mit Authentifizierung aus; ohne Key werden solche Assets übersprungen.
  // Mit Key lädt der Proxy sie über apis.roblox.com/asset-delivery-api nach.
  openCloudApiKey: process.env.ROBLOX_OPENCLOUD_API_KEY?.trim() || "",
};

const TOKEN_PATTERN = /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/;

export function validateBotConfig() {
  if (config.skipDiscord) return [];
  const missing = [];
  if (!config.token) missing.push("DISCORD_TOKEN");
  if (!config.applicationId) missing.push("DISCORD_APPLICATION_ID");
  if (missing.length) throw new Error(`Fehlende Umgebungsvariablen: ${missing.join(", ")}`);

  const warnings = [];
  if (!TOKEN_PATTERN.test(config.token)) {
    warnings.push("DISCORD_TOKEN hat nicht das übliche Format (drei Teile, getrennt durch Punkte). Bitte prüfen, ob wirklich der Bot-Token (nicht Client Secret / Public Key) hinterlegt ist.");
  }
  if (!/^\d{15,25}$/.test(config.applicationId)) {
    warnings.push("DISCORD_APPLICATION_ID sieht nicht wie eine Discord-Snowflake aus.");
  }
  if (config.guildId && !/^\d{15,25}$/.test(config.guildId)) {
    warnings.push("DISCORD_GUILD_ID sieht nicht wie eine Discord-Snowflake aus.");
  }
  return warnings;
}
