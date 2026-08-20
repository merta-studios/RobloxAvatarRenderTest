/**
 * Discord-REST über geteilte Hosting-IPs (Render Free) läuft regelmäßig in
 * Cloudflare 1015 / HTTP 429. Der Gateway-WebSocket (gateway.discord.gg) ist
 * davon oft nicht betroffen. Dieses Modul:
 *   1. wechselt automatisch zwischen API-Hosts (discord / canary / ptb / discordapp)
 *   2. setzt betroffene Hosts auf den echten Retry-After-Cooldown (Header, nicht das
 *      irreführende JSON-Feld `retry_after: 30` von Cloudflare)
 *   3. liefert für GET /gateway/bot einen lokalen Fallback, damit discord.js den
 *      WebSocket trotzdem öffnen kann, ohne 6 Stunden auf REST zu warten
 */

export const DEFAULT_API_BASES = [
  "https://discord.com/api",
  "https://canary.discord.com/api",
  "https://ptb.discord.com/api",
  "https://discordapp.com/api",
];

export const FALLBACK_GATEWAY_BOT = {
  url: "wss://gateway.discord.gg",
  shards: 1,
  session_start_limit: {
    total: 1000,
    remaining: 1000,
    reset_after: 86_400_000,
    max_concurrency: 1,
  },
};

const MAX_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MIN_COOLDOWN_MS = 5_000;

export function apiBasesFromEnv(env = process.env) {
  const raw = env.DISCORD_API_BASES || env.DISCORD_API_BASE || "";
  const extras = raw.split(",").map((entry) => entry.trim().replace(/\/+$/, "")).filter(Boolean);
  const merged = [...extras, ...DEFAULT_API_BASES];
  return [...new Set(merged)];
}

/**
 * HTTP `Retry-After` (Sekunden oder HTTP-Datum) schlägt das JSON-Feld.
 * Cloudflare 1015 schickt oft `retry_after: 30` im Body, während der Header
 * mehrere Stunden beträgt – das kleinere Feld würde die Sperre nur verlängern.
 */
export function parseRetryAfterMs(retryAfterHeader, jsonRetryAfter) {
  const candidates = [];
  if (retryAfterHeader != null && String(retryAfterHeader).trim() !== "") {
    const raw = String(retryAfterHeader).trim();
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber >= 0) candidates.push(asNumber * 1000);
    else {
      const asDate = Date.parse(raw);
      if (Number.isFinite(asDate)) candidates.push(asDate - Date.now());
    }
  }
  if (jsonRetryAfter != null && jsonRetryAfter !== "") {
    const asNumber = Number(jsonRetryAfter);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      candidates.push(asNumber > 10_000 ? asNumber : asNumber * 1000);
    }
  }
  const ms = candidates.length ? Math.max(...candidates) : 30_000;
  if (!Number.isFinite(ms) || ms <= 0) return 30_000;
  return Math.min(ms, MAX_COOLDOWN_MS);
}

export function isCloudflareRateLimit(status, text = "", json = null) {
  if (status === 429) return true;
  const haystack = `${text || ""} ${json?.title || ""} ${json?.type || ""} ${json?.detail || ""}`;
  return /error[- ]?(?:code:?\s*)?101[05]/i.test(haystack) || /you are being rate/i.test(haystack);
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function apiSuffix(url) {
  const parsed = new URL(url);
  const stripped = parsed.pathname.replace(/^\/api(?=\/|$)/, "");
  return `${stripped || "/"}${parsed.search}`;
}

function isGatewayBotPath(url) {
  try {
    return /\/gateway\/bot\/?$/.test(new URL(url).pathname);
  } catch {
    return /\/gateway\/bot\/?$/.test(String(url));
  }
}

export function createDiscordNet(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const bases = options.bases?.length ? options.bases : apiBasesFromEnv(options.env);
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const cooldowns = new Map();
  let selected = bases[0];
  let gatewayFallback = false;
  let lastBlock = null;

  function cooldownRemaining(base) {
    return Math.max(0, (cooldowns.get(base) ?? 0) - now());
  }

  function availableBases() {
    const open = bases.filter((base) => cooldownRemaining(base) === 0);
    if (open.includes(selected)) return [selected, ...open.filter((base) => base !== selected)];
    return open;
  }

  function msUntilAnyHost() {
    if (!bases.length) return MAX_COOLDOWN_MS;
    if (availableBases().length) return 0;
    return Math.min(...bases.map((base) => cooldownRemaining(base)));
  }

  function markCooldown(base, retryAfterMs, reason) {
    const ms = Math.min(Math.max(Number(retryAfterMs) || 30_000, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
    const until = now() + ms;
    const previous = cooldowns.get(base) ?? 0;
    if (until <= previous) return ms;
    cooldowns.set(base, until);
    lastBlock = { base, reason, until: new Date(until).toISOString(), retryAfterMs: ms };
    log(`[rest] ${base} Cooldown bis ${lastBlock.until} (${Math.round(ms / 1000)} s, ${reason}). Keine weiteren REST-Calls an diesen Host.`);
    return ms;
  }

  function rememberBlock(base, headers, json, status, text) {
    const retryAfterMs = parseRetryAfterMs(headers?.get?.("retry-after") ?? headers?.get?.("Retry-After"), json?.retry_after);
    markCooldown(base, retryAfterMs, `HTTP ${status}${json?.title ? ` ${json.title}` : ""}`);
    lastBlock = {
      ...lastBlock,
      status,
      title: json?.title || null,
      cfRay: headers?.get?.("cf-ray") || headers?.get?.("CF-RAY") || null,
      bodyPreview: String(text || "").slice(0, 160).replace(/\s+/g, " "),
    };
    return retryAfterMs;
  }

  async function readResult(response) {
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return {
      status: response.status,
      ok: response.ok,
      json,
      text,
      contentType: response.headers.get("content-type") || "",
      cfRay: response.headers.get("cf-ray"),
      retryAfter: response.headers.get("retry-after"),
      headers: response.headers,
    };
  }

  /**
   * Echte REST-Anfrage mit Host-Failover. Kein Gateway-Fallback.
   * @returns {Promise<{ok:boolean,status:number,json:any,text:string,base:string|null,blocked:boolean,fatal:boolean,error?:Error}>}
   */
  async function probe(path, { timeoutMs = 15_000, headers = {}, authorized = false, token } = {}) {
    const requestHeaders = { accept: "application/json", ...headers };
    if (authorized && token) requestHeaders.authorization = `Bot ${token}`;
    const open = availableBases();
    if (!open.length) {
      return {
        ok: false,
        blocked: true,
        fatal: false,
        status: 429,
        json: null,
        text: "",
        base: null,
        retryAfterMs: msUntilAnyHost(),
        reason: `Alle Discord-REST-Hosts im Cooldown (nächster in ${Math.round(msUntilAnyHost() / 1000)} s).`,
      };
    }

    let last = null;
    for (const base of open) {
      try {
        const response = await fetchImpl(`${base}/v10${path}`, {
          headers: requestHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const result = await readResult(response);
        result.base = base;
        result.blocked = isCloudflareRateLimit(result.status, result.text, result.json);
        result.fatal = result.status === 401;
        result.retryAfterMs = result.blocked
          ? rememberBlock(base, response.headers, result.json, result.status, result.text)
          : 0;
        if (result.ok) {
          selected = base;
          gatewayFallback = false;
          return { ...result, reason: null };
        }
        if (result.fatal) return { ...result, reason: "Ungültiger Bot-Token (HTTP 401)." };
        last = result;
        if (result.blocked) continue;
        last = result;
      } catch (error) {
        last = {
          ok: false,
          blocked: false,
          fatal: false,
          status: 0,
          json: null,
          text: "",
          base,
          error,
          reason: `Netzwerkfehler: ${error?.message || error}`,
        };
      }
    }

    return {
      ...(last || {}),
      ok: false,
      blocked: Boolean(last?.blocked) || !last?.status,
      fatal: Boolean(last?.fatal),
      reason: last?.reason || last?.error?.message || `REST nicht nutzbar (HTTP ${last?.status || "?"}).`,
    };
  }

  async function makeRequest(url, init = {}) {
    const suffix = apiSuffix(url);
    const gatewayBot = isGatewayBotPath(url);
    const open = availableBases();

    if (!open.length && gatewayBot) {
      gatewayFallback = true;
      log("[gateway] Alle Discord-REST-Hosts im Cloudflare-Cooldown – Fallback wss://gateway.discord.gg (ohne REST).");
      return jsonResponse(FALLBACK_GATEWAY_BOT);
    }

    if (!open.length) {
      const retrySeconds = Math.max(1, Math.round(msUntilAnyHost() / 1000));
      return jsonResponse(
        { message: "You are being rate limited.", retry_after: retrySeconds, global: true },
        429,
        { "retry-after": String(retrySeconds) },
      );
    }

    let lastFailure = null;
    for (const base of open) {
      if (init.signal?.aborted) {
        const abortError = init.signal.reason instanceof Error ? init.signal.reason : new Error("Aborted");
        throw abortError;
      }
      const tryUrl = `${base}${suffix}`;
      try {
        const response = await fetchImpl(tryUrl, init);
        if (response.status === 401) {
          selected = base;
          return response;
        }
        if (response.status === 429 || response.status === 403) {
          const text = await response.text();
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          if (isCloudflareRateLimit(response.status, text, json)) {
            rememberBlock(base, response.headers, json, response.status, text);
            lastFailure = { response, text };
            log(`[rest] ${base} blockiert (HTTP ${response.status}), nächster API-Host …`);
            continue;
          }
          return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        if (response.ok || (response.status >= 400 && response.status < 500)) {
          selected = base;
          gatewayFallback = false;
          return response;
        }
        try { await response.body?.cancel?.(); } catch { /* ignore */ }
        lastFailure = { response };
        log(`[rest] ${base} HTTP ${response.status}, nächster API-Host …`);
      } catch (error) {
        if (error?.name === "AbortError" || init.signal?.aborted) throw error;
        lastFailure = { error };
        log(`[rest] ${base} Netzwerkfehler: ${error?.message || error}`);
      }
    }

    if (gatewayBot) {
      gatewayFallback = true;
      log("[gateway] Discord-REST nicht nutzbar – verbinde direkt mit wss://gateway.discord.gg.");
      return jsonResponse(FALLBACK_GATEWAY_BOT);
    }

    if (lastFailure?.text != null) {
      return new Response(lastFailure.text, {
        status: lastFailure.response.status,
        statusText: lastFailure.response.statusText,
        headers: lastFailure.response.headers,
      });
    }
    if (lastFailure?.response) return lastFailure.response;
    throw lastFailure?.error ?? new Error("Discord-REST nicht erreichbar.");
  }

  function snapshot() {
    return {
      selected,
      gatewayFallback,
      lastBlock,
      cooldowns: Object.fromEntries([...cooldowns.entries()].map(([base, until]) => [base, new Date(until).toISOString()])),
      nextHostMs: msUntilAnyHost(),
    };
  }

  return {
    bases,
    makeRequest,
    probe,
    availableBases,
    availableBaseCount: () => availableBases().length,
    msUntilAnyHost,
    snapshot,
    get selected() { return selected; },
    get gatewayFallback() { return gatewayFallback; },
    restClientOptions(extra = {}) {
      return {
        api: selected,
        makeRequest,
        // Lange Cloudflare-Sperren nicht intern 6 h blockierend abwarten.
        rejectOnRateLimit: ({ retryAfter }) => retryAfter > 20_000,
        ...extra,
      };
    },
  };
}
