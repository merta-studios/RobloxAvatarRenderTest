/**
 * Zeitlimits für Phasen-Promises, deren Aufhängen der Watchdog sonst erst nach
 * 240 s als generische Meldung („Kein Fortschritt …“) meldet.
 *
 * Die Bibliothek löst einzelne Promises unter Umständen NIE auf: `_prepareForThumbnail`
 * wartet z. B. auf `onSuccess`/`onRenderSuccess`, die nie feuern, wenn ein
 * interner `.then(resolve)`-Promise an einem Throw hängt. Ein flaches Zeitlimit
 * würde aber auch legitime, langsame Renders (SwiftShader auf 0,1 CPU) abwürgen,
 * solange sie noch Fortschritt machen.
 *
 * Deshalb zwei Varianten:
 *  - `withDeadline`: flaches Limit – nach `timeoutMs` wird grundsätzlich abgebrochen.
 *  - `withStallDeadline`: bricht erst ab, wenn ein Fortschritts-Signal (z. B. die
 *    Loading-Labels der Bibliothek) sich für `stallMs` NICHT mehr bewegt hat –
 *    plus ein flaches Gesamtlimit (`flatMs`) als zweite Auffanglinie.
 *
 * Reine Funktionen ohne Browser-Abhängigkeiten, damit sie in Node getestet
 * werden können (`node --test`).
 */

/**
 * Lässt `promise` gegen ein flaches Zeitlimit laufen.
 *
 * @template T
 * @param {Promise<T> | T} promise
 * @param {number} timeoutMs
 * @param {(timeoutMs: number) => Error} [buildError]
 * @returns {Promise<T>}
 */
export function withDeadline(promise, timeoutMs, buildError) {
  const toError = buildError || ((ms) => new Error(`Zeitlimit von ${Math.round(ms / 1000)} s überschritten.`));
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(toError(timeoutMs)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Lässt `promise` laufen und bricht ab, wenn `getProgressSignature()` sich für
 * `stallMs` nicht mehr verändert hat (Stillstand) oder `flatMs` insgesamt
 * verstrichen sind. Ein Promise, das weiter Fortschritt zeigt, darf beliebig
 * lange laufen (bis zum flachen Limit).
 *
 * @template T
 * @param {Promise<T> | T} promise Promise, dessen Ergebnis durchgereicht wird
 * @param {{
 *   stallMs?: number,
 *   flatMs?: number,
 *   pollMs?: number,
 *   getProgressSignature?: () => unknown,
 *   buildError?: (info: { reason: "stall" | "flat", stalledMs: number, totalMs: number, signature: string }) => Error,
 * }} [options]
 * @returns {Promise<T>}
 */
export function withStallDeadline(promise, options = {}) {
  const {
    stallMs = 200_000,
    flatMs = 400_000,
    pollMs = 2_500,
    getProgressSignature = () => "",
    buildError,
  } = options;
  const toError = buildError || ((info) => new Error(
    info.reason === "stall"
      ? `Kein Fortschritt seit ${Math.round(info.stalledMs / 1000)} s (Phase-Signal: „${info.signature.slice(0, 96)}“).`
      : `Gesamtzeitlimit von ${Math.round(info.totalMs / 1000)} s überschritten.`,
  ));

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let lastSignature = null;
    let lastMovementAt = startedAt;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      fn(value);
    };

    Promise.resolve(promise).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );

    const timer = setInterval(() => {
      if (settled) return;
      let signature;
      try {
        signature = String(getProgressSignature());
      } catch {
        signature = "";
      }
      const now = Date.now();
      const totalMs = now - startedAt;
      // Das flache Gesamtlimit greift IMMER – auch wenn sich das Signal bei
      // jedem Poll bewegt (sonst könnte ein endlos „fortschreitender“ Promise
      // die Deadline auf Dauer aushebeln).
      if (totalMs >= flatMs) {
        settle(reject, toError({ reason: "flat", stalledMs: now - lastMovementAt, totalMs, signature }));
        return;
      }
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastMovementAt = now;
        return;
      }
      const stalledMs = now - lastMovementAt;
      if (stalledMs >= stallMs) {
        settle(reject, toError({ reason: "stall", stalledMs, totalMs, signature }));
      }
    }, pollMs);
  });
}
