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
 * fehlen trotz gesetztem ROBLOX_OPENCLOUD_API_KEY“ – in der Fassung, die die
 * Logs vom 2026-08-21 (Deploy MIT PR #15) belegen:
 *
 *  Bug A: Die OpenCloud Asset-Delivery-API antwortet mit HTTP 200 + Location auf
 *         `contentdelivery.roblox.com`. Dieser Host stand nicht in der
 *         Allowlist des Proxys:
 *           [proxy] OpenCloud-Location mit unerlaubtem Host contentdelivery.roblox.com:
 *           HTTP 200, https://contentdelivery.roblox.com/v1/bytes/sc2/<hash>?__token__=… – nächster Versuch
 *         Der Proxy verwarf also JEDE erfolgreiche OpenCloud-Antwort und fiel
 *         auf den öffentlichen Endpunkt zurück, der für UGC nichts liefert.
 *
 *  Bug B: Eine 200-Antwort OHNE `locations` lässt die Bibliothek crashen statt
 *         überspringen (`data.locations[0].location` ⇒ TypeError
 *         „Cannot read properties of undefined (reading '0')“ in einer
 *         Promise-Kette ohne catch ⇒ GetAssetBuffer löst NIE auf ⇒ Skip erst
 *         nach der 150-s-Guard-Deadline, ~194 s Renderzeit).
 *
 * Geprüft wird gegen den ECHTEN Server-Prozess (mit gestubbtem Roblox-Netzwerk,
 * das jetzt die REALEN Hosts/Statuscodes nachbildet) und – für den
 * Bibliotheks-Contract – mit der ECHTEN roavatar-renderer-API.
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
const { patchGetCDNURLFromAssetDelivery } = await import("../src/library-guards.js");
const {
  STUB_API_KEY,
  STUB_CDN_BINARY,
  STUB_UGC_200_WITHOUT_LOCATIONS,
  STUB_UGC_401,
} = await import("./fixtures/stub-roblox-fetch.mjs");

// Original VOR dem Patch sichern: Der Test unten weist damit nach, dass der
// Crash im Original steckt (und ein Wrapper ihn deshalb nicht abfangen könnte).
const originalGetCDNURLFromAssetDelivery = API.Misc.getCDNURLFromAssetDelivery;
// Exakt der Patch, den src/renderer-client.js im Browser anwendet.
assert.equal(patchGetCDNURLFromAssetDelivery(API, FLAGS), true);
// Deterministische Läufe: keine Wiederverwendung von Buffern zwischen Tests.
FLAGS.ENABLE_API_CACHE = false;

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
  // Server-Logs mitschneiden: Die Diagnose-Zeilen sind Teil des Fixes und
  // werden hier genauso geprüft wie das HTTP-Verhalten.
  const logLines = [];
  const collect = (chunk) => { logLines.push(...String(chunk).split("\n").filter(Boolean)); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let exited = false;
  child.once("exit", () => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return { child, base, logLines };
    } catch { /* noch nicht bereit */ }
    await delay(50);
    if (exited) throw new Error("Stub-Server ist während des Starts beendet worden.");
  }
  child.kill("SIGTERM");
  throw new Error("Stub-Server hat nicht auf /health geantwortet.");
}

function stopServer(server) {
  server?.child.kill("SIGTERM");
}

const proxyUrl = (base, target) => `${base}/roblox-proxy?url=${encodeURIComponent(target)}`;

test("Bug A: OpenCloud-Location auf contentdelivery.roblox.com wird als Envelope geliefert und lädt über den Proxy", async () => {
  const server = await startStubbedServer({ withKey: true });
  try {
    // Versionierte Anfrage, wie sie der Client nach der Versions-Rewrite schickt.
    const response = await fetch(proxyUrl(server.base, `https://assetdelivery.roblox.com/v2/assetId/${STUB_UGC_401}/version/17576717563`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /json/);

    // Genau das, was die Bibliothek mit der Antwort macht:
    const data = await response.json();
    const location = data.locations?.[0]?.location;
    assert.equal(typeof location, "string", "Envelope muss locations[0].location liefern");
    assert.match(
      location,
      new RegExp(`^https://contentdelivery\\.roblox\\.com/v1/bytes/sc2/stub-${STUB_UGC_401}\\?__token__=`),
      "Die OpenCloud-Location liegt real auf contentdelivery.roblox.com – sie darf nicht mehr verworfen werden",
    );

    // Die CDN-Location muss anschließend selbst über den Proxy als Binary laden.
    const binaryResponse = await fetch(proxyUrl(server.base, location));
    assert.equal(binaryResponse.status, 200);
    const bytes = new Uint8Array(await binaryResponse.arrayBuffer());
    assert.deepEqual(bytes, STUB_CDN_BINARY);

    // Kein „unerlaubter Host“ mehr in den Logs (das war die Produktions-Zeile).
    assert.equal(
      server.logLines.some((line) => line.includes("unerlaubtem Host")),
      false,
      `Unerwartete Host-Ablehnung: ${server.logLines.filter((line) => line.includes("unerlaubtem Host")).join(" | ")}`,
    );
  } finally {
    stopServer(server);
  }
});

test("Die Allowlist bleibt eng: contentdelivery-Lookalikes werden weiter abgewiesen", async () => {
  const server = await startStubbedServer({ withKey: true });
  try {
    for (const evil of [
      "https://evil-contentdelivery.roblox.com.attacker.com/v1/bytes/sc2/x?__token__=y",
      "https://contentdelivery.roblox.com.attacker.com/v1/bytes/sc2/x?__token__=y",
      "http://contentdelivery.roblox.com/v1/bytes/sc2/x?__token__=y",
    ]) {
      const response = await fetch(proxyUrl(server.base, evil));
      assert.equal(response.status, 400, `Host hätte abgelehnt werden müssen: ${evil}`);
    }
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

    const response = await fetch(proxyUrl(server.base, `https://assetdelivery.roblox.com/v2/assetId/${STUB_UGC_401}/version/17576717563`));
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.match(body, /Authentication required/);
  } finally {
    stopServer(server);
  }
});

test("Bug B: assetdelivery HTTP 200 OHNE locations wird zu HTTP 502 mit Original-Body + Logzeile", async () => {
  const server = await startStubbedServer({ withKey: false });
  try {
    const response = await fetch(proxyUrl(server.base, `https://assetdelivery.roblox.com/v2/assetId/${STUB_UGC_200_WITHOUT_LOCATIONS}/version/1`));
    // Vorher: 200 + Errors-Body → Bibliothek liest locations[0] → TypeError → Hänger.
    assert.equal(response.status, 502, "200 ohne Location darf den Browser nie als Erfolg erreichen");
    const body = await response.text();
    assert.match(body, /Authentication required/, "Original-Body muss für die Diagnose erhalten bleiben");

    await delay(50);
    const logLine = server.logLines.find((line) => line.includes("assetdelivery HTTP 200 ohne Location"));
    assert.ok(logLine, `Diagnose-Logzeile fehlt. Logs: ${server.logLines.slice(-10).join(" | ")}`);
    assert.match(logLine, /body="/, "Logzeile muss einen Body-Ausschnitt enthalten");
  } finally {
    stopServer(server);
  }
});

test("ORIGINAL der Bibliothek crasht bei 200 ohne locations (Beleg für Bug B – Wrapper hilft nicht)", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ errors: [{ code: 401, message: "Authentication required to access Asset." }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const previousFetchFunc = FLAGS.FETCH_FUNC;
  FLAGS.FETCH_FUNC = fakeFetch;
  try {
    await assert.rejects(
      () => originalGetCDNURLFromAssetDelivery("https://assetdelivery.roblox.com/v2/asset?id=1", undefined),
      (error) => {
        assert.ok(error instanceof TypeError, `Erwartet TypeError, bekommen: ${error}`);
        assert.match(String(error.message), /reading '0'|undefined/);
        return true;
      },
    );

    // Der Ersatz macht daraus eine auswertbare Response statt eines Throws.
    const replaced = await API.Misc.getCDNURLFromAssetDelivery("https://assetdelivery.roblox.com/v2/asset?id=1", undefined);
    assert.ok(replaced instanceof Response);
    assert.equal(replaced.status, 502);
  } finally {
    FLAGS.FETCH_FUNC = previousFetchFunc;
  }
});

test("ECHTE Bibliothek löst GetAssetBuffer für UGC-Assets über den Proxy auf (vorher: Endlos-Hänger)", async () => {
  const server = await startStubbedServer({ withKey: true });
  FLAGS.FETCH_FUNC = (input, init = {}) =>
    fetch(proxyUrl(server.base, String(input instanceof Request ? input.url : input)), init);
  try {
    // rbxassetid://… wird von der Bibliothek zu /v2/asset?id=… (Version unbekannt,
    // wie bei Textur-Assets in RBXM-Dateien) – UGC ⇒ OpenCloud ⇒ Envelope mit
    // contentdelivery-Location ⇒ Binary über den Proxy.
    const result = await Promise.race([
      API.Asset.GetAssetBuffer(`rbxassetid://${STUB_UGC_401}`),
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

test("Kein Hänger mehr bei 200 ohne locations: GetAssetBuffer löst schnell mit Response 502 auf", async () => {
  const server = await startStubbedServer({ withKey: false });
  FLAGS.FETCH_FUNC = (input, init = {}) =>
    fetch(proxyUrl(server.base, String(input instanceof Request ? input.url : input)), init);
  try {
    const startedAt = Date.now();
    const result = await Promise.race([
      API.Asset.GetAssetBuffer(`rbxassetid://${STUB_UGC_200_WITHOUT_LOCATIONS}`),
      delay(15_000).then(() => new Error("TIMEOUT: GetAssetBuffer hängt weiterhin (Bug B nicht behoben)")),
    ]);
    if (result instanceof Error) throw result;
    const elapsed = Date.now() - startedAt;
    assert.ok(result instanceof Response, `Erwartet eine Response (Skip-Grund), bekommen: ${result}`);
    assert.equal(result.status, 502);
    assert.ok(elapsed < 5_000, `Auflösung dauerte ${elapsed} ms – der Skip muss sofort passieren, nicht erst nach der 150-s-Deadline`);
  } finally {
    FLAGS.FETCH_FUNC = undefined;
    stopServer(server);
  }
});
