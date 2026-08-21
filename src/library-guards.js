/**
 * Runtime-Patches für Export-Klassen von roavatar-renderer, deren interne
 * Promise-Ketten `.then(resolve)` OHNE Rejection-Handler verwenden. Ein einziger
 * Throw in diesen Pfaden lässt `Promise.all`-Ketten nie auflösen – der Render
 * hängt dann still in Phase „assets“ mit LEERER Loading-Label-Liste, bis der
 * Watchdog nach 240 s generisch abbricht („Kein Fortschritt …“).
 *
 * Betroffene Throw-Quellen (beobachtet/gelesen in dist/index.js 1.6.2):
 *  - `AnimatorWrapper.loadAnimation` wirft u. a. „Animation was already loaded“,
 *    wenn zwei Animation-Sets (z. B. Idle + Run eines Cartoony-Pakets) dieselbe
 *    Sub-Animation teilen und der Load-Wettlauf beide zur gleichen Zeit die
 *    Track-Map prüfen lässt (~49207). Außerdem `root.Prop(...)`/`GetChildren()`
 *    auf leeren RBX-Bäumen (~49236, ~49252) und „Parent is missing from Animator“.
 *  - `AnimatorWrapper.loadAvatarAnimation` läuft in dieselben Wände und wird von
 *    `_applyAnimations` über ein `.then(resolve)`-Promise erwartet (~50903).
 *  - `AnimatorWrapper.playAnimation` ist synchron und wird im Executor von
 *    `setMainAnimation`'s `new Promise(...)` aufgerufen – ein Throw dort lässt
 *    das Promise rejecten und `_prepareForThumbnail`'s `.then(() => resolve())`
 *    (~59348 ff.) hängt.
 *  - `HumanoidDescriptionWrapper.applyDescription` wird in `_updateOutfit` über
 *    `.then((result) => …)` konsumiert (~59127): Bei Rejection feuert weder
 *    `onSuccess` noch `onError` – der Render hängt still. Mit Patch läuft die
 *    Kette weiter und `onError("humanoidDescription")` feuert stattdessen.
 *
 * Die Patches ändern NICHT node_modules – sie ummanteln die Prototype-Methoden
 * der exportierten Klassen zur Laufzeit (idempotent). Throws werden zur
 * Skip-Semantik der Bibliothek übersetzt (`undefined` bzw. `false`), damit der
 * Rest des Avatars trotzdem rendert.
 *
 * Reine Funktionen ohne Browser-Abhängigkeiten, damit sie in Node gegen Dummy-
 * Klassen getestet werden können (`node --test`).
 */

/** Markierung an der Prototype, damit ein doppelter Patch harmlos bleibt. */
const PATCHED_FLAG = "__avatarRenderGuarded";

/**
 * Entschärft `AnimatorWrapper.prototype.loadAnimation`, `loadAvatarAnimation`
 * (async → Rejection wird zu `undefined` = überspringen) und `playAnimation`
 * (synchron → Throw wird zu `false` = „konnte nicht abgespielt werden“).
 *
 * @template {{ prototype: object }} AnimatorWrapperClass
 * @param {AnimatorWrapperClass} AnimatorWrapperClass die exportierte Klasse
 * @param {{ onSkipped?: (info: { method: string, id: unknown, error: unknown }) => void }} [options]
 * @returns {string[]} Namen der erfolgreich gepatchten Methoden
 */
export function patchAnimatorWrapper(AnimatorWrapperClass, options = {}) {
  const { onSkipped = () => {} } = options;
  const patched = [];
  const proto = AnimatorWrapperClass?.prototype;
  if (!proto || proto[PATCHED_FLAG]) return patched;

  for (const name of ["loadAnimation", "loadAvatarAnimation"]) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = async function guardedAnimationLoad(...args) {
      try {
        return await original.apply(this, args);
      } catch (error) {
        onSkipped({ method: name, id: args[0], error });
        // undefined = „Asset nicht anwendbar“ – die Aufrufer der Bibliothek
        // werten nur `instanceof Response` als Fehler, undefined gilt als ok.
        return undefined;
      }
    };
    patched.push(name);
  }

  const originalPlay = proto.playAnimation;
  if (typeof originalPlay === "function") {
    proto.playAnimation = function guardedPlayAnimation(...args) {
      try {
        return originalPlay.apply(this, args);
      } catch (error) {
        onSkipped({ method: "playAnimation", id: args[0], error });
        return false;
      }
    };
    patched.push("playAnimation");
  }

  Object.defineProperty(proto, PATCHED_FLAG, { value: true, enumerable: false, configurable: true });
  return patched;
}

/**
 * Entschärft `HumanoidDescriptionWrapper.prototype.applyDescription`: Bei einem
 * Throw wird `undefined` geliefert statt zu rejecten. `_updateOutfit` behandelt
 * „kein Instance-Ergebnis“ dann als Fehler und feuert `onError("humanoidDescription")`
 * → `prepareForThumbnail` liefert `false` → der Bot meldet eine konkrete
 * Fehlerstufe statt still hängenzubleiben.
 *
 * @template {{ prototype: object }} HumanoidDescriptionWrapperClass
 * @param {HumanoidDescriptionWrapperClass} HumanoidDescriptionWrapperClass die exportierte Klasse
 * @param {{ onSkipped?: (info: { method: string, error: unknown }) => void }} [options]
 * @returns {boolean} true, wenn ein Patch durchgeführt wurde
 */
export function patchHumanoidDescriptionApply(HumanoidDescriptionWrapperClass, options = {}) {
  const { onSkipped = () => {}, stepDeadlineMs = 165_000 } = options;
  const proto = HumanoidDescriptionWrapperClass?.prototype;
  if (!proto || proto[PATCHED_FLAG]) return false;
  const original = proto.applyDescription;
  if (typeof original !== "function") return false;

  // applyDescription startet diese Methoden parallel. Mehrere davon bauen um
  // GetRBX().then(...) eigene Promises, deren Executor bei einem Throw (etwa
  // generateTree()/GetChildren() auf einem ungewöhnlichen UGC-Asset) niemals
  // resolve aufruft. Ein Catch um applyDescription hilft dann nicht: Das innere
  // Promise ist pending, nicht rejected. Deshalb bekommt jeder einzelne
  // Arbeitsschritt eine Deadline und Skip-Semantik. Der Rest des Avatars kann
  // anschließend fertig gebaut werden.
  const stepNames = [
    "_applyAccessories",
    "_applyClothing",
    "_applyBodyParts",
    "_applyFace",
    "_applyAnimations",
    "_applyMakeup",
    "_applyGear",
  ];
  for (const name of stepNames) {
    const originalStep = proto[name];
    if (typeof originalStep !== "function") continue;
    proto[name] = function guardedDescriptionStep(...args) {
      let timer;
      const outcome = Promise.resolve().then(() => originalStep.apply(this, args));
      // Die eventuell später eintreffende Rejection des Originals stets
      // beobachten, auch wenn die Deadline das Rennen bereits gewonnen hat.
      outcome.catch(() => {});
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          onSkipped({ method: name, error: new Error(`${name} hat nach ${Math.round(stepDeadlineMs / 1000)} s das Zeitlimit erreicht`) });
          resolve(undefined);
        }, stepDeadlineMs);
      });
      return Promise.race([outcome, deadline])
        .catch((error) => {
          onSkipped({ method: name, error });
          return undefined;
        })
        .finally(() => clearTimeout(timer));
    };
  }

  proto.applyDescription = async function guardedApplyDescription(...args) {
    try {
      return await original.apply(this, args);
    } catch (error) {
      onSkipped({ method: "applyDescription", error });
      return undefined;
    }
  };
  Object.defineProperty(proto, PATCHED_FLAG, { value: true, enumerable: false, configurable: true });
  return true;
}

/**
 * Schließt zwei Event-Races in OutfitRenderer 1.6.2:
 *  - Der Konstruktor startet _updateOutfit sofort; onSuccess kann bereits vor
 *    dem Listener in _prepareForThumbnail gefeuert worden sein.
 *  - addInstance kann synchron fertig kompilieren und onRenderSuccess feuern,
 *    BEVOR _prepareForThumbnail unmittelbar danach seinen Listener verbindet.
 *
 * Nach dem Verbinden wird der aktuelle Zustand deshalb einmal nachgespielt.
 * Das ändert den normalen Pfad nicht, löst aber ein bereits verpasstes Signal
 * auf, statt 200 Sekunden bei der leeren Signatur `assets|` zu hängen.
 */
export function patchOutfitRenderer(OutfitRendererClass) {
  const proto = OutfitRendererClass?.prototype;
  const flag = "__avatarRenderEventRaceGuarded";
  if (!proto || proto[flag] || typeof proto.prepareForThumbnail !== "function") return false;
  const original = proto.prepareForThumbnail;

  proto.prepareForThumbnail = async function guardedPrepareForThumbnail(...args) {
    const successEvent = this.onSuccess;
    const renderEvent = this.onRenderSuccess;
    const successConnect = successEvent?.Connect;
    const renderConnect = renderEvent?.Connect;

    if (typeof successConnect === "function") {
      successEvent.Connect = (callback) => {
        const connection = successConnect.call(successEvent, callback);
        queueMicrotask(() => {
          if (this.currentRig && !this.currentlyUpdating && !this.currentlyChangingRig) callback();
        });
        return connection;
      };
    }
    if (typeof renderConnect === "function") {
      renderEvent.Connect = (callback) => {
        const connection = renderConnect.call(renderEvent, callback);
        // fireFullyRenderedIfNeeded prüft selbst alle Voraussetzungen. Wichtig:
        // erst nach Connect aufrufen, damit ein synchrones Event nicht verloren geht.
        queueMicrotask(() => this.fireFullyRenderedIfNeeded?.());
        return connection;
      };
    }

    try {
      return await original.apply(this, args);
    } finally {
      if (successEvent && successConnect) successEvent.Connect = successConnect;
      if (renderEvent && renderConnect) renderEvent.Connect = renderConnect;
    }
  };
  Object.defineProperty(proto, flag, { value: true, enumerable: false, configurable: true });
  return true;
}
