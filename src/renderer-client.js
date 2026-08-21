import {
  API,
  AnimatorWrapper,
  Authentication,
  AvatarType,
  FLAGS,
  HumanoidDescriptionWrapper,
  Outfit,
  OutfitRenderer,
  RBXRenderer,
} from "roavatar-renderer";

import { BUILD_ID } from "./build-info.js";
import { createAssetVersionMap, recordAssetVersions, rewriteAssetDeliveryUrl } from "./asset-urls.js";
import { extractAssetIdFromUrl, guardGetAssetBuffer, guardGetMesh, guardGetRBX } from "./asset-loader-guard.js";
import {
  patchAnimatorWrapper,
  patchHumanoidDescriptionApply,
  patchOutfitRendererRigLoad,
  patchRenderDescCompile,
} from "./library-guards.js";
import { createThumbnailPipeline } from "./thumbnail-pipeline.js";
import { createFetchWithTimeout } from "./fetch-timeout.js";
import "./renderer.css";

/**
 * Zeitlimits & Watchdog: Jede Netzwerk-Anfrage und jede Phase bekommt ein hartes
 * Limit, damit ein einzelner hängender Download nicht erst nach dem globalen
 * Render-Timeout (420 s) auffällt.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const STALL_LIMIT_MS = 240_000;
const WATCHDOG_TICK_MS = 5_000;
// Pro-Asset-Deadline für den GetAssetBuffer-Guard: liegt bewusst zwischen dem
// natürlichen Request-Limit (2 Versuche à 60 s = 120 s) und dem Watchdog (240 s),
// damit ein hängendes Asset den Render nie mehr blockieren kann.
const ASSET_LOAD_DEADLINE_MS = 150_000;
// GetRBX = Download (max. ASSET_LOAD_DEADLINE_MS) + RBXM-Parsing: etwas mehr
// Luft, dann wird das Asset übersprungen statt den Render zu blockieren.
const GET_RBX_DEADLINE_MS = 190_000;
// Pro-Render-Descriptor-Deadline (compileResults): Fehler/Timeout werden zu
// „failed“ statt zu einem ewig pending Descriptor ohne jedes Event.
const COMPILE_STEP_DEADLINE_MS = 150_000;
// Stufen-Budgets der Thumbnail-Zustandsmaschine (Summe < Render-Timeout 420 s).
// Kein flaches Warten auf prepareForThumbnail-Events mehr: Jede Stufe pollt
// überprüfbaren Objektzustand und hat eine eigene, nachvollziehbare Deadline.
const OUTFIT_STAGE_LIMIT_MS = 210_000;   // Instance-Tree (Downloads + applyDescription)
const POSE_STAGE_LIMIT_MS = 30_000;      // setMainAnimation + Pose-Frames
const COMPILE_STAGE_LIMIT_MS = 120_000;  // Render-Kompilierung inkl. Skip-Loop
const DESC_STALL_LIMIT_MS = 30_000;      // ohne Compile-Fortschritt: nächsten Blockierer überspringen
const PREPARE_TOTAL_LIMIT_MS = 395_000;  // flaches Gesamtlimit der Vorbereitung

const state = window.__renderState = {
  phase: "idle",
  message: "Renderer wird initialisiert …",
  done: false,
  error: null,
  assetLabels: [],
  // Assets, die nicht geladen werden konnten und deshalb übersprungen wurden
  // (z. B. UGC mit HTTP 401 – Roblox verlangt dafür seit April 2025 Authentifizierung).
  skippedAssets: [],
  // Detaillierte Gründe pro übersprungenem Asset ({id, reason}) – z. B.
  // "HTTP 401" (kein/abgelehnter OpenCloud-Key) oder "Zeitlimit 150 s"
  // (Antwort-Contract-Verstoß oder hängender Download).
  skippedAssetDetails: [],
  // Interne Diagnose der Thumbnail-Zustandsmaschine: konkreter Teilschritt statt
  // nur „assets“, damit ein Stall nie wieder als leeres `assets|`-Signal endet.
  prepareStage: null,
  prepare: null,
  // Render-Descriptors/Instanzen, die dauerhaft pending/failed waren und
  // übersprungen wurden (der Rest-Avatar wird trotzdem gerendert).
  skippedRenderInstances: [],
  buildId: BUILD_ID,
  updatedAt: Date.now(),
};

/** Asset-IDs, die übersprungen wurden (Fehlschlag oder Zeitlimit). */
const skippedAssetIds = new Set();
/** Asset-ID/URL → Grund des Überspringens (für die Discord-Diagnose). */
const skippedAssetDetails = new Map();

function report(phase, message) {
  Object.assign(state, { phase, message, updatedAt: Date.now() });
  const element = document.querySelector("#status");
  if (element) element.textContent = message;
}

function currentLabels() {
  try {
    // Bereits übersprungene Assets ausblenden: Deren interne Labels bleiben in
    // der Bibliothek hängen (sie räumt sie bei Fehlern nicht ab) und würden den
    // Watchdog sonst fälschlich auf „kein Fortschritt“ schlagen lassen.
    // Erst filtern, DANN kürzen – sonst geht bei langen Labels (z. B. mit
    // contentRepresentationPriorityList) das rbxassetid://-Präfix verloren.
    return API.Misc.getCurrentlyLoadingLabels()
      .filter((label) => !skippedAssetIds.has(extractAssetIdFromUrl(label)))
      .map((label) => String(label).slice(-96));
  } catch {
    return [];
  }
}

/** Aktive Thumbnail-Zustandsmaschine (null außerhalb der Asset-Phase). */
let activePipeline = null;

function mergePrepareDiagnostics(snapshot) {
  if (!snapshot) return;
  state.prepareStage = snapshot.stage;
  state.prepare = {
    stageElapsedMs: snapshot.stageElapsedMs,
    totalElapsedMs: snapshot.totalElapsedMs,
    hasCurrentRig: snapshot.hasCurrentRig,
    currentlyUpdating: snapshot.currentlyUpdating,
    currentlyChangingRig: snapshot.currentlyChangingRig,
    hasNewUpdate: snapshot.hasNewUpdate,
    hasFiredFullyRendered: snapshot.hasFiredFullyRendered,
    rigDescendantCount: snapshot.rigDescendantCount,
    descriptors: snapshot.descriptors,
    pendingInstances: snapshot.pendingInstances,
    skippedInstances: snapshot.skippedInstances,
    pose: snapshot.pose,
  };
  state.updatedAt = Date.now();
}

/**
 * Watchdog: schlägt Alarm, wenn sich weder die Phase noch die Liste der
 * geladenen Assets noch die interne Vorbereitungs-Stufe bewegt. Macht aus
 * „hängt still bis zum globalen Timeout“ einen konkreten Fehler mit Phase,
 * Teilschritt und pending Render-Descriptors.
 */
let lastSignature = "";
let lastMovementAt = Date.now();
const watchdog = setInterval(() => {
  if (state.done) {
    clearInterval(watchdog);
    return;
  }
  state.assetLabels = currentLabels();
  if (activePipeline) {
    try { mergePrepareDiagnostics(activePipeline.snapshot()); } catch { /* Diagnose ist optional */ }
  }
  const prepare = state.prepare;
  const prepareSig = prepare
    ? `${state.prepareStage}|d=${prepare.descriptors?.compiled ?? "?"}/${prepare.descriptors?.total ?? "?"}|p=${prepare.descriptors?.pending ?? "?"}|s=${(prepare.skippedInstances || []).length}`
    : "";
  const signature = `${state.phase}|${state.assetLabels.join("|")}|${prepareSig}`;
  if (signature !== lastSignature) {
    lastSignature = signature;
    lastMovementAt = Date.now();
    return;
  }
  const stalledFor = Date.now() - lastMovementAt;
  if (stalledFor >= STALL_LIMIT_MS) {
    const recent = state.assetLabels.slice(-2);
    const detail = recent.length ? ` Zuletzt geladen: ${recent.join(", ")}.` : "";
    const stageDetail = prepare
      ? ` Teilschritt: „${state.prepareStage}“ seit ${Math.round((prepare.stageElapsedMs || 0) / 1000)} s;`
        + ` Descriptors compiled/pending/failed: ${prepare.descriptors?.compiled}/${prepare.descriptors?.pending}/${prepare.descriptors?.failed};`
        + ` pending zuletzt: ${(prepare.pendingInstances || []).slice(0, 3).join(", ") || "–"};`
        + ` übersprungene Instanzen: ${(prepare.skippedInstances || []).slice(0, 3).join(", ") || "–"}.`
      : "";
    state.error = `Kein Fortschritt seit ${Math.round(stalledFor / 1000)} s in Phase „${state.phase}“.${stageDetail}${detail}`;
    state.done = true;
    report("error", state.error);
  }
}, WATCHDOG_TICK_MS);

const nativeFetch = window.fetch.bind(window);

/**
 * Asset-IDs → aktuelle Versionsnummern (currentVersionId aus der Avatar-Antwort).
 * Roblox liefert unversionierte Asset-Delivery-Anfragen zunehmend nur noch mit
 * Authentifizierung aus; der versionierte Endpunkt
 * `assetdelivery.roblox.com/v2/assetId/{id}/version/{version}` funktioniert
 * dagegen ohne Cookie. Deshalb werden alle bekannten Asset-Requests umgeschrieben.
 */
const assetVersionById = createAssetVersionMap();

/** fetch mit hartem Zeitlimit auf die Antwort-Header — roavatar-renderer setzt selbst keins. */
const fetchWithTimeout = createFetchWithTimeout(nativeFetch, { timeoutMs: REQUEST_TIMEOUT_MS });

/**
 * roavatar-renderer setzt z. B. `Roblox-AssetFormat: avatar_meshpart_head`
 * bzw. `avatar_meshpart_accessory`. Ohne diese Header liefert Asset-Delivery
 * oft das falsche Format – der Proxy muss sie durchreichen.
 */
function pickProxyHeaders(headers) {
  if (!headers) return {};
  const src = headers instanceof Headers ? headers : new Headers(headers);
  const out = {};
  for (const name of ["roblox-assetformat", "roblox-place-id"]) {
    const value = src.get(name);
    if (value) out[name] = value;
  }
  return out;
}

const nativeFetchDirect = (input, init = {}) => {
  const raw = input instanceof Request ? input.url : String(input);
  if (/^https:\/\//i.test(raw)) {
    const headerSource = input instanceof Request ? input.headers : init.headers;
    return fetchWithTimeout(`/roblox-proxy?url=${encodeURIComponent(rewriteAssetDeliveryUrl(raw, assetVersionById))}`, {
      method: init.method || (input instanceof Request ? input.method : "GET") || "GET",
      signal: init.signal,
      headers: pickProxyHeaders(headerSource),
    });
  }
  return fetchWithTimeout(input, init);
};
FLAGS.FETCH_FUNC = nativeFetchDirect;

FLAGS.ONLINE_ASSETS = false;
// Statische Bibliotheks-Assets (Rigs, Composit-Meshes, Standard-Kopf/Fläche)
// werden vom Bot selbst ausgeliefert: Roblox verlangt für die privaten
// Online-Versionen dieser Assets seit April 2025 Authentifizierung
// (HTTP 401 „Authentication required to access Asset.“), und der Bot hat –
// bewusst – keinen Roblox-Cookie. Die eigentlichen Avatar-Assets des Users
// kommen weiterhin live von Roblox.
FLAGS.ASSETS_PATH = "/assets/rbxasset/";
FLAGS.RIG_PATH = "/assets/";
FLAGS.USE_WORKERS = false;
FLAGS.ENABLE_HSR = false;
FLAGS.USE_POST_PROCESSING = false;
FLAGS.ENABLE_API_CACHE = false;
FLAGS.ENABLE_API_MESH_CACHE = false;
FLAGS.ENABLE_API_RBX_CACHE = false;
FLAGS.AUDIO_ENABLED = false;
FLAGS.GEAR_ENABLED = false;
FLAGS.API_REQUEST_RETRY = true;

/**
 * Härtet die Asset-Loader der Bibliothek ab: Ein einzelnes nicht ladbares Asset
 * (z. B. UGC, das seit April 2025 ohne Authentifizierung HTTP 401 liefert) darf
 * den Render weder blockieren noch abbrechen – es wird übersprungen und der
 * Rest des Avatars gerendert. Fehlgeschlagene Assets landen in
 * `state.skippedAssets` für die Discord-Antwort.
 */
const recordSkipped = (url, reason) => {
  const id = extractAssetIdFromUrl(url);
  const key = id || String(url).slice(0, 96);
  skippedAssetIds.add(key);
  skippedAssetDetails.set(key, String(reason || "").slice(0, 80) || "unbekannt");
};
const getAssetBufferOriginal = API.Asset.GetAssetBuffer.bind(API.Asset);
API.Asset.GetAssetBuffer = guardGetAssetBuffer(getAssetBufferOriginal, {
  deadlineMs: ASSET_LOAD_DEADLINE_MS,
  onSkipped: recordSkipped,
});
const getMeshOriginal = API.Asset.GetMesh.bind(API.Asset);
API.Asset.GetMesh = guardGetMesh(getMeshOriginal, { onSkipped: recordSkipped });
// GetRBX deckt den zweiten internen Download-Pfad ab (RBXM-Bäume: Rig, Body
// Parts, Animationen, Accessoires). Rejections – z. B. wirft rbx.fromBuffer()
// auf korrupten/neuen Formaten – würden sonst an den .then(resolve)-Ketten der
// Bibliothek hängen (Stillstand mit leerer Label-Liste).
const getRbxOriginal = API.Asset.GetRBX.bind(API.Asset);
API.Asset.GetRBX = guardGetRBX(getRbxOriginal, {
  deadlineMs: GET_RBX_DEADLINE_MS,
  onSkipped: recordSkipped,
});

/**
 * Entschärft die Animation-Ladepfade der Bibliothek („Animation was already
 * loaded“-Wettlauf, Prop()-Zugriffe auf leere RBX-Bäume, fehlende Parents):
 * Diese Throws ließen _applyAnimations/loadAvatarAnimation über .then(resolve)-
 * Promises OHNE catch NIE auflösen – der Render hing still in Phase „assets“.
 * Gepatcht wird der Prototype der exportierten Klassen (kein node_modules-Eingriff).
 */
const recordSkippedAnimation = ({ method, id, error }) => {
  const idStr = String(id ?? "");
  if (/^\d+$/.test(idStr)) {
    skippedAssetIds.add(idStr);
    skippedAssetDetails.set(idStr, `Animation (${method}) fehlgeschlagen`);
  }
  console.warn(`[guard] Animation übersprungen (${method}${idStr ? `, Asset ${idStr}` : ""}): ${error?.message || error}`);
};
patchAnimatorWrapper(AnimatorWrapper, { onSkipped: recordSkippedAnimation });
patchHumanoidDescriptionApply(HumanoidDescriptionWrapper, {
  onSkipped: ({ method, error }) => {
    console.warn(`[guard] HumanoidDescription.${method} übersprungen: ${error?.message || error}`);
  },
});
// _setRigTo: eigenes new Promise(resolve) mit GetRBX(...).then(...) OHNE
// Rejection-Handler; ein Throw in generateTree/GetChildren ließ das Promise
// für immer pending (keinerlei Event, leeres Fortschrittssignal). Mit Patch
// wird daraus onError("rig") + Auflösung.
patchOutfitRendererRigLoad(OutfitRenderer, {
  getRBX: (url, headers) => API.Asset.GetRBX(url, headers),
  addInstance: (instance, auth, renderScene) => RBXRenderer.addInstance(instance, auth, renderScene),
  onSkipped: ({ method, error }) => {
    console.warn(`[guard] Rig-Laden: ${method} fehlgeschlagen: ${error?.message || error}`);
  },
});
// Render-Compile-Pfad: _addRenderDesc hängt an compileResults(...).then(...)
// OHNE catch. Ein Reject/Throw/Hänger dort ließ den Descriptor für immer
// „weder compiled noch failed“ bleiben – onRenderSuccess feuerte nie (das
// beobachtete `assets|`-Stall-Signal). Mit Patch werden Fehler/Deadline zu
// „failed“ (failedRenderDesc feuert), und die Zustandsmaschine überspringt
// den einzelnen Descriptor gezielt.
patchRenderDescCompile(RBXRenderer, {
  compileDeadlineMs: COMPILE_STEP_DEADLINE_MS,
  onFailed: ({ label, reason, error }) => {
    console.warn(`[guard] Render-Descriptor ${reason}: ${label}${error?.message ? ` (${error.message})` : ""}`);
  },
  stopLoadingLabel: (label) => API.Misc.stopCurrentlyLoadingAssets(label),
});

/**
 * Die Rig-URLs (`roavatar://RigR15.rbxm` / `RigR6`) löst die Bibliothek über
 * ihren ContentMap auf, der beim Import mit den damaligen Flag-Werten gebaut
 * wird. Damit die lokalen Rigs unabhängig von dieser Initialisierung immer
 * absolut vom Bot geladen werden, fängt der Bot die Auflösung selbst ab.
 * (parseAssetString wird zur Laufzeit über API.Misc aufgerufen, daher greift
 * der Wrapper für alle internen Asset-Downloads.)
 */
const parseAssetStringOriginal = API.Misc.parseAssetString.bind(API.Misc);
API.Misc.parseAssetString = (str) => {
  if (str === "roavatar://RigR15.rbxm") return "/assets/RigR15.rbxm";
  if (str === "roavatar://RigR6.rbxm") return "/assets/RigR6.rbxm";
  return parseAssetStringOriginal(str);
};

/**
 * Avatar-Konfiguration laden UND dabei die `currentVersionId` jedes Assets
 * einsammeln, damit Asset-Downloads über den versionierten (cookie-freien)
 * Endpunkt laufen können. Das Originalverhalten bleibt unverändert.
 */
const getAvatarDetailsOriginal = API.Avatar.GetAvatarDetails.bind(API.Avatar);
API.Avatar.GetAvatarDetails = async (userId) => {
  const outfit = await getAvatarDetailsOriginal(userId);
  if (outfit instanceof Outfit) {
    recordAssetVersions(outfit, assetVersionById);
  }
  return outfit;
};

/**
 * Das Original lädt Texturen direkt per <img> von rbxcdn.com — ohne Timeout und
 * am Proxy vorbei. Ein hängender CDN-Socket blockiert sonst den kompletten
 * Render bis zum globalen Zeitlimit. Deshalb: Remote-Abruf über den Proxy mit
 * hartem Zeitlimit; lokale Bibliotheks-Texturen (Standard-Gesicht, Partikel)
 * direkt vom Bot. Fehler → undefined (gleiche Semantik wie image.onerror im Original).
 */
API.Generic.LoadImage = (url) => (async () => {
  const fetchStr = await API.Misc.assetURLToCDNURL(url);
  if (fetchStr instanceof Response || typeof fetchStr !== "string") {
    return undefined;
  }
  const remote = /^https:\/\//i.test(fetchStr);
  const target = remote
    ? `/roblox-proxy?url=${encodeURIComponent(rewriteAssetDeliveryUrl(fetchStr, assetVersionById))}`
    : fetchStr;
  const response = await fetchWithTimeout(target);
  if (!response.ok) return undefined;
  const blob = await response.blob();
  if (!blob.size) return undefined;
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(undefined);
      image.src = objectUrl;
    });
  } finally {
    // Nach dem Decode hält Three.js die Bilddaten; die Object-URL wird nicht mehr gebraucht.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
})().catch(() => undefined);

/**
 * Übersetzt die interne Fehlerstufe von OutfitRenderer.onError/onRenderError
 * in eine verständliche Beschreibung für die Discord-Antwort.
 */
function describeAssetFailure(stage) {
  switch (stage) {
    case "rig":
      return "Das Basis-Rig (Skelett) konnte nicht geladen werden – die lokalen Renderer-Assets fehlen vermutlich oder sind beschädigt.";
    case "humanoidDescription":
      return "Die Avatar-Ausstattung (Körperteile, Kleidung, Accessoires, Animationen) konnte nicht vollständig angewendet werden – meist ein nicht ladbares oder moderiertes Asset auf Robloxs Seite.";
    case "renderDesc":
      return "Ein Mesh/Asset konnte nicht für das Rendering kompiliert werden – das Asset ist möglicherweise in einem neueren Format oder nicht ladbar.";
    case "backgroundData":
      return "Die Hintergrund-Daten konnten nicht geladen werden.";
    case "avatarCyclorama":
      return "Die Hintergrund-Bühne (Cyclorama) konnte nicht geladen werden.";
    default:
      return "Details stehen in den Server-Logs.";
  }
}

async function render(userId) {
  report("setup", "3D-Engine wird vorbereitet …");
  // includeAnimate = false: kein permanenter requestAnimationFrame-Renderloop.
  // Auf SwiftShader (Software-Rendering, ~0,1 CPU) frisst so ein Dauer-Loop fast
  // die gesamte CPU — Downloads und Mesh-Parsing verhungern und der Render läuft
  // in jedes Zeitlimit. Stattdessen wird am Ende genau ein Frame gezeichnet.
  // Render-Kompilierung läuft Promise-basiert und braucht keinen Frame-Tick;
  // der finale Frame folgt nach der Compile-Phase (unten).
  const setupSucceeded = await RBXRenderer.fullSetup(true, true, false);
  if (!setupSucceeded) throw new Error("WebGL-Renderer konnte nicht gestartet werden.");

  RBXRenderer.setRendererSize(640, 640);
  RBXRenderer.setBackgroundColor(0x20242b);
  RBXRenderer.setBackgroundTransparent(false);
  document.querySelector("#app").appendChild(RBXRenderer.getRendererElement());

  report("profile", "Avatar-Konfiguration wird von Roblox geladen …");
  const outfit = await API.Avatar.GetAvatarDetails(userId);
  if (!(outfit instanceof Outfit)) {
    throw new Error(`Avatar-API antwortete mit HTTP ${outfit?.status ?? "unbekannt"}.`);
  }

  report("assets", "Originale Roblox-Assets und Meshes werden geladen …");
  const auth = new Authentication();
  const outfitRenderer = new OutfitRenderer(auth, outfit);
  // Merkt sich die konkrete Fehlerstufe, damit die Fehlermeldung am Ende
  // mehr sagt als „irgendein Asset hat nicht geklappt“.
  let assetFailure = null;
  outfitRenderer.onError.Connect((stage) => {
    assetFailure = assetFailure || String(stage || "unknown");
  });
  outfitRenderer.onRenderError.Connect(() => {
    assetFailure = assetFailure || "renderDesc";
  });

  // NEU (Nachfolger des Event-Replay-Patches): prepareForThumbnail() wird NICHT
  // mehr abgewartet. Dessen zweiter Wartepunkt (onRenderSuccess) feuert nie,
  // wenn ein Render-Descriptor dauerhaft pending bleibt – exakt der
  // Produktions-Stall `assets|`. Stattdessen: eigene, nachvollziehbare
  // Zustandsmaschine mit Stufen-Deadlines, Compile-Polling am echten
  // RenderScene-Zustand und gezieltem Überspringen defekter Instanzen.
  const pipeline = createThumbnailPipeline({
    outfitRenderer,
    renderScene: outfitRenderer.renderScene,
    addInstance: (instance, pipelineAuth, renderScene) => RBXRenderer.addInstance(instance, pipelineAuth, renderScene),
    removeInstance: (instance, renderScene) => RBXRenderer.removeInstance(instance, renderScene),
    isR6: outfit.playerAvatarType === AvatarType.R6,
    onDiagnostics: mergePrepareDiagnostics,
  }, {
    outfitDeadlineMs: OUTFIT_STAGE_LIMIT_MS,
    poseDeadlineMs: POSE_STAGE_LIMIT_MS,
    compileDeadlineMs: COMPILE_STAGE_LIMIT_MS,
    descStallMs: DESC_STALL_LIMIT_MS,
    totalDeadlineMs: PREPARE_TOTAL_LIMIT_MS,
  });
  activePipeline = pipeline;

  let prepareResult;
  try {
    prepareResult = await pipeline.run();
  } catch (error) {
    const detail = assetFailure
      ? ` Fehlerstufe: ${assetFailure} – ${describeAssetFailure(assetFailure)}`
      : "";
    throw new Error(`Avatar-Vorbereitung fehlgeschlagen: ${error?.message || error}.${detail}`);
  } finally {
    pipeline.dispose();
    activePipeline = null;
  }

  if (prepareResult.status === "degraded") {
    const labels = prepareResult.skipped.map((entry) => entry.label).slice(0, 8);
    console.warn(`[render] Degraded-Render (${prepareResult.reason}): ${prepareResult.skipped.length} Instanz(en) übersprungen: ${labels.join(", ") || "–"}`);
    state.skippedRenderInstances = prepareResult.skipped.map((entry) => entry.label);
  }

  report("finalize", "Materialien, Pose, Licht und Kamera werden finalisiert …");
  // Genau ein finaler Frame statt Dauer-Loop; danach kurz auf die Darstellung warten.
  RBXRenderer.animateAll(false);
  await new Promise((resolve) => {
    const fallback = setTimeout(resolve, 3_000);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(fallback);
      resolve();
    }));
  });
  report("done", "Render fertig.");
  state.skippedAssets = [...skippedAssetIds];
  state.skippedAssetDetails = [...skippedAssetDetails].map(([id, reason]) => ({ id, reason }));
  state.done = true;
}

const userId = Number(new URLSearchParams(location.search).get("userId"));
if (!Number.isSafeInteger(userId) || userId <= 0) {
  state.error = "Ungültige Roblox User-ID.";
  state.done = true;
  report("error", state.error);
} else {
  render(userId).catch((error) => {
    console.error(error);
    state.error = error instanceof Error ? error.message : String(error);
    state.skippedAssets = [...skippedAssetIds];
    state.skippedAssetDetails = [...skippedAssetDetails].map(([id, reason]) => ({ id, reason }));
    state.done = true;
    report("error", state.error);
  });
}
