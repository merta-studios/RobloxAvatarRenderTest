import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Integrationstest des Roblox-Proxys gegen die OpenCloud-Nachladung.
 *
 * Reproduziert den Produktionsfehler „UGC-Assets (Shirt, Hose, Accessoires)
 * fehlen trotz gesetztem ROBLOX_OPENCLOUD_API_KEY“:
 *
 * Der Proxy streamte bei erfolgreicher OpenCloud-Nachladung die ROHEN
 * Binärdaten an den Browser. roavatar-renderer erwartet aber auf jede
 * assetdelivery.roblox.com/v2-Antwort eine JSON-Locations-Envelope und ruft
 * `response.json()` + `data.locations[0].location` auf
 * (API.Misc.getCDNURLFromAssetDelivery). Das json() scheiterte an den
 * Binärdaten in einer Promise-Kette OHNE catch – das Asset löste nie auf und
 * wurde erst durch die 150-s-Guard-Deadline übersprungen (~195 s Renderzeit).
 *
 * Geprüft wird gegen den ECHTEN Server-Prozess (mit gestubbtem Roblox-Netzwerk)
 * und – für den Bibliotheks-Contract – mit der ECHTEN roavatar-renderer-API:
 * GetAssetBuffer muss für ein UGC-Asset jetzt in ein ArrayBuffer AUFLÖSEN
 * (vorher: Endlos-Hänger).
 */

// --- Browser-Shim für Node (wie in integration-compile-guard.test.js), ---
// --- damit die echte Bibliothek geladen werden kann.                   ---
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }),
  querySelector: () => null,
  querySelectorAll: () => [],
};
(0, eval)(readFileSync(new URL("../public/draco_decoder.js", import.meta.url), "utf8"));

const { API, FLAGS } = await import("roavatar-renderer");
const { STUB_API_KEY, STUB_CDN_BINARY } = await import("./fixtures/stub-roblox-fetch.mjs");

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function startStubbedServer({ withKey }) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), SKIP_DISCORD: "true" };
  if (withKey) env.ROBLOX_OPENCLOUD_API_KEY = STUB_API_KEY;
  else delete env.ROBLOX_OPENCLOUD_API_KEY;
  const child = spawn(process.execPath, ["tests/fixtures/start-stubbed-server.mjs"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return { child, base };
    } catch { /* noch nicht bereit */ }
    const exited = await Promise.race([new Promise((resolve) => child.once("exit", () => resolve(true))), delay(50).then(() => false)]);
    if (exited) throw new Error("Stub-Server ist während des Starts beendet worden.");
  }
  child.kill("SIGTERM");
  throw new Error("Stub-Server hat nicht auf /health geantwortet.");
}

function stopServer(server) {
  server?.child.kill("SIGTERM");
}

const proxyUrl = (base, target) => `${base}/roblox-proxy?url=${encodeURIComponent(target)}`;

test("Proxy liefert für UGC-Assets die JSON-Locations-Envelope statt Binärdaten (OpenCloud-Pfad)", async () => {
  const server = await startStubbedServer({ withKey: true });
  try {
    // Versionierte Anfrage, wie sie der Client nach der Versions-Rewrite schickt.
    const response = await fetch(proxyUrl(server.base, "https://assetdelivery.roblox.com/v2/assetId/13576957688/version/17576717563"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /json/);

    // Genau das, was die Bibliothek mit der Antwort macht:
    const data = await response.json();
    const location = data.locations?.[0]?.location;
    assert.equal(typeof location, "string", "Envelope muss locations[0].location liefern");
    assert.match(location, /^https:\/\/fts\.rbxcdn\.com\/sc2\/stub-13576957688/);

    // Die CDN-Location muss anschließend selbst über den Proxy als Binary laden.
    const binaryResponse = await fetch(proxyUrl(server.base, location));
    assert.equal(binaryResponse.status, 200);
    const bytes = new Uint8Array(await binaryResponse.arrayBuffer());
    assert.deepEqual(bytes, STUB_CDN_BINARY);
  } finally {
    stopServer(server);
  }
});

test("/health meldet openCloud.configured und das Probe-Ergebnis des Keys", async () => {
  const server = await startStubbedServer({ withKey: true });
  try {
    let probe = null;
    for (let attempt = 0; attempt < 50 && !probe?.at; attempt += 1) {
      const health = await (await fetch(`${server.base}/health`)).json();
      probe = health.openCloud?.probe;
      if (!probe?.at) await delay(100);
    }
    assert.equal(probe?.status, "ok", `Probe-Status sollte ok sein: ${JSON.stringify(probe)}`);
    assert.equal(probe?.http, 200);
  } finally {
    stopServer(server);
  }
});

test("Ohne Key: UGC-Asset wird als HTTP 401 durchgereicht (sofortiger Skip mit Grund)", async () => {
  const server = await startStubbedServer({ withKey: false });
  try {
    const health = await (await fetch(`${server.base}/health`)).json();
    assert.equal(health.openCloud?.configured, false);

    const response = await fetch(proxyUrl(server.base, "https://assetdelivery.roblox.com/v2/assetId/13576957688/version/17576717563"));
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.match(body, /Authentication required/);
  } finally {
    stopServer(server);
  }
});

test("ECHTE Bibliothek löst GetAssetBuffer für UGC-Assets über den Proxy auf (vorher: Endlos-Hänger)", async () => {
  const server = await startStubbedServer({ withKey: true });
  FLAGS.FETCH_FUNC = (input, init = {}) =>
    fetch(proxyUrl(server.base, String(input instanceof Request ? input.url : input)), init);
  try {
    // rbxassetid://… wird von der Bibliothek zu /v2/asset?id=… (Version unbekannt,
    // wie bei Textur-Assets in RBXM-Dateien) – UGC ⇒ 401 ⇒ OpenCloud ⇒ Envelope ⇒ CDN.
    const result = await Promise.race([
      API.Asset.GetAssetBuffer("rbxassetid://13576957688"),
      delay(20_000).then(() => new Error("TIMEOUT: GetAssetBuffer hat nicht aufgelöst – Antwort-Contract verletzt")),
    ]);
    if (result instanceof Error) throw result;
    assert.ok(result instanceof ArrayBuffer, `Erwartet ArrayBuffer, bekommen: ${result}`);
    assert.deepEqual(new Uint8Array(result), STUB_CDN_BINARY);

    // Roblox-eigenes Asset ohne Authentifizierung (öffentlicher Pfad, Envelope-Durchreichung).
    const publicResult = await Promise.race([
      API.Asset.GetAssetBuffer("rbxassetid://27112025"),
      delay(20_000).then(() => new Error("TIMEOUT auch für öffentliches Asset")),
    ]);
    if (publicResult instanceof Error) throw publicResult;
    assert.ok(publicResult instanceof ArrayBuffer);
  } finally {
    FLAGS.FETCH_FUNC = undefined;
    stopServer(server);
  }
});
