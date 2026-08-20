/**
 * Guard-Schicht um die Asset-Loader von roavatar-renderer.
 *
 * Problem (beobachtet als „Kein Fortschritt seit 240 s in Phase assets"):
 * `API.Asset.GetAssetBuffer` der Bibliothek hängt sich ENDGÜLTIG auf, wenn der
 * interne Ladevorgang ablehnt (z. B. `response.arrayBuffer()`-Fehler bei einem
 * mitten im Download abgebrochenen Proxy-Stream oder ein JSON-Fehler in der
 * Asset-Delivery-Antwort). Der interne Promise hat keinen `catch`, das
 * Loading-Label wird bei Fehlern nie entfernt – der komplette Render wartet
 * dann ewig und nur der Fortschritts-Watchdog meldet nach 240 s den Abbruch.
 *
 * Diese Guards stellen sicher, dass ein einzelnes nicht ladbares Asset niemals
 * den ganzen Render blockiert:
 *  - Rejections werden abgefangen,
 *  - fehlgeschlagene HTTP-Antworten (z. B. Roblox 401 „Authentication required
 *    to access Asset.") werden zu „übersprungen" (undefined) statt den Render
 *    abzubrechen – die Bibliothek behandelt undefined als „Asset nicht
 *    anwendbar" und rendert den Rest des Avatars weiter,
 *  - ein hartes Zeitlimit (Standard 150 s, unter dem 240-s-Watchdog) beendet
 *    jedes einzelne Asset-Laden auch dann, wenn der Netzwerk-Stack hängt.
 *
 * Reine Funktionen ohne Browser-/Render-Abhängigkeiten, damit sie in Node
 * getestet werden können (`node --test`). `Response` ist in Node >= 18 und im
 * Browser ein globales Objekt.
 */

/** Extrahiert die numerische Asset-ID aus einem rbxassetid://-URL-String. */
export function extractAssetIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const match = url.match(/rbxassetid:\/\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Umhüllt `API.Asset.GetAssetBuffer`, damit der Aufrufer immer ein Ergebnis
 * bekommt:
 *  - Ablehnung (Rejection) -> `undefined` (überspringen),
 *  - nicht-erfolgreiche Response (z. B. HTTP 401) -> `undefined` (überspringen),
 *  - kein Ergebnis innerhalb von `deadlineMs` -> `undefined` (überspringen).
 *
 * Erfolgreiche ArrayBuffer-Ergebnisse passieren unverändert.
 *
 * @param {(url: string, headers?: object, extraStr?: string) => Promise<unknown>} originalGetAssetBuffer
 * @param {{ deadlineMs?: number, onSkipped?: (url: string) => void }} [options]
 * @returns {(url: string, headers?: object, extraStr?: string) => Promise<unknown>}
 */
export function guardGetAssetBuffer(originalGetAssetBuffer, options = {}) {
  const { deadlineMs = 150_000, onSkipped = () => {} } = options;
  return function guardedGetAssetBuffer(url, headers, extraStr) {
    let deadlineTimer;
    const outcome = Promise.resolve(originalGetAssetBuffer(url, headers, extraStr))
      .then((result) => {
        if (result instanceof Response && !result.ok) {
          onSkipped(url);
          return undefined;
        }
        return result;
      })
      .catch(() => {
        // Die Bibliothek vergisst hier ihr Loading-Label; wir überspringen das
        // Asset und lassen den Render weiterlaufen, statt ewig zu warten.
        onSkipped(url);
        return undefined;
      });
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => {
        onSkipped(url);
        resolve(undefined);
      }, deadlineMs);
    });
    return Promise.race([outcome, deadline]).finally(() => clearTimeout(deadlineTimer));
  };
}

/**
 * Umhüllt `API.Asset.GetRBX` (Download + `rbx.fromBuffer`-Parsing). Die Aufrufer
 * in der Bibliothek hängen an `.then(resolve)`-Promises OHNE Rejection-Handler
 * (~50875, ~50903, ~49262, ~49285): Ein einziger Throw – z. B. wirft
 * `rbx.fromBuffer()` auf korrupten/neuen RBXM-Formaten, oder `generateTree()`
 * auf inkonsistenten Bäumen – lässt `Promise.all` in `_applyAnimations`/
 * `loadAvatarAnimation` NIE auflösen. Der Render hängt dann still in Phase
 * „assets“ mit LEERER Loading-Label-Liste („Kein Fortschritt seit 240 s“ ohne
 * „Zuletzt geladen:“), weil alle Downloads längst fertig sind.
 *
 * Der Guard macht daraus Skip-Semantik wie bei GetAssetBuffer:
 *  - Rejection (korrupter Buffer, Parse-Fehler) -> `undefined` (überspringen),
 *  - kein Ergebnis innerhalb von `deadlineMs` -> `undefined` (überspringen).
 *
 * @param {(url: string, headers?: object, extraStr?: string) => Promise<unknown>} originalGetRBX
 * @param {{ deadlineMs?: number, onSkipped?: (url: string) => void }} [options]
 * @returns {(url: string, headers?: object, extraStr?: string) => Promise<unknown>}
 */
export function guardGetRBX(originalGetRBX, options = {}) {
  const { deadlineMs = 190_000, onSkipped = () => {} } = options;
  return function guardedGetRBX(url, headers, contentRepresentationPriorityList) {
    let deadlineTimer;
    const outcome = Promise.resolve(originalGetRBX(url, headers, contentRepresentationPriorityList))
      .catch(() => {
        onSkipped(url);
        return undefined;
      });
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => {
        onSkipped(url);
        resolve(undefined);
      }, deadlineMs);
    });
    return Promise.race([outcome, deadline]).finally(() => clearTimeout(deadlineTimer));
  };
}

/**
 * Umhüllt `API.Asset.GetMesh`. Liefert die Bibliothek `undefined` (weil unser
 * GetAssetBuffer-Guard das Asset übersprungen hat), wird daraus eine
 * fehlgeschlagene Response – die Mesh-Verarbeitung (`compileMesh`) prüft auf
 * `instanceof Response` und läuft sonst in einen TypeError auf `undefined`.
 *
 * @param {(url: string, headers?: object, readOnly?: boolean) => Promise<unknown>} originalGetMesh
 * @param {{ onSkipped?: (url: string) => void }} [options]
 * @returns {(url: string, headers?: object, readOnly?: boolean) => Promise<unknown>}
 */
export function guardGetMesh(originalGetMesh, options = {}) {
  const { onSkipped = () => {} } = options;
  return async function guardedGetMesh(url, headers, readOnly) {
    const result = await originalGetMesh(url, headers, readOnly);
    if (result === undefined) {
      onSkipped(url);
      return new Response("Mesh konnte nicht geladen werden", {
        status: 502,
        statusText: "Mesh nicht ladbar",
      });
    }
    return result;
  };
}
