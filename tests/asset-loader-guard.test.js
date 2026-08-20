import test from "node:test";
import assert from "node:assert/strict";
import { extractAssetIdFromUrl, guardGetAssetBuffer, guardGetMesh } from "../src/asset-loader-guard.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("extractAssetIdFromUrl zieht die Asset-ID aus rbxassetid-URLs", () => {
  assert.equal(extractAssetIdFromUrl("rbxassetid://13576957688"), "13576957688");
  assert.equal(extractAssetIdFromUrl("getAssetBufferInternal-rbxassetid://99060033706897-"), "99060033706897");
  assert.equal(extractAssetIdFromUrl("https://assetdelivery.roblox.com/v2/asset?id=123"), null);
  assert.equal(extractAssetIdFromUrl(undefined), null);
});

test("GetAssetBuffer-Guard reicht erfolgreiche ArrayBuffer unverändert durch", async () => {
  const buffer = new ArrayBuffer(4);
  const guarded = guardGetAssetBuffer(async () => buffer);
  assert.equal(await guarded("rbxassetid://1"), buffer);
});

test("GetAssetBuffer-Guard überspringt fehlgeschlagene HTTP-Antworten (z. B. Roblox 401)", async () => {
  const skipped = [];
  const guarded = guardGetAssetBuffer(
    async () => new Response("{}", { status: 401 }),
    { onSkipped: (url) => skipped.push(url) },
  );
  assert.equal(await guarded("rbxassetid://13576957688"), undefined);
  assert.deepEqual(skipped, ["rbxassetid://13576957688"]);
});

test("GetAssetBuffer-Guard fängt Rejections (abgebrochener Body-Stream) ab und überspringt", async () => {
  const skipped = [];
  const guarded = guardGetAssetBuffer(
    async () => { throw new TypeError("Body abgebrochen"); },
    { onSkipped: (url) => skipped.push(url) },
  );
  assert.equal(await guarded("rbxassetid://99060033706897"), undefined);
  assert.deepEqual(skipped, ["rbxassetid://99060033706897"]);
});

test("GetAssetBuffer-Guard beendet hängende Loads per Deadline statt ewig zu warten", async () => {
  const skipped = [];
  // Das Original löst NIE auf – genau der Fall, der früher den Render
  // „Kein Fortschritt seit 240 s“ hängen ließ.
  const guarded = guardGetAssetBuffer(
    () => new Promise(() => {}),
    { deadlineMs: 20, onSkipped: (url) => skipped.push(url) },
  );
  const startedAt = Date.now();
  const result = await guarded("rbxassetid://42");
  assert.equal(result, undefined);
  assert.ok(Date.now() - startedAt < 500, "Deadline muss deutlich unter dem Watchdog liegen");
  assert.deepEqual(skipped, ["rbxassetid://42"]);
});

test("GetAssetBuffer-Guard verpasst der Deadline kein Ergebnis mehr, wenn das Original nachzieht", async () => {
  const skipped = [];
  let resolveOriginal;
  const guarded = guardGetAssetBuffer(
    () => new Promise((resolve) => { resolveOriginal = resolve; }),
    { deadlineMs: 15, onSkipped: (url) => skipped.push(url) },
  );
  const first = guarded("rbxassetid://7"); // Deadline feuert zuerst
  await sleep(30);
  resolveOriginal(new ArrayBuffer(8));
  assert.equal(await first, undefined);
  assert.deepEqual(skipped, ["rbxassetid://7"]);
});

test("GetMesh-Guard wandelt übersprungene Meshes in eine Response um (kein TypeError)", async () => {
  const skipped = [];
  const guarded = guardGetMesh(
    async () => undefined,
    { onSkipped: (url) => skipped.push(url) },
  );
  const result = await guarded("rbxassetid://99");
  assert.ok(result instanceof Response, "compileMesh erwartet Response als Fehlerpfad");
  assert.equal(result.status, 502);
  assert.deepEqual(skipped, ["rbxassetid://99"]);
});

test("GetMesh-Guard lässt echte Mesh-Ergebnisse unverändert", async () => {
  const mesh = { numverts: 4 };
  const guarded = guardGetMesh(async () => mesh);
  assert.equal(await guarded("rbxassetid://1"), mesh);
});
