import test from "node:test";
import assert from "node:assert/strict";
import { withDeadline, withStallDeadline } from "../src/render-deadline.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("withDeadline reicht Ergebnisse durch, ohne das Zeitlimit zu berühren", async () => {
  const result = await withDeadline(Promise.resolve(42), 1_000);
  assert.equal(result, 42);
  const lazy = await withDeadline((async () => "wert")(), 1_000);
  assert.equal(lazy, "wert");
});

test("withDeadline bricht bei Timeout mit der konkreten Fehlermeldung ab", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    withDeadline(new Promise(() => {}), 40, (ms) => new Error(`Phasen-Deadline: ${ms} ms`)),
    /Phasen-Deadline: 40 ms/,
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("withDeadline leitet Rejections des Originals unverändert durch", async () => {
  await assert.rejects(
    withDeadline(Promise.reject(new Error("Original-Fehler")), 5_000),
    /Original-Fehler/,
  );
});

test("withStallDeadline bricht ab, wenn das Fortschritts-Signal stillsteht", async () => {
  let signal = 0;
  const startedAt = Date.now();
  await assert.rejects(
    withStallDeadline(new Promise(() => {}), {
      stallMs: 80,
      pollMs: 20,
      getProgressSignature: () => signal,
      buildError: ({ reason }) => new Error(`Stall: ${reason}`),
    }),
    /Stall: stall/,
  );
  assert.ok(Date.now() - startedAt < 500, "Stillstand muss früh erkannt werden");
});

test("withStallDeadline läuft weiter, solange sich das Fortschritts-Signal bewegt", async () => {
  let signal = 0;
  const mover = (async () => {
    // Bewegt das Signal regelmäßig – das Gesamtzeitlimit darf dann zuschlagen,
    // nicht die Stall-Erkennung.
    for (let i = 0; i < 6; i += 1) {
      await sleep(30);
      signal += 1;
    }
    await sleep(30);
    return "fertig";
  })();
  const result = await withStallDeadline(mover, { stallMs: 120, pollMs: 20, getProgressSignature: () => signal });
  assert.equal(result, "fertig");
});

test("withStallDeadline greift auf das flache Gesamtlimit zurück", async () => {
  let signal = 0;
  let stopped = false;
  const mover = (async () => {
    while (!stopped) {
      await sleep(20);
      signal += 1; // ewig fortschreitend – nur flatMs kann noch bremsen
    }
  })();
  try {
    await assert.rejects(
      withStallDeadline(mover, {
        stallMs: 200,
        flatMs: 90,
        pollMs: 20,
        getProgressSignature: () => signal,
        buildError: ({ reason }) => new Error(`Ende: ${reason}`),
      }),
      /Ende: flat/,
    );
  } finally {
    stopped = true; // Mover-Loop beenden, sonst läuft der Test-Prozess ewig
  }
});

test("withStallDeadline leitet Ergebnis und Rejection des Originals durch", async () => {
  assert.equal(await withStallDeadline(Promise.resolve("ok"), { stallMs: 50, pollMs: 10 }), "ok");
  await assert.rejects(
    withStallDeadline(Promise.reject(new Error("Vorzeitiger Fehler")), { stallMs: 50, pollMs: 10 }),
    /Vorzeitiger Fehler/,
  );
});

test("withStallDeadline verträgt werfende Fortschritts-Signale", async () => {
  let calls = 0;
  await assert.rejects(
    withStallDeadline(new Promise(() => {}), {
      stallMs: 60,
      pollMs: 20,
      getProgressSignature: () => {
        calls += 1;
        throw new Error("Signal kaputt");
      },
    }),
    (error) => /Fortschritt/.test(error.message),
  );
  assert.ok(calls > 0);
});
