import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createFetchWithTimeout } from "../src/fetch-timeout.js";

const TIMEOUT_MS = 150;

/** Startet einen lokalen Testserver und liefert { base, close }. */
function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

test("fetchWithTimeout bricht eine Antwort ohne Header nach dem Timeout ab", async () => {
  const { base, close } = await startTestServer(() => {
    // Verbindung offen halten, nie antworten.
  });
  try {
    const fetchWithTimeout = createFetchWithTimeout(fetch, { timeoutMs: TIMEOUT_MS });
    const startedAt = Date.now();
    await assert.rejects(() => fetchWithTimeout(`${base}/hangs`), { name: "TimeoutError" });
    assert.ok(Date.now() - startedAt >= TIMEOUT_MS - 20, "Abbruch erst nach dem Timeout");
  } finally {
    close();
  }
});

test("fetchWithTimeout bricht einen langsamen Body NICHT ab (Timer gilt nur für Header)", async () => {
  const chunks = 7;
  const { base, close } = await startTestServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    // Erster Chunk sofort (erst dann settled fetch), danach langsam weiter –
    // die Gesamtdauer übersteigt das Zeitlimit deutlich.
    response.write(Buffer.alloc(1024));
    let sent = 1;
    const timer = setInterval(() => {
      response.write(Buffer.alloc(1024));
      sent += 1;
      if (sent >= chunks) {
        clearInterval(timer);
        response.end();
      }
    }, TIMEOUT_MS);
  });
  try {
    const fetchWithTimeout = createFetchWithTimeout(fetch, { timeoutMs: TIMEOUT_MS });
    const response = await fetchWithTimeout(`${base}/slow-body`);
    assert.equal(response.ok, true);
    const total = (await response.arrayBuffer()).byteLength;
    assert.equal(total, 1024 * chunks, "Body muss vollständig ankommen, nicht abgebrochen");
  } finally {
    close();
  }
});

test("fetchWithTimeout respektiert ein übergebenes Signal zusätzlich", async () => {
  const { base, close } = await startTestServer(() => {
    // nie antworten
  });
  try {
    const controller = new AbortController();
    const fetchWithTimeout = createFetchWithTimeout(fetch, { timeoutMs: 5_000 });
    setTimeout(() => controller.abort(new DOMException("eigenes Abbruchsignal", "AbortError")), 30);
    await assert.rejects(() => fetchWithTimeout(`${base}/x`, { signal: controller.signal }), {
      name: "AbortError",
    });
  } finally {
    close();
  }
});
