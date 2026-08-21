/**
 * Deterministische, begrenzte Thumbnail-Vorbereitung.
 *
 * Warum nicht einfach `OutfitRenderer.prepareForThumbnail()`?
 * `_prepareForThumbnail` wartet an zwei UNBEGRENZTEN Event-Punkten:
 *   1. `onSuccess` (Instance-Tree fertig),
 *   2. `onRenderSuccess` nach `RBXRenderer.addInstance(...)`.
 * `onRenderSuccess` feuert nur, wenn `renderScene.areInstancesCompiled(...)`
 * true wird. In roavatar-renderer 1.6.2 hängt die Compile-Kette in
 * `RBXRenderer._addRenderDesc` an `newDesc.compileResults(...).then(...)` OHNE
 * `.catch`: rejected oder hängt `compileResults` (z. B. Throw beim Textur-/
 * Mesh-Verarbeiten), bleibt der Descriptor für immer „weder compiled noch
 * failed“ – `onRenderSuccess` kommt NIE, der Event-Replay-Patch kann nichts
 * nachspielen, und der Render hängt still in Phase „assets“ mit leerem
 * Fortschrittssignal (`assets|`), bis der Watchdog abbricht.
 *
 * Diese Zustandsmaschine wartet deshalb NICHT auf die Events der Bibliothek,
 * sondern pollt überprüfbaren Objektzustand und räumt blockierende
 * Render-Descriptors selbst aus dem Weg:
 *
 *   waiting-outfit ──► posing ──► waiting-render-compile ──► complete
 *        │                             │
 *        │ onError/Deadline            │ kein Compile-Fortschritt:
 *        ▼                             ▼ blockierende Instanz identifizieren,
 *     Fehler                        removeInstance() (nur die defekte Instanz),
 *                                   Rest-Avatar weiter rendern (Degraded-Mode)
 *
 * Jede Stufe hat eine eigene Deadline; zusätzlich gilt ein flaches
 * Gesamtlimit. Ein einziges defektes Accessoire/Mesh/Textur/Animation kann
 * den Render dadurch nicht mehr 200+ Sekunden blockieren.
 *
 * Reines Modul ohne Browser-/Bibliotheks-Abhängigkeiten (alles wird über
 * `env` injiziert), damit es in Node getestet werden kann (`node --test`).
 */

export const THUMBNAIL_STAGES = Object.freeze({
  WAITING_OUTFIT: "waiting-outfit",
  POSING: "posing",
  WAITING_RENDER_COMPILE: "waiting-render-compile",
  COMPLETE: "complete",
});

/** Beschreibt eine Instanz für Logs/Diagnose, ohne zu werfen. */
function describeInstance(instance) {
  try {
    const className = instance?.className || "?";
    let name = "?";
    try { name = instance.PropOrDefault ? instance.PropOrDefault("Name", "?") : "?"; } catch { /* kein Name verfügbar */ }
    let path = "";
    try { path = instance.GetFullName ? ` (${instance.GetFullName()})` : ""; } catch { /* Pfad nicht verfügbar */ }
    return `${className}:${name}${path}`;
  } catch {
    return "<unbekannte Instanz>";
  }
}

/**
 * @typedef {object} PipelineEnv
 * @property {object} outfitRenderer OutfitRenderer-Instanz (oder strukturkompatibler Fake)
 * @property {object} renderScene RBXRendererScene (oder Fake): addedInstances, renderDescs, isRenderingMesh, areInstancesCompiled
 * @property {(instance: object, auth: unknown, renderScene: object) => void} addInstance z. B. RBXRenderer.addInstance
 * @property {(instance: object, renderScene: object) => void} removeInstance z. B. RBXRenderer.removeInstance
 * @property {boolean} isR6 true bei AvatarType.R6 (steuert Pose-Auswahl)
 * @property {(snapshot: object) => void} [onDiagnostics] erhält bei jedem Tick den aktuellen Snapshot (für window.__renderState)
 */

/**
 * Erzeugt die Zustandsmaschine.
 *
 * @param {PipelineEnv} env
 * @param {{
 *   pollMs?: number,
 *   outfitDeadlineMs?: number,
 *   poseDeadlineMs?: number,
 *   compileDeadlineMs?: number,
 *   descStallMs?: number,
 *   maxSkippedInstances?: number,
 *   totalDeadlineMs?: number,
 *   now?: () => number,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 * }} [options]
 */
export function createThumbnailPipeline(env, options = {}) {
  const {
    pollMs = 500,
    outfitDeadlineMs = 210_000,
    poseDeadlineMs = 30_000,
    compileDeadlineMs = 120_000,
    descStallMs = 30_000,
    maxSkippedInstances = 12,
    totalDeadlineMs = 395_000,
    now = () => Date.now(),
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
  } = options;
  const { outfitRenderer, renderScene, addInstance, removeInstance, isR6, onDiagnostics = () => {} } = env;

  const ctx = {
    stage: THUMBNAIL_STAGES.WAITING_OUTFIT,
    stageStartedAt: now(),
    startedAt: now(),
    finished: false,
    resolvedValue: null,
    rejectedError: null,
    timer: null,
    connections: [],
    assetFailure: null,
    // Pose-Stufe
    poseAnimation: null,
    poseOutcome: null, // "success" | "not-played" | "timeout" | "error"
    poseSettled: false,
    posePromise: null,
    // Compile-Stufe
    rig: null,
    addedToScene: false,
    lastCompiledCount: -1,
    lastSkippedCount: 0,
    lastProgressAt: now(),
    lastScan: null,
    skipped: [], // { label, reason, atMs }
  };

  let resolveRun;
  let rejectRun;

  function connect(event, callback) {
    if (!event || typeof event.Connect !== "function") return;
    try {
      const connection = event.Connect(callback);
      if (connection && typeof connection.Disconnect === "function") ctx.connections.push(connection);
    } catch { /* Event-API weicht ab – Polling bleibt als Auffangnetz. */ }
  }

  function disconnectAll() {
    for (const connection of ctx.connections.splice(0)) {
      try { connection.Disconnect(); } catch { /* bereits getrennt */ }
    }
  }

  /** Klassifiziert die Render-Descriptors aller Rig-Nachkommen. */
  function scanDescriptors() {
    const stats = {
      descendants: [],
      total: 0,
      compiled: 0,
      failed: 0,
      pending: 0,
      pendingInstances: [],
      failedInstances: [],
    };
    let descendants = [];
    try {
      descendants = ctx.rig?.GetDescendants?.() || [];
    } catch {
      descendants = [];
    }
    stats.descendants = descendants;
    const added = renderScene.addedInstances;
    const byInstance = renderScene.renderDescs;
    const rendering = renderScene.isRenderingMesh;
    for (const instance of descendants) {
      try {
        if (!added.includes(instance)) continue; // nicht Teil der Szene – ignoriert die Bibliothek ebenfalls
        stats.total += 1;
        const desc = byInstance.get(instance);
        const stillRendering = Boolean(rendering.get(instance));
        if (desc && desc.failed) {
          stats.failed += 1;
          stats.failedInstances.push(instance);
        } else if (desc && desc.compiled && !stillRendering) {
          stats.compiled += 1;
        } else {
          stats.pending += 1;
          stats.pendingInstances.push(instance);
        }
      } catch { /* einzelne Instanz nicht prüfbar – zählt als pending */ stats.pending += 1; stats.pendingInstances.push(instance); }
    }
    return stats;
  }

  /** Wählt die oberste blockierende Instanz (Nachkommen werden beim Entfernen mit abgeräumt). */
  function pickStuckInstance(stats) {
    const stuck = [...stats.pendingInstances, ...stats.failedInstances];
    if (stuck.length === 0) return null;
    const stuckSet = new Set(stuck);
    for (const instance of stuck) {
      let ancestor = null;
      try { ancestor = instance.parent; } catch { ancestor = null; }
      let hasStuckAncestor = false;
      for (let depth = 0; ancestor && depth < 64; depth += 1) {
        if (stuckSet.has(ancestor)) { hasStuckAncestor = true; break; }
        try { ancestor = ancestor.parent; } catch { break; }
      }
      if (!hasStuckAncestor) return instance;
    }
    return stuck[0];
  }

  function skipInstance(instance, reason) {
    const label = describeInstance(instance);
    try {
      removeInstance(instance, renderScene);
    } catch { /* Hauptsache der Descriptor blockiert nicht weiter. */ }
    ctx.skipped.push({ label, reason, atMs: now() - ctx.startedAt });
    ctx.lastProgressAt = now();
  }

  function emitDiagnostics() {
    try { onDiagnostics(snapshot()); } catch { /* Diagnose darf den Render nie gefährden. */ }
  }

  function settleResolve(value) {
    if (ctx.finished) return;
    ctx.finished = true;
    ctx.stage = THUMBNAIL_STAGES.COMPLETE;
    ctx.resolvedValue = value;
    if (ctx.timer != null) { clearIntervalFn(ctx.timer); ctx.timer = null; }
    disconnectAll();
    emitDiagnostics();
    resolveRun(value);
  }

  function settleReject(message) {
    if (ctx.finished) return;
    ctx.finished = true;
    ctx.rejectedError = new Error(message);
    if (ctx.timer != null) { clearIntervalFn(ctx.timer); ctx.timer = null; }
    disconnectAll();
    emitDiagnostics();
    rejectRun(ctx.rejectedError);
  }

  /** Aktueller internes Zustand – für window.__renderState und Fortschrittssignaturen. */
  function snapshot() {
    const rig = ctx.rig || outfitRenderer?.currentRig;
    let descendantCount = 0;
    try { descendantCount = rig ? rig.GetDescendants().length : 0; } catch { descendantCount = -1; }
    const scan = ctx.lastScan || { total: 0, compiled: 0, failed: 0, pending: 0, pendingInstances: [], failedInstances: [] };
    const pendingLabels = [...scan.pendingInstances, ...scan.failedInstances]
      .slice(-6)
      .map(describeInstance);
    return {
      stage: ctx.stage,
      stageElapsedMs: now() - ctx.stageStartedAt,
      totalElapsedMs: now() - ctx.startedAt,
      hasCurrentRig: Boolean(rig),
      currentlyUpdating: Boolean(outfitRenderer?.currentlyUpdating),
      currentlyChangingRig: Boolean(outfitRenderer?.currentlyChangingRig),
      hasNewUpdate: Boolean(outfitRenderer?.hasNewUpdate),
      hasFiredFullyRendered: Boolean(outfitRenderer?.hasFiredFullyRendered),
      rigDescendantCount: descendantCount,
      descriptors: {
        total: scan.total,
        compiled: scan.compiled,
        pending: scan.pending,
        failed: scan.failed,
      },
      pendingInstances: pendingLabels,
      skippedInstances: ctx.skipped.map((entry) => entry.label),
      pose: {
        animation: ctx.poseAnimation,
        outcome: ctx.poseOutcome,
        settled: ctx.poseSettled,
      },
    };
  }

  function choosePoseAnimation() {
    const outfit = outfitRenderer?.outfit;
    try {
      if (outfit?.containsAssetType?.("Gear")) return "toolnone";
    } catch { /* enthält keine Gear-Prüfung */ }
    try {
      if (!isR6 && outfitRenderer?.hasAnimationSetAnimation?.("pose")) return "pose";
    } catch { /* kein Pose-Set */ }
    return "idle:0";
  }

  function enterPosingStage() {
    ctx.stage = THUMBNAIL_STAGES.POSING;
    ctx.stageStartedAt = now();
    ctx.poseAnimation = choosePoseAnimation();
    // Begrenzt über die Stufen-Deadline im Tick – kein eigener Timer.
    ctx.posePromise = Promise.resolve()
      .then(() => outfitRenderer.setMainAnimation(ctx.poseAnimation))
      .then((played) => {
        ctx.poseSettled = true;
        ctx.poseOutcome = played === true ? "success" : "not-played";
        return played;
      })
      .catch(() => {
        ctx.poseSettled = true;
        ctx.poseOutcome = "error";
        return false;
      });
  }

  /** Spiegelt die Pose-/Frame-Logik aus _prepareForThumbnail, aber fehlerfest. */
  function applyPoseFrames() {
    try { outfitRenderer.animateOnce(0); } catch { /* Pose-Schritt übersprungen */ }
    try {
      if (!isR6 && outfitRenderer?.animatorW?.data?.currentAnimation === "idle") {
        const length = outfitRenderer.animatorW.data.currentAnimationTrack?.length || 0;
        outfitRenderer.animateOnce(length / 2);
      }
    } catch { /* Halbzeit-Frame ist optional */ }
  }

  function enterCompileStage() {
    ctx.stage = THUMBNAIL_STAGES.WAITING_RENDER_COMPILE;
    ctx.stageStartedAt = now();
    ctx.lastProgressAt = now();
    ctx.rig = outfitRenderer?.currentRig;
  }

  function finishFromCompileStage(reason) {
    const scan = scanDescriptors();
    ctx.lastScan = scan;
    if (scan.compiled === 0) {
      // Nichts Renderbares übrig (z. B. ausschließlich blockierende Instanzen
      // übersprungen): ein leeres Bild ist kein „nutzbarer Degraded-Render“.
      settleReject(
        `Kein einziger Render-Descriptor wurde kompiliert (${ctx.skipped.length} Instanz(en) übersprungen: `
        + `${ctx.skipped.slice(0, 6).map((entry) => entry.label).join(", ") || "–"}). Der Avatar kann nicht dargestellt werden.`,
      );
      return;
    }
    const degraded = ctx.skipped.length > 0 || reason !== "compiled";
    settleResolve({
      status: degraded ? "degraded" : "success",
      reason,
      skipped: [...ctx.skipped],
      descriptors: { total: scan.total, compiled: scan.compiled, pending: scan.pending, failed: scan.failed },
      pose: { animation: ctx.poseAnimation, outcome: ctx.poseOutcome },
      elapsedMs: now() - ctx.startedAt,
    });
  }

  function outfitTreeComplete() {
    const renderer = outfitRenderer;
    return Boolean(
      renderer?.currentRig
      && !renderer.currentlyUpdating
      && !renderer.currentlyChangingRig
      && !renderer.hasNewUpdate,
    );
  }

  function tick() {
    if (ctx.finished) return;
    const totalElapsedMs = now() - ctx.startedAt;
    if (totalElapsedMs >= totalDeadlineMs) {
      settleReject(
        `Thumbnail-Vorbereitung hat das Gesamtzeitlimit von ${Math.round(totalDeadlineMs / 1000)} s überschritten `
        + `(Stufe „${ctx.stage}“). Diagnose: ${JSON.stringify(snapshot().descriptors)}`,
      );
      return;
    }

    if (ctx.stage === THUMBNAIL_STAGES.WAITING_OUTFIT) {
      if (ctx.assetFailure) {
        settleReject(`Avatar-Instance-Tree fehlgeschlagen (Fehlerstufe: ${ctx.assetFailure}).`);
        return;
      }
      if (outfitTreeComplete()) {
        enterPosingStage();
        emitDiagnostics();
        return;
      }
      if (now() - ctx.stageStartedAt >= outfitDeadlineMs) {
        settleReject(
          `Avatar-Instance-Tree wurde nach ${Math.round(outfitDeadlineMs / 1000)} s nicht fertig `
          + `(currentlyUpdating=${outfitRenderer?.currentlyUpdating}, currentlyChangingRig=${outfitRenderer?.currentlyChangingRig}, `
          + `hasNewUpdate=${outfitRenderer?.hasNewUpdate}, Rig vorhanden=${Boolean(outfitRenderer?.currentRig)}).`,
        );
      }
      return;
    }

    if (ctx.stage === THUMBNAIL_STAGES.POSING) {
      const deadlineHit = now() - ctx.stageStartedAt >= poseDeadlineMs;
      if (!ctx.poseSettled && deadlineHit) ctx.poseOutcome = "timeout";
      if (ctx.poseSettled || deadlineHit) {
        applyPoseFrames();
        enterCompileStage();
        emitDiagnostics();
      }
      return;
    }

    if (ctx.stage === THUMBNAIL_STAGES.WAITING_RENDER_COMPILE) {
      if (!ctx.rig) {
        settleReject("Kein Rig für die Render-Kompilierung vorhanden (Rig wurde während der Vorbereitung entfernt).");
        return;
      }
      if (!ctx.addedToScene) {
        try {
          addInstance(ctx.rig, outfitRenderer?.auth, renderScene);
        } catch { /* Compile-Versuch läuft gleich über den nächsten Tick weiter. */ }
        ctx.addedToScene = true;
      }

      let allCompiled = false;
      try {
        allCompiled = renderScene.areInstancesCompiled(ctx.rig.GetDescendants());
      } catch {
        allCompiled = false;
      }
      if (allCompiled) {
        finishFromCompileStage("compiled");
        return;
      }

      const scan = scanDescriptors();
      ctx.lastScan = scan;
      const progressCount = scan.compiled + ctx.skipped.length;
      if (progressCount !== ctx.lastCompiledCount + ctx.lastSkippedCount || ctx.lastCompiledCount === -1) {
        ctx.lastCompiledCount = scan.compiled;
        ctx.lastSkippedCount = ctx.skipped.length;
        ctx.lastProgressAt = now();
      }

      if (now() - ctx.stageStartedAt >= compileDeadlineMs) {
        if (scan.compiled > 0 || ctx.skipped.length > 0) {
          finishFromCompileStage("compile-timeout");
        } else {
          settleReject(
            `Render-Kompilierung ist nach ${Math.round(compileDeadlineMs / 1000)} s nicht in Gang gekommen `
            + `(Descriptors: total=${scan.total}, pending=${scan.pending}, failed=${scan.failed}; `
            + `zuletzt pending: ${scan.pendingInstances.slice(-3).map(describeInstance).join(", ") || "–"}).`,
          );
        }
        return;
      }

      if (ctx.skipped.length > maxSkippedInstances) {
        finishFromCompileStage("skip-limit");
        return;
      }

      if (now() - ctx.lastProgressAt >= descStallMs) {
        const stuck = pickStuckInstance(scan);
        if (stuck) {
          skipInstance(stuck, scan.failedInstances.includes(stuck) ? "render-desc-failed" : "render-desc-pending");
          emitDiagnostics();
        } else {
          // Blockierer nicht identifizierbar (z. B. Wettlauf) – Fortschrittsmarke
          // zurücksetzen und auf den nächsten Scan warten statt heiß zu loopen.
          ctx.lastProgressAt = now();
        }
      }
      return;
    }
  }

  function run() {
    const promise = new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });

    // Thumbnail-Modus der Bibliothek spiegeln (sonst verändert _updateOutfit die
    // Szene nachträglich oder feuert Kamera-/Hintergrund-Effekte).
    try {
      outfitRenderer.doAddInstance = false;
      if (outfitRenderer.backgroundRenderer) {
        outfitRenderer.backgroundRenderer.affectSceneAppearance = false;
        outfitRenderer.backgroundRenderer.cameraAffectsTransparency = false;
      }
      if (isR6) outfitRenderer.deltaTimeMultiplier = 0;
    } catch { /* Felder weichen ab – die Zustandsmaschine bleibt trotzdem begrenzt. */ }

    // onError beobachten: rig/humanoidDescription → sofort konkrete Fehlerstufe
    // melden statt bis zur Stufen-Deadline zu warten.
    connect(outfitRenderer?.onError, (failureStage) => {
      ctx.assetFailure = ctx.assetFailure || String(failureStage || "unknown");
    });

    ctx.timer = setIntervalFn(tick, pollMs);
    // Ausgangszustand zuerst melden, damit Beobachter jede Stufe sehen;
    // dann sofort der erste Tick (schnelle Renders warten keine Poll-Periode).
    emitDiagnostics();
    tick();
    return promise;
  }

  /** Räumt Timer und Listener auf; ein evtl. noch laufender run() wird abgewiesen. */
  function dispose() {
    if (ctx.finished) return;
    settleReject("Thumbnail-Vorbereitung wurde vorzeitig abgebrochen (dispose).");
  }

  return { run, snapshot, dispose };
}
