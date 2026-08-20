import {
  API,
  Authentication,
  FLAGS,
  Outfit,
  OutfitRenderer,
  RBXRenderer,
} from "roavatar-renderer";

import { BUILD_ID } from "./build-info.js";
import { createAssetVersionMap, recordAssetVersions, rewriteAssetDeliveryUrl } from "./asset-urls.js";
import { extractAssetIdFromUrl, guardGetAssetBuffer, guardGetMesh } from "./asset-loader-guard.js";
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

const state = window.__renderState = {
  phase: "idle",
  message: "Renderer wird initialisiert …",
  done: false,
  error: null,
  assetLabels: [],
  // Assets, die nicht geladen werden konnten und deshalb übersprungen wurden
  // (z. B. UGC mit HTTP 401 – Roblox verlangt dafür seit April 2025 Authentifizierung).
  skippedAssets: [],
  buildId: BUILD_ID,
  updatedAt: Date.now(),
};

/** Asset-IDs, die übersprungen wurden (Fehlschlag oder Zeitlimit). */
const skippedAssetIds = new Set();

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

/**
 * Watchdog: schlägt Alarm, wenn sich weder die Phase noch die Liste der
 * geladenen Assets bewegt. Macht aus „hängt still bis zum globalen Timeout“
 * einen konkreten Fehler mit Phase und letztem Asset.
 */
let lastSignature = "";
let lastMovementAt = Date.now();
const watchdog = setInterval(() => {
  if (state.done) {
    clearInterval(watchdog);
    return;
  }
  state.assetLabels = currentLabels();
  const signature = `${state.phase}|${state.assetLabels.join("|")}`;
  if (signature !== lastSignature) {
    lastSignature = signature;
    lastMovementAt = Date.now();
    return;
  }
  const stalledFor = Date.now() - lastMovementAt;
  if (stalledFor >= STALL_LIMIT_MS) {
    const recent = state.assetLabels.slice(-2);
    const detail = recent.length ? ` Zuletzt geladen: ${recent.join(", ")}.` : "";
    state.error = `Kein Fortschritt seit ${Math.round(stalledFor / 1000)} s in Phase „${state.phase}“.${detail}`;
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
const recordSkipped = (url) => {
  const id = extractAssetIdFromUrl(url);
  if (id) skippedAssetIds.add(id);
  else skippedAssetIds.add(String(url).slice(0, 96));
};
const getAssetBufferOriginal = API.Asset.GetAssetBuffer.bind(API.Asset);
API.Asset.GetAssetBuffer = guardGetAssetBuffer(getAssetBufferOriginal, {
  deadlineMs: ASSET_LOAD_DEADLINE_MS,
  onSkipped: recordSkipped,
});
const getMeshOriginal = API.Asset.GetMesh.bind(API.Asset);
API.Asset.GetMesh = guardGetMesh(getMeshOriginal, { onSkipped: recordSkipped });

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
  const succeeded = await outfitRenderer.prepareForThumbnail();
  if (!succeeded) {
    const detail = assetFailure
      ? `Fehlerstufe: ${assetFailure} – ${describeAssetFailure(assetFailure)}`
      : "Ursache unbekannt";
    throw new Error(`Mindestens ein Avatar-Asset konnte nicht verarbeitet werden. ${detail}`);
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
    state.done = true;
    report("error", state.error);
  });
}
