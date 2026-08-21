import test from "node:test";
import assert from "node:assert/strict";
import { createThumbnailPipeline, THUMBNAIL_STAGES } from "../src/thumbnail-pipeline.js";

/**
 * Regressionstests für die deterministische Thumbnail-Zustandsmaschine –
 * den Nachfolger des blinden Wartens auf `OutfitRenderer.prepareForThumbnail()`.
 *
 * Produktionsfall: `onRenderSuccess` feuert NIE, weil ein Render-Descriptor
 * dauerhaft pending bleibt (`_addRenderDesc` hängt an compileResults ohne
 * catch). Die Fakes spiegeln exakt diese Semantik der Bibliothek:
 * `areInstancesCompiled` liefert false, solange auch nur ein Descriptor
 * pending ist, und niemand feuert `onRenderSuccess`.
 */

// ---------- Fakes mit der Semantik von roavatar-renderer 1.6.2 ----------

function makeFakeEvent() {
  const event = {
    callbacks: new Set(),
    connections: [],
    Connect(callback) {
      const connection = {
        disconnected: false,
        Disconnect() {
          connection.disconnected = true;
          event.callbacks.delete(callback);
        },
      };
      event.callbacks.add(callback);
      event.connections.push(connection);
      return connection;
    },
    Fire(...args) {
      for (const callback of [...event.callbacks]) callback(...args);
    },
  };
  return event;
}

function makeInstance(className, name, children = []) {
  const instance = {
    className,
    props: { Name: name },
    children,
    parent: null,
    destroyed: false,
    PropOrDefault(key, fallback) { return key in instance.props ? instance.props[key] : fallback; },
    GetFullName() {
      const parts = [];
      for (let node = instance; node; node = node.parent) parts.unshift(node.PropOrDefault("Name", "?"));
      return parts.join(".");
    },
    GetChildren() { return [...instance.children]; },
    GetDescendants() {
      const out = [];
      const walk = (node) => { for (const child of node.children) { out.push(child); walk(child); } };
      walk(instance);
      return out;
    },
    setParent(parent) { instance.parent = parent; },
    Destroy() { instance.destroyed = true; },
  };
  for (const child of children) child.parent = instance;
  return instance;
}

function makeFakeRenderScene() {
  const scene = {
    addedInstances: [],
    renderDescs: new Map(),
    isRenderingMesh: new Map(),
    compiledRenderDesc: makeFakeEvent(),
    failedRenderDesc: makeFakeEvent(),
  };
  scene.areInstancesCompiled = (instances) => {
    for (const instance of instances) {
      if (!scene.addedInstances.includes(instance)) continue;
      const renderDesc = scene.renderDescs.get(instance);
      if (!renderDesc || !renderDesc.compiled || scene.isRenderingMesh.get(instance)) return false;
    }
    return true;
  };
  return scene;
}

/** Bildet RBXRenderer.addInstance/removeInstance auf den Szenen-Buchhaltungen nach. */
function makeFakeRendererApi(scene, { descFor } = {}) {
  const addInstance = (instance) => {
    const desc = descFor?.(instance);
    if (desc) {
      if (!scene.addedInstances.includes(instance)) scene.addedInstances.push(instance);
      if (!scene.renderDescs.has(instance)) scene.renderDescs.set(instance, desc);
    }
    for (const child of instance.GetChildren()) addInstance(child);
  };
  const removeInstance = (instance) => {
    const index = scene.addedInstances.indexOf(instance);
    if (index >= 0) scene.addedInstances.splice(index, 1);
    scene.renderDescs.delete(instance);
    scene.isRenderingMesh.delete(instance);
    scene.compiledRenderDesc.Fire(instance);
    for (const child of instance.GetChildren()) removeInstance(child);
  };
  return { addInstance, removeInstance };
}

function makeFakeOutfitRenderer({ rig, scene, setMainAnimation, currentlyUpdating = false } = {}) {
  return {
    currentRig: rig,
    currentlyUpdating,
    currentlyChangingRig: false,
    hasNewUpdate: false,
    hasFiredFullyRendered: false,
    doAddInstance: true,
    deltaTimeMultiplier: 1,
    auth: { token: "fake" },
    renderScene: scene,
    backgroundRenderer: { hasFiredFullyRendered: true, affectSceneAppearance: true, cameraAffectsTransparency: true },
    outfit: { playerAvatarType: "R15", containsAssetType: () => false },
    animatorW: null,
    onSuccess: makeFakeEvent(),
    onError: makeFakeEvent(),
    onRenderSuccess: makeFakeEvent(),
    onRenderError: makeFakeEvent(),
    setMainAnimation: setMainAnimation || (async () => true),
    animateOnce: () => {},
    hasAnimationSetAnimation: () => false,
  };
}

const FAST_OPTIONS = {
  pollMs: 5,
  outfitDeadlineMs: 500,
  poseDeadlineMs: 60,
  compileDeadlineMs: 2_000,
  descStallMs: 40,
  totalDeadlineMs: 6_000,
};

function makeStallScenario() {
  const scene = makeFakeRenderScene();
  const partOk1 = makeInstance("MeshPart", "Torso");
  const partStuck = makeInstance("MeshPart", "StuckAccessoryHandle");
  const partOk2 = makeInstance("MeshPart", "Head");
  const rig = makeInstance("Model", "Rig", [partOk1, partStuck, partOk2]);
  const descriptors = new Map([
    [partOk1, { compiled: false, failed: false }],
    [partStuck, { compiled: false, failed: false }], // bleibt FÜR IMMER pending
    [partOk2, { compiled: false, failed: false }],
  ]);
  const rendererApi = makeFakeRendererApi(scene, {
    descFor: (instance) => {
      const desc = descriptors.get(instance);
      if (!desc) return null;
      // Die ok-Parts „kompilieren“ kurz nach addInstance; das Stuck-Part nie.
      if (instance !== partStuck) setTimeout(() => { desc.compiled = true; scene.compiledRenderDesc.Fire(instance); }, 10);
      return desc;
    },
  });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene });
  return { scene, rig, partStuck, outfitRenderer, rendererApi };
}

function makeEnv(scenario, overrides = {}) {
  return {
    outfitRenderer: scenario.outfitRenderer,
    renderScene: scenario.scene,
    addInstance: scenario.rendererApi.addInstance,
    removeInstance: scenario.rendererApi.removeInstance,
    isR6: false,
    ...overrides,
  };
}

// ---------- Tests ----------

test("Produktions-Stall: onRenderSuccess feuert nie (Descriptor pending) – Pipeline rendert trotzdem degraded weiter", async () => {
  const scenario = makeStallScenario();
  const pipeline = createThumbnailPipeline(makeEnv(scenario), FAST_OPTIONS);
  const startedAt = Date.now();
  const result = await pipeline.run();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, "degraded", "statt 200-s-Fehler muss ein nutzbarer Degraded-Render herauskommen");
  assert.ok(elapsedMs < 2_000, `Pipeline muss schnell abschließen, brauchte aber ${elapsedMs} ms`);
  assert.equal(result.skipped.length, 1, "genau das blockierende Teil wird übersprungen");
  assert.match(result.skipped[0].label, /MeshPart:StuckAccessoryHandle/);
  assert.equal(result.skipped[0].reason, "render-desc-pending");
  assert.equal(result.descriptors.compiled, 2, "die intakten Descriptors bleiben kompiliert");

  // Die Zustandsmaschine hat NIE auf onRenderSuccess/onSuccess gewartet –
  // der Event-Pfad der Bibliothek war und ist unzuverlässig.
  assert.equal(scenario.outfitRenderer.onRenderSuccess.connections.length, 0);
  assert.equal(scenario.outfitRenderer.onSuccess.connections.length, 0);
});

test("defekter (failed) Render-Descriptor wird diagnostiziert und übersprungen", async () => {
  const scene = makeFakeRenderScene();
  const partOk = makeInstance("MeshPart", "Torso");
  const partBroken = makeInstance("MeshPart", "BrokenUgcHandle");
  const rig = makeInstance("Model", "Rig", [partOk, partBroken]);
  const brokenDesc = { compiled: false, failed: true }; // compileResults ist bereits gefehlt
  const okDesc = { compiled: false, failed: false };
  const rendererApi = makeFakeRendererApi(scene, {
    descFor: (instance) => {
      if (instance === partBroken) return brokenDesc;
      if (instance === partOk) {
        setTimeout(() => { okDesc.compiled = true; scene.compiledRenderDesc.Fire(instance); }, 10);
        return okDesc;
      }
      return null;
    },
  });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), FAST_OPTIONS);
  const result = await pipeline.run();

  assert.equal(result.status, "degraded");
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].label, /MeshPart:BrokenUgcHandle/);
  assert.equal(result.skipped[0].reason, "render-desc-failed", "failed-Descriptors werden als solche diagnostiziert");
});

test("normaler erfolgreicher Render bleibt unverändert (status success, keine Skips)", async () => {
  const scene = makeFakeRenderScene();
  const partA = makeInstance("MeshPart", "Torso");
  const partB = makeInstance("MeshPart", "Head");
  const rig = makeInstance("Model", "Rig", [partA, partB]);
  const descriptors = new Map([
    [partA, { compiled: false, failed: false }],
    [partB, { compiled: false, failed: false }],
  ]);
  const rendererApi = makeFakeRendererApi(scene, {
    descFor: (instance) => {
      const desc = descriptors.get(instance);
      if (!desc) return null;
      setTimeout(() => { desc.compiled = true; scene.compiledRenderDesc.Fire(instance); }, 5);
      return desc;
    },
  });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), FAST_OPTIONS);
  const result = await pipeline.run();

  assert.equal(result.status, "success");
  assert.equal(result.reason, "compiled");
  assert.equal(result.skipped.length, 0);
  assert.equal(result.descriptors.compiled, 2);
  assert.equal(result.pose.animation, "idle:0");
  // Thumbnail-Modus der Bibliothek wurde gespiegelt.
  assert.equal(outfitRenderer.doAddInstance, false);
  assert.equal(outfitRenderer.backgroundRenderer.affectSceneAppearance, false);
});

test("Pose-Timeout hält den Render nicht auf (ohne Pose weiterrendern statt hängen)", async () => {
  const scene = makeFakeRenderScene();
  const partA = makeInstance("MeshPart", "Torso");
  const rig = makeInstance("Model", "Rig", [partA]);
  const desc = { compiled: false, failed: false };
  const rendererApi = makeFakeRendererApi(scene, {
    descFor: (instance) => {
      if (instance !== partA) return null;
      setTimeout(() => { desc.compiled = true; }, 5);
      return desc;
    },
  });
  const outfitRenderer = makeFakeOutfitRenderer({
    rig,
    scene,
    setMainAnimation: () => new Promise(() => {}), // löst NIE auf
  });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), FAST_OPTIONS);
  const result = await pipeline.run();
  assert.equal(result.pose.outcome, "timeout");
  assert.equal(result.status, "success");
});

test("onError während waiting-outfit liefert die konkrete Fehlerstufe statt Timeout-Rätsel", async () => {
  const scene = makeFakeRenderScene();
  const rig = makeInstance("Model", "Rig", []);
  const rendererApi = makeFakeRendererApi(scene, { descFor: () => null });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene, currentlyUpdating: true });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), FAST_OPTIONS);
  const runPromise = pipeline.run();
  setTimeout(() => outfitRenderer.onError.Fire("humanoidDescription"), 15);
  await assert.rejects(runPromise, /Fehlerstufe: humanoidDescription/);
});

test("waiting-outfit-Deadline nennt die internen Flags (currentlyUpdating & Co.)", async () => {
  const scene = makeFakeRenderScene();
  const rig = makeInstance("Model", "Rig", []);
  const rendererApi = makeFakeRendererApi(scene, { descFor: () => null });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene, currentlyUpdating: true });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), {
    ...FAST_OPTIONS,
    outfitDeadlineMs: 40,
  });
  await assert.rejects(
    pipeline.run(),
    (error) => /Instance-Tree wurde nach .* nicht fertig/.test(error.message)
      && /currentlyUpdating=true/.test(error.message)
      && /Rig vorhanden=true/.test(error.message),
  );
});

test("Gesamtzeitlimit greift auch dann, wenn sich jede Stufe „bewegt“ (flache Auffanglinie)", async () => {
  const scene = makeFakeRenderScene();
  const rig = makeInstance("Model", "Rig", []);
  const rendererApi = makeFakeRendererApi(scene, { descFor: () => null });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene, currentlyUpdating: true });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), {
    ...FAST_OPTIONS,
    totalDeadlineMs: 40,
    outfitDeadlineMs: 5_000,
  });
  await assert.rejects(pipeline.run(), /Gesamtzeitlimit von 0 s überschritten/);
});

test("Skip-Limit: viele Blockierer enden im Degraded-Render, nicht im Dauer-Skip-Loop", async () => {
  const scene = makeFakeRenderScene();
  const okPart = makeInstance("MeshPart", "Torso");
  const stuckParts = [
    makeInstance("MeshPart", "Stuck1"),
    makeInstance("MeshPart", "Stuck2"),
    makeInstance("MeshPart", "Stuck3"),
  ];
  const rig = makeInstance("Model", "Rig", [okPart, ...stuckParts]);
  const okDesc = { compiled: false, failed: false };
  const rendererApi = makeFakeRendererApi(scene, {
    descFor: (instance) => {
      if (instance === okPart) {
        setTimeout(() => { okDesc.compiled = true; }, 5);
        return okDesc;
      }
      return stuckParts.includes(instance) ? { compiled: false, failed: false } : null;
    },
  });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), {
    ...FAST_OPTIONS,
    maxSkippedInstances: 1,
  });
  const result = await pipeline.run();
  assert.equal(result.status, "degraded");
  assert.equal(result.reason, "skip-limit");
  assert.ok(result.descriptors.compiled >= 1, "der intakte Teil wird weiter gerendert");
});

test("nichts Kompilierbares übrig → konkreter Fehler statt leerem Bild", async () => {
  const scene = makeFakeRenderScene();
  const stuckOnly = makeInstance("MeshPart", "OnlyStuck");
  const rig = makeInstance("Model", "Rig", [stuckOnly]);
  const rendererApi = makeFakeRendererApi(scene, {
    descFor: (instance) => (instance === stuckOnly ? { compiled: false, failed: false } : null),
  });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), FAST_OPTIONS);
  await assert.rejects(pipeline.run(), /Kein einziger Render-Descriptor wurde kompiliert/);
});

test("Fortschrittsdiagnose zeigt den konkreten Teilschritt und pending Descriptor (nicht nur `assets|`)", async () => {
  const scenario = makeStallScenario();
  const snapshots = [];
  const stages = [];
  const pipeline = createThumbnailPipeline(makeEnv(scenario, {
    onDiagnostics: (snapshot) => {
      snapshots.push(snapshot);
      if (stages[stages.length - 1] !== snapshot.stage) stages.push(snapshot.stage);
    },
  }), FAST_OPTIONS);
  await pipeline.run();

  assert.deepEqual(stages, [
    THUMBNAIL_STAGES.WAITING_OUTFIT,
    THUMBNAIL_STAGES.POSING,
    THUMBNAIL_STAGES.WAITING_RENDER_COMPILE,
    THUMBNAIL_STAGES.COMPLETE,
  ], "die Stufenfolge muss sichtbar sein");

  const stallSnapshots = snapshots.filter((s) => s.stage === THUMBNAIL_STAGES.WAITING_RENDER_COMPILE);
  assert.ok(stallSnapshots.length > 0);
  const withPending = stallSnapshots.find((s) => s.descriptors.pending >= 1);
  assert.ok(withPending, "während des Stalls muss der pending-Descriptor sichtbar sein");
  assert.ok(
    withPending.pendingInstances.some((label) => label.includes("StuckAccessoryHandle")),
    "der konkrete pending Descriptor (Klasse/Name) muss in der Diagnose stehen",
  );
  assert.equal(typeof withPending.rigDescendantCount, "number");
  assert.equal(withPending.hasCurrentRig, true);
});

test("keine Timer-, Listener- oder Promise-Leaks nach Erfolg", async () => {
  const scene = makeFakeRenderScene();
  const partA = makeInstance("MeshPart", "Torso");
  const rig = makeInstance("Model", "Rig", [partA]);
  const desc = { compiled: false, failed: false };
  const rendererApi = makeFakeRendererApi(scene, {
    descFor: (instance) => {
      if (instance !== partA) return null;
      setTimeout(() => { desc.compiled = true; }, 5);
      return desc;
    },
  });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene });
  const intervals = { opened: 0, closed: 0 };
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), {
    ...FAST_OPTIONS,
    setInterval: (fn, ms) => { intervals.opened += 1; return setInterval(fn, ms); },
    clearInterval: (id) => { intervals.closed += 1; clearInterval(id); },
  });
  await pipeline.run();
  assert.equal(intervals.opened, 1, "genau ein Tick-Timer");
  assert.equal(intervals.closed, 1, "Tick-Timer wird nach Erfolg abgeräumt");
  for (const event of [outfitRenderer.onError, outfitRenderer.onSuccess, outfitRenderer.onRenderError, outfitRenderer.onRenderSuccess]) {
    for (const connection of event.connections) {
      assert.equal(connection.disconnected, true, "alle Event-Verbindungen müssen getrennt sein");
    }
  }
});

test("keine Timer-/Listener-Leaks nach Fehler (onError rig)", async () => {
  const scene = makeFakeRenderScene();
  const rig = makeInstance("Model", "Rig", []);
  const rendererApi = makeFakeRendererApi(scene, { descFor: () => null });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene, currentlyUpdating: true });
  const intervals = { opened: 0, closed: 0 };
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), {
    ...FAST_OPTIONS,
    setInterval: (fn, ms) => { intervals.opened += 1; return setInterval(fn, ms); },
    clearInterval: (id) => { intervals.closed += 1; clearInterval(id); },
  });
  const runPromise = pipeline.run();
  setTimeout(() => outfitRenderer.onError.Fire("rig"), 12);
  await assert.rejects(runPromise, /Fehlerstufe: rig/);
  assert.equal(intervals.opened, 1);
  assert.equal(intervals.closed, 1, "Tick-Timer wird auch nach Fehler abgeräumt");
  for (const connection of outfitRenderer.onError.connections) {
    assert.equal(connection.disconnected, true);
  }
});

test("dispose() beendet einen noch laufenden Vorgang sauber (keine späten Mutationen)", async () => {
  const scene = makeFakeRenderScene();
  const rig = makeInstance("Model", "Rig", []);
  const rendererApi = makeFakeRendererApi(scene, { descFor: () => null });
  const outfitRenderer = makeFakeOutfitRenderer({ rig, scene, currentlyUpdating: true });
  const pipeline = createThumbnailPipeline(makeEnv({ scene, outfitRenderer, rendererApi }), FAST_OPTIONS);
  const runPromise = pipeline.run();
  pipeline.dispose();
  await assert.rejects(runPromise, /abgebrochen/);
  // dispose nach dem Ende ist ein No-op und wirft nicht.
  pipeline.dispose();
  assert.equal(pipeline.snapshot().stage !== undefined, true);
});
