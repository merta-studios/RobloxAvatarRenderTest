/**
 * fetch mit hartem Zeitlimit auf die Antwort-Header.
 *
 * roavatar-renderer setzt selbst kein Timeout. Ein naives Signal-Timeouts über
 * die gesamte Fetch-Dauer würde aber auch den Body-Download abbrechen: Große
 * Roblox-Assets, die auf 0,1 CPU langsam streamen, würden mitten im Transfer
 * gekillt und der interne Loader der Bibliothek hängt sich an dem daraus
 * resultierenden Body-Fehler endgültig auf („Kein Fortschritt seit 240 s in
 * Phase assets“).
 *
 * Deshalb: Der Timer gilt NUR bis die Antwort-Header da sind (fetch settled).
 * Danach wird er gelöscht – der Body darf so lange streamen, wie der Proxy und
 * die Pro-Asset-Deadline des GetAssetBuffer-Guards es erlauben. Ein hängender
 * Body wird vom Proxy (eigenes Stream-Zeitlimit) bzw. vom Guard beendet.
 *
 * Reine Funktion ohne Browser-Abhängigkeiten (fetch wird injiziert), damit sie
 * in Node getestet werden kann.
 *
 * @param {typeof fetch} nativeFetch z. B. window.fetch.bind(window)
 * @param {{ timeoutMs?: number }} [options]
 * @returns {(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>}
 */
export function createFetchWithTimeout(nativeFetch, options = {}) {
  const { timeoutMs = 60_000 } = options;
  return function fetchWithTimeout(input, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("Zeitüberschreitung", "TimeoutError"));
    }, timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return nativeFetch(input, { ...init, signal }).finally(() => clearTimeout(timeout));
  };
}
