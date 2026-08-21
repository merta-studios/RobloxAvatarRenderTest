import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Integrationstest gegen die ECHTE roavatar-renderer-Mechanik:
 * RBXRenderer._addRenderDesc + RBXRendererScene + Instance-Baum.
 *
 * Reproduziert den zweiten Produktionsfehler (nach dem Event-Race-Patch):
 * `onRenderSuccess` feuert NIE, weil ein Render-Descriptor dauerhaft pending
 * bleibt. In 1.6.2 hängt `_addRenderDesc` an `compileResults(...).then(...)`
 * OHNE catch – ein Reject/Throw/Hänger dort lässt den Descriptor für immer
 * „weder compiled noch failed“ bleiben (leeres Fortschrittssignal `assets|`).
 *
 * Geprüft wird:
 *  1. patchRenderDescCompile macht aus Reject/Hänger ein „failed“
 *     (failedRenderDesc.Fire, desc.failed, isRenderingMesh sauber).
 *  2. Die Thumbnail-Zustandsmaschine beendet den Render trotzdem mit einem
 *     Degraded-Ergebnis, indem sie NUR die blockierende Instanz über die
 *     echte RBXRenderer.removeInstance aus der Szene nimmt.
 */

// --- Browser-Shim für Node (wie in integration-hang.test.js) ---
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }),
  querySelector: () => null,
  querySelectorAll: () => [],
};
(0, eval)(readFileSync(new URL("../public/draco_decoder.js", import.meta.url), "utf8"));

const { Instance, Property, DataType, RBXRenderer, RBXRendererScene, RegisterWrappers } = await import("roavatar-renderer");
const { patchRenderDescCompile } = await import("../src/library-guards.js");
const { createThumbnailPipeline } = await import("../src/thumbnail-pipeline.js");

// Wie in integration-hang.test.js: erst Wrapper registrieren, dann Instanzen bauen.
RegisterWrappers();

// _addRenderDesc/removeInstance steigen ohne initialisierten Renderer sofort
// aus. Für die reine Descriptor-Buchhaltung genügt ein Sentinel.
RBXRenderer.renderer = RBXRenderer.renderer || { renderLists: { dispose() {} } };

function makeFakeDescClass(compileImpl) {
  return class FakeRenderDesc {
    constructor(renderScene) {
      this.renderScene = renderScene;
      this.instance = null;
      this.compiled = false;
      this.failed = false;
      this.results = null;
    }
    fromInstance(instance) { this.instance = instance; }
    needsRegeneration() { return false; }
    isSame() { return true; }
    transferFrom() {}
    updateResults() {}
    dispose() {}
    async compileResults(...args) { return compileImpl(this, args); }
  };
}

function makePart(name) {
  const part = new Instance("MeshPart");
  // Die echten ObjectDesc.fromInstance/fromMeshPart lesen diese Properties
  // streng (Property() wirft ohne sie) – der Compile-Erfolgspfad der
  // Bibliothek rekurriert über RBXRenderer.addInstance in sie hinein.
  part.addProperty(new Property("Name", DataType.String), "MeshPart");
  part.addProperty(new Property("MeshId", DataType.String), "MeshPart");
  part.setProperty("Name", name);
  part.setProperty("MeshId", "");
  return part;
}

function makeRigWithParts(names) {
  const rig = new Instance("Model");
  const parts = names.map((name) => {
    const part = makePart(name);
    part.setParent(rig);
    return part;
  });
  return { rig, parts };
}

test("echter _addRenderDesc: compileResults-Reject wird zu failed + failedRenderDesc (statt ewig pending)", async () => {
  const failures = [];
  assert.equal(patchRenderDescCompile(RBXRenderer, {
    compileDeadlineMs: 2_000,
    onFailed: (info) => failures.push(info),
  }), true);

  const scene = new RBXRendererScene();
  const failedEvents = [];
  scene.failedRenderDesc.Connect((instance) => failedEvents.push(instance));
  const compiledEvents = [];
  scene.compiledRenderDesc.Connect((instance) => compiledEvents.push(instance));

  const broken = new Instance("MeshPart");
  const DescClass = makeFakeDescClass(() => { throw new Error("Textur-Decoding fehlgeschlagen"); });
  scene.addedInstances.push(broken); // addInstance tut dasselbe, bevor es _addRenderDesc ruft
  RBXRenderer._addRenderDesc(broken, {}, DescClass, scene);

  // Die Bibliothek selbst markiert den Descriptor als failed, sobald die
  // Guard-Response ankommt – ganz ohne unseren Code im .then-Pfad.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const desc = scene.renderDescs.get(broken);
  assert.equal(desc.failed, true, "desc.failed muss gesetzt sein (areInstancesCompiled blockiert sonst weiter)");
  assert.equal(scene.isRenderingMesh.get(broken), false, "isRenderingMesh muss sauber zurückgesetzt sein");
  assert.deepEqual(failedEvents, [broken], "failedRenderDesc feuert → onRenderError/Diagnose möglich");
  assert.equal(compiledEvents.length, 0, "failed darf nicht als compiled gemeldet werden");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "compile-error");
  assert.equal(scene.areInstancesCompiled([broken]), false, "failed bleibt sichtbar blockiert – die Zustandsmaschine muss ihn überspringen");
  scene.destroy();
});

test("echte Szenen-Mechanik: Zustandsmaschine überspringt NUR den pending Descriptor und rendert den Rest", async () => {
  const scene = new RBXRendererScene();
  const { rig, parts } = makeRigWithParts(["Torso", "StuckAccessoryHandle", "Head"]);
  const [torso, stuck, head] = parts;

  // Erfolgspfad: In der Bibliothek setzt der zweite _addRenderDesc-Durchlauf
  // (Rekursion über RBXRenderer.addInstance) `compiled = true`. Diese Rekursion
  // braucht RegisterRenderDescs(), das nur in fullSetup läuft und nicht
  // exportiert ist – der Test emuliert deshalb nur diesen einen Schreibzugriff
  // und prüft alles Übrige (addedInstances/renderDescs/isRenderingMesh/
  // removeInstance) an der ECHTEN Szenen-Mechanik.
  const okDesc = makeFakeDescClass(async (desc) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    desc.compiled = true;
    return [];
  });
  // Wichtig: Dieser Descriptor hängt FÜR IMMER – der Produktionsfall.
  const stuckDesc = makeFakeDescClass(() => new Promise(() => {}));

  // addInstance wie RBXRenderer.addInstance (addedInstances-Buchhaltung +
  // _addRenderDesc), aber mit unseren Desc-Klassen – die echten Desc-Klassen
  // sind nicht exportiert und RegisterRenderDescs() läuft nur in fullSetup.
  const descClassFor = new Map([[torso, okDesc], [stuck, stuckDesc], [head, okDesc]]);
  const addInstance = (instance) => {
    const DescClass = descClassFor.get(instance);
    if (DescClass) {
      if (!scene.addedInstances.includes(instance)) scene.addedInstances.push(instance);
      RBXRenderer._addRenderDesc(instance, {}, DescClass, scene);
    }
    for (const child of instance.GetChildren()) addInstance(child);
  };

  const outfitRenderer = {
    currentRig: rig,
    currentlyUpdating: false,
    currentlyChangingRig: false,
    hasNewUpdate: false,
    hasFiredFullyRendered: false,
    doAddInstance: true,
    auth: {},
    renderScene: scene,
    backgroundRenderer: { hasFiredFullyRendered: true },
    outfit: { playerAvatarType: "R15", containsAssetType: () => false },
    animatorW: null,
    onSuccess: { Connect: () => ({ Disconnect() {} }) },
    onError: { Connect: () => ({ Disconnect() {} }) },
    onRenderSuccess: { Connect: () => ({ Disconnect() {} }) }, // feuert im Produktionsfall NIE
    onRenderError: { Connect: () => ({ Disconnect() {} }) },
    setMainAnimation: async () => true,
    animateOnce: () => {},
    hasAnimationSetAnimation: () => false,
  };

  const pipeline = createThumbnailPipeline({
    outfitRenderer,
    renderScene: scene,
    addInstance,
    removeInstance: (instance, renderScene) => RBXRenderer.removeInstance(instance, renderScene),
    isR6: false,
  }, {
    pollMs: 5,
    outfitDeadlineMs: 500,
    poseDeadlineMs: 40,
    compileDeadlineMs: 3_000,
    descStallMs: 40,
    totalDeadlineMs: 6_000,
  });

  const startedAt = Date.now();
  const result = await pipeline.run();
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 2_500, `kein 200-s-Stall: nach ${elapsedMs} ms fertig`);
  assert.equal(result.status, "degraded");
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].label, /MeshPart/);
  assert.equal(result.descriptors.compiled, 2, "Torso + Head bleiben kompiliert");

  // Die blockierende Instanz ist aus der echten Szenen-Buchhaltung entfernt,
  // die intakten bleiben darin.
  assert.equal(scene.addedInstances.includes(stuck), false);
  assert.equal(scene.renderDescs.has(stuck), false);
  assert.equal(scene.addedInstances.includes(torso), true);
  assert.equal(scene.addedInstances.includes(head), true);
  assert.equal(scene.areInstancesCompiled(rig.GetDescendants()), true, "nach dem Skip ist die Szene „compiled“");
  scene.destroy();
});
