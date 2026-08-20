import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  apiBasesFromEnv,
  createDiscordNet,
  FALLBACK_GATEWAY_BOT,
  isCloudflareRateLimit,
  parseRetryAfterMs,
} from "../src/discord-net.js";

test("parseRetryAfterMs bevorzugt den HTTP-Header gegenüber Cloudflare-JSON retry_after: 30", () => {
  const ms = parseRetryAfterMs("22023", 30);
  assert.ok(ms >= 22_000_000 && ms <= 22_023_000, `erwartet ~22023 s, erhalten ${ms}`);
});

test("parseRetryAfterMs versteht Discord-Sekundenbruchteile", () => {
  assert.equal(parseRetryAfterMs(undefined, 0.5), 500);
});

test("isCloudflareRateLimit erkennt 1015-JSON", () => {
  assert.equal(isCloudflareRateLimit(429, "", { title: "Error 1015: You are being rate limited" }), true);
  assert.equal(isCloudflareRateLimit(403, "error code: 1010", null), true);
  assert.equal(isCloudflareRateLimit(401, "Unauthorized", { message: "401: Unauthorized" }), false);
});

test("apiBasesFromEnv stellt DISCORD_API_BASE an den Anfang", () => {
  const bases = apiBasesFromEnv({ DISCORD_API_BASE: "https://canary.discord.com/api" });
  assert.equal(bases[0], "https://canary.discord.com/api");
  assert.ok(bases.includes("https://discord.com/api"));
});

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("makeRequest wechselt nach Cloudflare 1015 auf den nächsten API-Host", async () => {
  const calls = [];
  const net = createDiscordNet({
    bases: ["https://discord.com/api", "https://canary.discord.com/api"],
    now: () => 1_000_000,
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("https://discord.com/api")) {
        return jsonResponse(429, {
          type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1015/",
          title: "Error 1015: You are being rate limited",
          retry_after: 30,
        }, { "retry-after": "22023", "cf-ray": "abc-FRA" });
      }
      return jsonResponse(200, { url: "wss://gateway.discord.gg", shards: 1, session_start_limit: { remaining: 999, total: 1000, reset_after: 1, max_concurrency: 1 } });
    },
  });

  const response = await net.makeRequest("https://discord.com/api/v10/gateway/bot");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.shards, 1);
  assert.deepEqual(calls, [
    "https://discord.com/api/v10/gateway/bot",
    "https://canary.discord.com/api/v10/gateway/bot",
  ]);
  assert.equal(net.selected, "https://canary.discord.com/api");
  assert.equal(net.gatewayFallback, false);
});

test("makeRequest liefert Gateway-Fallback ohne weiteren REST-Call, wenn alle Hosts 1015 sind", async () => {
  let calls = 0;
  const net = createDiscordNet({
    bases: ["https://discord.com/api", "https://canary.discord.com/api"],
    now: () => 1_000_000,
    fetch: async () => {
      calls += 1;
      return jsonResponse(429, { title: "Error 1015: You are being rate limited", retry_after: 30 }, { "retry-after": "22023" });
    },
  });

  const first = await net.makeRequest("https://discord.com/api/v10/gateway/bot");
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), FALLBACK_GATEWAY_BOT);
  assert.equal(net.gatewayFallback, true);
  assert.equal(calls, 2);

  const second = await net.makeRequest("https://discord.com/api/v10/gateway/bot");
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), FALLBACK_GATEWAY_BOT);
  assert.equal(calls, 2, "Cooldown muss weitere REST-Calls unterbinden");
});

test("probe setzt Cooldown aus dem Retry-After-Header, nicht aus JSON 30", async () => {
  const net = createDiscordNet({
    bases: ["https://discord.com/api"],
    now: () => 1_000_000,
    fetch: async () => jsonResponse(429, { retry_after: 30, title: "Error 1015: You are being rate limited" }, { "retry-after": "22023" }),
  });
  const result = await net.probe("/gateway/bot", { authorized: true, token: "t" });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.ok(result.retryAfterMs >= 22_000_000);
  assert.ok(net.msUntilAnyHost() >= 22_000_000);
  assert.equal(net.availableBaseCount(), 0);
});

test("probe erkennt HTTP 401 als fatal und versucht keine weiteren Hosts", async () => {
  let calls = 0;
  const net = createDiscordNet({
    bases: ["https://discord.com/api", "https://canary.discord.com/api"],
    fetch: async () => {
      calls += 1;
      return jsonResponse(401, { message: "401: Unauthorized" });
    },
  });
  const result = await net.probe("/gateway/bot", { authorized: true, token: "bad" });
  assert.equal(result.fatal, true);
  assert.equal(result.status, 401);
  assert.equal(calls, 1);
});

test("Dockerfile kopiert discord-net.js in das Runtime-Image", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /discord-net\.js/);
});
