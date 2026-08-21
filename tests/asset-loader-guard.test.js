import test from "node:test";
import assert from "node:assert/strict";
import { extractAssetIdFromUrl, guardGetAssetBuffer, guardGetMesh, guardGetRBX } from "../src/asset-loader-guard.js";

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

test("GetRBX-Guard fängt Rejections ab (rbx.fromBuffer wirft auf korruptem RBXM)", async () => {
  const skipped = [];
  const guarded = guardGetRBX(
    async () => { throw new Error("Unknown chunk in RBXM"); },
    { onSkipped: (url) => skipped.push(url) },
  );
  // Ohne Guard würde diese Rejection an den .then(resolve)-Ketten der
  // Bibliothek hängen (Stillstand mit leerer Label-Liste).
  assert.equal(await guarded("rbxassetid://507766388"), undefined);
  assert.deepEqual(skipped, ["rbxassetid://507766388"]);
});

test("GetRBX-Guard beendet hängende RBX-Loads per Deadline statt ewig zu warten", async () => {
  const skipped = [];
  const guarded = guardGetRBX(
    () => new Promise(() => {}),
    { deadlineMs: 20, onSkipped: (url) => skipped.push(url) },
  );
  const startedAt = Date.now();
  assert.equal(await guarded("rbxassetid://507766388"), undefined);
  assert.ok(Date.now() - startedAt < 500, "Deadline muss deutlich unter dem Watchdog liegen");
  assert.deepEqual(skipped, ["rbxassetid://507766388"]);
});

test("GetRBX-Guard lässt RBX-Instanzen und Response-Fehler unverändert durch", async () => {
  const rbxTree = { chunks: 3 };
  const guarded = guardGetRBX(async () => rbxTree);
  assert.equal(await guarded("roavatar://RigR15.rbxm"), rbxTree);
  const failed = new Response("Authentication required", { status: 401 });
  const guardedResponse = guardGetRBX(async () => failed);
  assert.equal(await guardedResponse("rbxassetid://13576957688"), failed);
});

test("Guards melden den GRUND des Überspringens (HTTP-Status, Zeitlimit, Fehler)", async () => {
  const events = [];
  const buffered = guardGetAssetBuffer(
    async (url) => (url === "rbxassetid://1" ? new Response("{}", { status: 401 }) : undefined),
    { deadlineMs: 25, onSkipped: (url, reason) => events.push([url, reason]) },
  );
  assert.equal(await buffered("rbxassetid://1"), undefined);
  assert.deepEqual(events[0], ["rbxassetid://1", "HTTP 401"]);

  // Rejection → gekürzter Fehlercode als Grund.
  const rejected = guardGetAssetBuffer(
    async () => { throw new TypeError("Failed to fetch: net::ERR"); },
    { onSkipped: (url, reason) => events.push([url, reason]) },
  );
  assert.equal(await rejected("rbxassetid://2"), undefined);
  assert.deepEqual(events[1], ["rbxassetid://2", "Failed to fetch: net::ERR"]);

  // Deadline → Zeitlimit als Grund (der Fall, der vorher wie ein 401 aussah).
  const timed = guardGetRBX(
    () => new Promise(() => {}),
    { deadlineMs: 20, onSkipped: (url, reason) => events.push([url, reason]) },
  );
  assert.equal(await timed("rbxassetid://3"), undefined);
  assert.deepEqual(events[2], ["rbxassetid://3", "Zeitlimit 1 s"]);

  // Mesh ohne Basis-Buffer → Grund statt nackter ID.
  const meshEvents = [];
  const mesh = guardGetMesh(async () => undefined, {
    onSkipped: (url, reason) => meshEvents.push([url, reason]),
  });
  const meshResult = await mesh("rbxassetid://4");
  assert.ok(meshResult instanceof Response);
  assert.equal(meshResult.status, 502);
  assert.deepEqual(meshEvents, [["rbxassetid://4", "Basis-Download fehlgeschlagen"]]);
});
