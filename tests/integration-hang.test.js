import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Integrationstest gegen die ECHTE roavatar-renderer-Codepfade:
 * getAssetBufferInternal → assetURLToCDNURL → RBLXGet → FLAGS.FETCH_FUNC.
 *
 * Reproduziert den Produktionsfehler „Kein Fortschritt seit 240 s in Phase
 * assets“ (die Bibliothek hängt an einem nie endenden Fetch, weil ihr interner
 * Promise kein catch hat) und prüft, dass die Guard-Schicht aus
 * renderer-client.js das Asset überspringt statt zu hängen.
 */

// --- Browser-Shim für Node ---
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }),
  querySelector: () => null,
  querySelectorAll: () => [],
};
(0, eval)(readFileSync(new URL("../public/draco_decoder.js", import.meta.url), "utf8"));

const { API, FLAGS } = await import("roavatar-renderer");
const { createFetchWithTimeout } = await import("../src/fetch-timeout.js");
const { extractAssetIdFromUrl, guardGetAssetBuffer, guardGetMesh } = await import("../src/asset-loader-guard.js");

FLAGS.ONLINE_ASSETS = false;
FLAGS.USE_WORKERS = false;
FLAGS.ENABLE_API_CACHE = false;
FLAGS.ENABLE_API_MESH_CACHE = false;
FLAGS.ENABLE_API_RBX_CACHE = false;

const DEADLINE_MS = 60;
const ORIGINAL_GET_ASSET_BUFFER = API.Asset.GetAssetBuffer.bind(API.Asset);
const ORIGINAL_GET_MESH = API.Asset.GetMesh.bind(API.Asset);
const ORIGINAL_GET_LABELS = API.Misc.getCurrentlyLoadingLabels.bind(API.Misc);

/** Setzt alle Wrapper zurück, damit die Tests nicht aufeinander aufbauen. */
function resetWiring() {
  API.Asset.GetAssetBuffer = ORIGINAL_GET_ASSET_BUFFER;
  API.Asset.GetMesh = ORIGINAL_GET_MESH;
  API.Misc.getCurrentlyLoadingLabels = ORIGINAL_GET_LABELS;
}

/** Baut die gleiche Verdrahtung auf wie renderer-client.js, nur mit Test-Fetch. */
function buildClientWiring(fetchMock, onSkipped) {
  resetWiring();
  const nativeFetch = (input, init = {}) => {
    const raw = input instanceof Request ? input.url : String(input);
    if (/^https:\/\//i.test(raw)) return fetchMock(raw, init);
    return Promise.reject(new TypeError(`unerwartete lokale URL ${raw}`));
  };
  const fetchWithTimeout = createFetchWithTimeout(nativeFetch, { timeoutMs: 500 });
  FLAGS.FETCH_FUNC = fetchWithTimeout;

  const skippedAssetIds = new Set();
  const recordSkipped = (url) => {
    skippedAssetIds.add(extractAssetIdFromUrl(url) || String(url).slice(0, 96));
    onSkipped?.(url);
  };
  API.Asset.GetAssetBuffer = guardGetAssetBuffer(ORIGINAL_GET_ASSET_BUFFER, {
    deadlineMs: DEADLINE_MS,
    onSkipped: recordSkipped,
  });
  API.Asset.GetMesh = guardGetMesh(ORIGINAL_GET_MESH, { onSkipped: recordSkipped });

  // Watchdog-Label-Filter wie in renderer-client.js (übersprungene Assets
  // ausblenden, deren Labels die Bibliothek bei Fehlern nicht abräumt).
  API.Misc.getCurrentlyLoadingLabels = () =>
    ORIGINAL_GET_LABELS().filter((label) => !skippedAssetIds.has(extractAssetIdFromUrl(label)));

  return { skippedAssetIds };
}

test("unguarded GetAssetBuffer hängt bei einem nie endenden Fetch (der Produktionsbug)", async () => {
  resetWiring();
  FLAGS.FETCH_FUNC = () => new Promise(() => {});
  const pending = ORIGINAL_GET_ASSET_BUFFER("rbxassetid://13576957688");
  const result = await Promise.race([
    Promise.resolve(pending),
    new Promise((resolve) => setTimeout(() => resolve("HANG"), DEADLINE_MS + 40)),
  ]);
  assert.equal(result, "HANG", "unguarded Loader muss hängen (Bug reproduziert)");
});

test("guard beendet den hängenden Fetch per Deadline und überspringt das Asset", async () => {
  const skipped = [];
  const wiring = buildClientWiring(() => new Promise(() => {}), (url) => skipped.push(url));
  const startedAt = Date.now();
  const result = await API.Asset.GetAssetBuffer("rbxassetid://13576957688");
  assert.equal(result, undefined, "Guard muss undefined liefern (übersprungen)");
  assert.ok(Date.now() - startedAt < 1_000, "Deadline muss schnell feuern");
  assert.deepEqual(wiring.skippedAssetIds, new Set(["13576957688"]));
  assert.deepEqual(skipped, ["rbxassetid://13576957688"]);
});

test("GetRBX auf ein 401-Asset liefert undefined statt zu scheitern", async () => {
  const skipped = [];
  buildClientWiring(
    () => Promise.resolve(new Response(JSON.stringify({ errors: [{ message: "Authentication required to access Asset." }] }), { status: 401 })),
    (url) => skipped.push(url),
  );
  const result = await API.Asset.GetRBX("rbxassetid://99060033706897");
  assert.equal(result, undefined, "401-Asset muss übersprungen werden (undefined)");
  assert.ok(skipped.includes("rbxassetid://99060033706897"));
});

test("übersprungene Assets verschwinden aus den Loading-Labels (Watchdog-Filter)", async () => {
  const wiring = buildClientWiring(() => new Promise(() => {}));
  await API.Asset.GetAssetBuffer("rbxassetid://42");
  assert.deepEqual(wiring.skippedAssetIds, new Set(["42"]));
  const labels = ORIGINAL_GET_LABELS().map((label) => String(label));
  // Die Bibliothek räumt das Label des hängenden Loads nicht ab (bekannter
  // Leak); der Filter aus renderer-client.js blendet es für Watchdog & Logs aus.
  assert.ok(labels.some((label) => label.includes("rbxassetid://42")), "Label ist intern noch vorhanden (Leak dokumentiert)");
  assert.ok(
    !API.Misc.getCurrentlyLoadingLabels().some((label) => String(label).includes("rbxassetid://42")),
    "gefilterte Label-Liste darf das übersprungene Asset nicht mehr enthalten",
  );
});

test("erfolgreiche ArrayBuffer passieren den Guard unverändert", async () => {
  buildClientWiring((raw) => {
    if (raw.includes("assetdelivery.roblox.com")) {
      return Promise.resolve(new Response(JSON.stringify({ locations: [{ location: "https://t1.rbxcdn.com/asset-27112025" }] }), { status: 200 }));
    }
    return Promise.resolve(new Response(new ArrayBuffer(8), { status: 200 }));
  });
  const result = await API.Asset.GetAssetBuffer("rbxassetid://27112025");
  assert.ok(result instanceof ArrayBuffer, "erfolgreiches Asset kommt als ArrayBuffer durch");
  assert.equal(result.byteLength, 8);
});
