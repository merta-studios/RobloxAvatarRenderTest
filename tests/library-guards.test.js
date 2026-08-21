import test from "node:test";
import assert from "node:assert/strict";
import { patchAnimatorWrapper, patchHumanoidDescriptionApply, patchOutfitRenderer } from "../src/library-guards.js";

/** Dummy-Klasse mit dem gleichen Methoden-Vertrag wie AnimatorWrapper. */
function makeAnimatorClass() {
  return class DummyAnimator {
    async loadAnimation(id) {
      if (id === 1) throw new Error("Animation was already loaded");
      if (id === 2) throw new TypeError("Cannot read properties of undefined (reading 'Prop')");
      return { id, track: true };
    }
    async loadAvatarAnimation(id) {
      throw new Error("Parent is missing from Animator");
    }
    playAnimation(name) {
      if (name === "crash") throw new Error("Parent is missing from Animator");
      return true;
    }
  };
}

test("patchAnimatorWrapper reproduziert den Hänger ohne Patch und entschärft ihn mit Patch", async () => {
  // 1) Original: Der Throw wird zur Rejection, das .then(resolve)-Promise der
  //    Bibliothek (ohne catch) löst NIE auf – der Produktions-Hänger.
  //    (Der no-op-catch verhindert nur den Node-Absturz durch eine unhandled
  //    rejection; resolve bleibt – wie im Produktionsbug – unerreichbar.)
  const Unpatched = makeAnimatorClass();
  const unpatchedResult = await Promise.race([
    new Promise((resolve) => {
      const inner = Unpatched.prototype.loadAnimation.call({ instance: {} }, 1);
      // onErr beobachtet die Rejection nur (verhindert den Node-Absturz) –
      // resolve bleibt wie im Produktionsbug unerreichbar.
      inner.then(() => resolve("resolved"), () => {});
    }),
    new Promise((resolve) => setTimeout(() => resolve("HANG"), 60)),
  ]);
  assert.equal(unpatchedResult, "HANG", "ungepatchter Loader muss hängen (Bug reproduziert)");

  // 2) Mit Patch: derselbe Aufruf läuft in Promise.all durch und liefert undefined.
  const skipped = [];
  const Patched = makeAnimatorClass();
  patchAnimatorWrapper(Patched, { onSkipped: (info) => skipped.push(info) });
  const values = await Promise.all([
    new Promise((resolve) => {
      new Patched().loadAnimation(1).then((result) => resolve(result));
    }),
    new Promise((resolve) => {
      new Patched().loadAnimation(2).then((result) => resolve(result));
    }),
    new Promise((resolve) => {
      new Patched().loadAvatarAnimation(3).then((result) => resolve(result));
    }),
  ]);
  assert.deepEqual(values, [undefined, undefined, undefined], "Throws müssen zu Skip (undefined) werden");
  assert.deepEqual(skipped.map((info) => info.method), ["loadAnimation", "loadAnimation", "loadAvatarAnimation"]);
  assert.deepEqual(skipped.map((info) => info.id), [1, 2, 3]);
});

test("patchAnimatorWrapper behält erfolgreiche Ergebnisse und playAnimation-Rückgabewerte", async () => {
  const skipped = [];
  const Patched = makeAnimatorClass();
  patchAnimatorWrapper(Patched, { onSkipped: (info) => skipped.push(info) });
  const animator = new Patched();
  assert.deepEqual(await animator.loadAnimation(5), { id: 5, track: true }, "Erfolg bleibt unverändert");
  assert.equal(animator.playAnimation("idle:0"), true, "Erfolg bleibt unverändert");
  assert.equal(animator.playAnimation("crash"), false, "Throw wird zu false („konnte nicht abgespielt werden“)");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].method, "playAnimation");
});

test("patchAnimatorWrapper ist idempotent (doppelter Patch ändert nichts)", () => {
  const Patched = makeAnimatorClass();
  assert.deepEqual(patchAnimatorWrapper(Patched), ["loadAnimation", "loadAvatarAnimation", "playAnimation"]);
  const wrappedLoad = Patched.prototype.loadAnimation;
  assert.deepEqual(patchAnimatorWrapper(Patched), [], "zweiter Patch muss ein No-op sein");
  assert.equal(Patched.prototype.loadAnimation, wrappedLoad);
});

test("patchHumanoidDescriptionApply wandelt Rejections in undefined um (onError statt Hänger)", async () => {
  class DummyDescription {
    async applyDescription() {
      throw new Error("Humanoid is missing an Animator");
    }
  }
  const skipped = [];
  const applied = patchHumanoidDescriptionApply(DummyDescription, { onSkipped: (info) => skipped.push(info) });
  assert.equal(applied, true);
  // .then((result) => …) wie in _updateOutfit: ohne Patch würde der Throw die
  // Kette abreißen lassen (weder onSuccess noch onError) – mit Patch läuft sie.
  const result = await new DummyDescription().applyDescription().then((value) => value ?? "Fehlerpfad (onError)");
  assert.equal(result, "Fehlerpfad (onError)");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].method, "applyDescription");
  assert.equal(patchHumanoidDescriptionApply(DummyDescription), false, "zweiter Patch muss ein No-op sein");
});

test("HumanoidDescription-Arbeitsschritt läuft nach Deadline weiter statt pending zu bleiben", async () => {
  class DummyDescription {
    _applyAccessories() {
      return new Promise(() => {});
    }
    async applyDescription() {
      await this._applyAccessories();
      return "avatar-fertig";
    }
  }
  const skipped = [];
  patchHumanoidDescriptionApply(DummyDescription, {
    stepDeadlineMs: 20,
    onSkipped: (info) => skipped.push(info),
  });
  const result = await Promise.race([
    new DummyDescription().applyDescription(),
    new Promise((resolve) => setTimeout(() => resolve("HANG"), 100)),
  ]);
  assert.equal(result, "avatar-fertig");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].method, "_applyAccessories");
  assert.match(skipped[0].error.message, /Zeitlimit/);
});

test("OutfitRenderer-Patch spielt verpasste onSuccess/onRenderSuccess-Signale nach", async () => {
  class DummyEvent {
    callbacks = new Set();
    Connect(callback) {
      this.callbacks.add(callback);
      return { Disconnect: () => this.callbacks.delete(callback) };
    }
    Fire() {
      for (const callback of [...this.callbacks]) callback();
    }
  }
  class DummyOutfitRenderer {
    currentRig = {};
    currentlyUpdating = false;
    currentlyChangingRig = false;
    hasFiredFullyRendered = false;
    onSuccess = new DummyEvent();
    onRenderSuccess = new DummyEvent();
    fireFullyRenderedIfNeeded() {
      if (!this.hasFiredFullyRendered) {
        this.hasFiredFullyRendered = true;
        this.onRenderSuccess.Fire();
      }
    }
    async prepareForThumbnail() {
      // Beide Events wurden im Produktionsfall bereits synchron gefeuert,
      // bevor der jeweilige Listener verbunden wurde.
      await new Promise((resolve) => this.onSuccess.Connect(resolve));
      this.onRenderSuccess.Fire();
      this.hasFiredFullyRendered = false;
      await new Promise((resolve) => this.onRenderSuccess.Connect(resolve));
      return true;
    }
  }

  assert.equal(patchOutfitRenderer(DummyOutfitRenderer), true);
  const result = await Promise.race([
    new DummyOutfitRenderer().prepareForThumbnail(),
    new Promise((resolve) => setTimeout(() => resolve("HANG"), 100)),
  ]);
  assert.equal(result, true);
  assert.equal(patchOutfitRenderer(DummyOutfitRenderer), false, "zweiter Patch muss ein No-op sein");
});

test("Patches ignorieren Klassen ohne passende Methoden", () => {
  assert.deepEqual(patchAnimatorWrapper(null), []);
  assert.deepEqual(patchAnimatorWrapper(class Foo {}), []);
  assert.equal(patchHumanoidDescriptionApply(class Bar {}), false);
  assert.equal(patchOutfitRenderer(class Baz {}), false);
});
