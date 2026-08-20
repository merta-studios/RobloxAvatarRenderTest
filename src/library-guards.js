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
  const { onSkipped = () => {} } = options;
  const proto = HumanoidDescriptionWrapperClass?.prototype;
  if (!proto || proto[PATCHED_FLAG]) return false;
  const original = proto.applyDescription;
  if (typeof original !== "function") return false;

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
