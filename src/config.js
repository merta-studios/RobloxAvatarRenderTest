const integer = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} muss zwischen ${min} und ${max} liegen.`);
  }
  return value;
};

export const config = {
  token: process.env.DISCORD_TOKEN,
  applicationId: process.env.DISCORD_APPLICATION_ID,
  guildId: process.env.DISCORD_GUILD_ID || undefined,
  port: integer("PORT", 10000, 1, 65535),
  renderTimeoutMs: integer("RENDER_TIMEOUT_SECONDS", 420, 60, 840) * 1000,
  chromiumPath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  maxProxyBytes: integer("MAX_ASSET_MB", 30, 5, 60) * 1024 * 1024,
  restTimeoutMs: integer("REST_TIMEOUT_SECONDS", 30, 5, 300) * 1000,
  loginTimeoutMs: integer("LOGIN_TIMEOUT_SECONDS", 60, 10, 600) * 1000,
  healthRequireDiscord: (process.env.HEALTH_REQUIRE_DISCORD ?? "true") !== "false",
  debug: process.env.DISCORD_DEBUG === "true",
};

export function validateBotConfig() {
  const missing = [];
  if (!config.token) missing.push("DISCORD_TOKEN");
  if (!config.applicationId) missing.push("DISCORD_APPLICATION_ID");
  if (missing.length) throw new Error(`Fehlende Umgebungsvariablen: ${missing.join(", ")}`);
}
