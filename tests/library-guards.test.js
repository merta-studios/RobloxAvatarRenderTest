import test from "node:test";
import assert from "node:assert/strict";
import {
  patchAnimatorWrapper,
  patchHumanoidDescriptionApply,
  patchOutfitRenderer,
  patchOutfitRendererRigLoad,
  patchRenderDescCompile,
} from "../src/library-guards.js";

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

// ---------- Render-Compile-Guard (patchRenderDescCompile) ----------

function makeDescClass(compileImpl) {
  return class FakeRenderDesc {
    constructor(renderScene) {
      this.renderScene = renderScene;
      this.instance = null;
    }
    fromInstance(instance) { this.instance = instance; }
    async compileResults(...args) { return compileImpl(this, args); }
  };
}

function makeFakeEventForGuards() {
  const event = {
    fired: [],
    callbacks: new Set(),
    Connect(callback) {
      event.callbacks.add(callback);
      return { Disconnect: () => event.callbacks.delete(callback) };
    },
    Fire(...args) {
      event.fired.push(args);
      for (const callback of [...event.callbacks]) callback(...args);
    },
  };
  return event;
}

test("patchRenderDescCompile: Rejection in compileResults wird zu „failed“ (Response) statt ewig pending", async () => {
  const addRenderDescCalls = [];
  const failures = [];
  const FakeRBXRenderer = {
    _addRenderDesc: (...args) => { addRenderDescCalls.push(args); },
  };
  assert.equal(patchRenderDescCompile(FakeRBXRenderer, {
    compileDeadlineMs: 500,
    onFailed: (info) => failures.push(info),
  }), true);

  const DescClass = makeDescClass(() => { throw new Error("Textur-Decoding fehlgeschlagen"); });
  const instance = { className: "MeshPart", GetFullName: () => "Rig.Accessory.Handle" };
  FakeRBXRenderer._addRenderDesc(instance, {}, DescClass, {});
  assert.equal(addRenderDescCalls.length, 1, "das originale _addRenderDesc läuft weiter");

  const desc = new DescClass({});
  desc.instance = instance;
  const result = await desc.compileResults();
  assert.ok(result instanceof Response, "Fehler müssen als Response ankommen (Bibliothek markiert desc.failed + failedRenderDesc.Fire)");
  assert.equal(result.status, 502);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "compile-error");
  assert.equal(failures[0].label, "Rig.Accessory.Handle");
});

test("patchRenderDescCompile: hängendes compileResults wird per Deadline zu „failed“", async () => {
  const failures = [];
  const stoppedLabels = [];
  const FakeRBXRenderer = { _addRenderDesc: () => {} };
  patchRenderDescCompile(FakeRBXRenderer, {
    compileDeadlineMs: 30,
    onFailed: (info) => failures.push(info),
    stopLoadingLabel: (label) => stoppedLabels.push(label),
  });
  const DescClass = makeDescClass(() => new Promise(() => {})); // hängt für immer
  const instance = { className: "MeshPart", GetFullName: () => "Rig.Handle" };
  FakeRBXRenderer._addRenderDesc(instance, {}, DescClass, {});

  const desc = new DescClass({});
  desc.instance = instance;
  const startedAt = Date.now();
  const result = await desc.compileResults();
  assert.ok(Date.now() - startedAt < 1_000, "Deadline muss schnell feuern");
  assert.ok(result instanceof Response);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "compile-deadline");
  assert.deepEqual(stoppedLabels, ["Rig.Handle"], "das hängengebliebene Loading-Label wird abgeräumt");
});

test("patchRenderDescCompile: erfolgreiche Kompilierung bleibt unverändert, Patch ist idempotent", async () => {
  const FakeRBXRenderer = { _addRenderDesc: () => {} };
  assert.equal(patchRenderDescCompile(FakeRBXRenderer, { compileDeadlineMs: 500 }), true);
  const DescClass = makeDescClass(function fakeCompile() { return [{ name: "three-mesh" }]; });
  FakeRBXRenderer._addRenderDesc({}, {}, DescClass, {});
  const wrappedOnce = DescClass.prototype.compileResults;
  FakeRBXRenderer._addRenderDesc({}, {}, DescClass, {});
  assert.equal(DescClass.prototype.compileResults, wrappedOnce, "kein doppeltes Wrapping");
  assert.equal(patchRenderDescCompile(FakeRBXRenderer, { compileDeadlineMs: 500 }), false, "zweiter Patch ist ein No-op");

  const desc = new DescClass({});
  const result = await desc.compileResults();
  assert.deepEqual(result, [{ name: "three-mesh" }], "Erfolg wird unverändert durchgereicht");
});

// ---------- Rig-Lade-Guard (patchOutfitRendererRigLoad) ----------

function makeRigLoadClass() {
  return class FakeOutfitRenderer {
    constructor() {
      this.currentlyChangingRig = false;
      this.currentRig = undefined;
      this.currentRigType = "R15";
      this.doAddInstance = true;
      this.auth = {};
      this.renderScene = {};
      this.onError = makeFakeEventForGuards();
    }
  };
}

function makeRbxLike(rigInstance) {
  const dataModel = {
    GetChildren: () => [rigInstance],
    Destroy: () => {},
  };
  return { generateTree: () => dataModel };
}

test("patchOutfitRendererRigLoad: erfolgreicher Rig-Aufbau bleibt unverändert", async () => {
  const addInstanceCalls = [];
  const Class = makeRigLoadClass();
  const rigInstance = { name: "Rig", setParent: () => {}, Destroy: () => {} };
  assert.equal(patchOutfitRendererRigLoad(Class, {
    getRBX: async () => makeRbxLike(rigInstance),
    addInstance: (...args) => addInstanceCalls.push(args),
  }), true);

  const renderer = new Class();
  const result = await renderer._setRigTo("R15");
  assert.equal(result, rigInstance);
  assert.equal(renderer.currentRig, rigInstance);
  assert.equal(renderer.currentlyChangingRig, false);
  assert.equal(addInstanceCalls.length, 1, "doAddInstance=true → Instanz wird zur Szene hinzugefügt");
  assert.equal(renderer.onError.fired.length, 0);
});

test("patchOutfitRendererRigLoad: Throw in generateTree/GetChildren wird zu onError(„rig“) statt Hänger", async () => {
  const skipped = [];
  const Class = makeRigLoadClass();
  patchOutfitRendererRigLoad(Class, {
    getRBX: async () => ({ generateTree: () => { throw new Error("generateTree: inkonsistenter Baum"); } }),
    onSkipped: (info) => skipped.push(info),
  });
  const renderer = new Class();
  // Wie in _updateOutfit: Promise.all darf niemals hängen bleiben.
  const result = await Promise.race([
    Promise.all([renderer._setRigTo("R15")]),
    new Promise((resolve) => setTimeout(() => resolve("HANG"), 200)),
  ]);
  assert.notEqual(result, "HANG", "ohne den Patch bleibt dieses Promise für immer pending");
  assert.deepEqual(renderer.onError.fired, [["rig"]], "konkrete Fehlerstufe statt stilles Hängen");
  assert.equal(renderer.currentlyChangingRig, false);
  assert.equal(skipped[0].method, "_setRigTo.generateTree");
});

test("patchOutfitRendererRigLoad: GetRBX-Rejection und undefined-Ergebnis landen beide bei onError(„rig“)", async () => {
  const Rejected = makeRigLoadClass();
  patchOutfitRendererRigLoad(Rejected, { getRBX: async () => { throw new Error("RBXM korrupt"); } });
  const rejectedRenderer = new Rejected();
  await Promise.all([rejectedRenderer._setRigTo("R15")]);
  assert.deepEqual(rejectedRenderer.onError.fired, [["rig"]]);
  assert.equal(rejectedRenderer.currentlyChangingRig, false);

  const Undefined = makeRigLoadClass();
  patchOutfitRendererRigLoad(Undefined, { getRBX: async () => undefined });
  const undefinedRenderer = new Undefined();
  await Promise.all([undefinedRenderer._setRigTo("R6")]);
  assert.deepEqual(undefinedRenderer.onError.fired, [["rig"]]);
});

test("patchOutfitRendererRigLoad: bereits laufender Rig-Wechsel löst auf statt zu hängen", async () => {
  const Class = makeRigLoadClass();
  patchOutfitRendererRigLoad(Class, { getRBX: async () => undefined });
  const renderer = new Class();
  renderer.currentlyChangingRig = true;
  const result = await Promise.race([
    renderer._setRigTo("R15"),
    new Promise((resolve) => setTimeout(() => resolve("HANG"), 100)),
  ]);
  assert.notEqual(result, "HANG", "das Original-Promise bleibt hier für immer pending");
  assert.equal(result, undefined);
});

test("patchOutfitRendererRigLoad ignoriert unvollständige Optionen/Klassen", () => {
  assert.equal(patchOutfitRendererRigLoad(null, {}), false);
  assert.equal(patchOutfitRendererRigLoad(class Foo {}, {}), false);
  assert.equal(patchOutfitRendererRigLoad(class Bar {}, { getRBX: "keine Funktion" }), false);
});
