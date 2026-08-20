import {
  API,
  Authentication,
  FLAGS,
  Outfit,
  OutfitRenderer,
  RBXRenderer,
} from "roavatar-renderer";

import "./renderer.css";

/**
 * Zeitlimits & Watchdog: Jede Netzwerk-Anfrage und jede Phase bekommt ein hartes
 * Limit, damit ein einzelner hängender Download nicht erst nach dem globalen
 * Render-Timeout (420 s) auffällt.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const STALL_LIMIT_MS = 240_000;
const WATCHDOG_TICK_MS = 5_000;

const state = window.__renderState = {
  phase: "idle",
  message: "Renderer wird initialisiert …",
  done: false,
  error: null,
  assetLabels: [],
  updatedAt: Date.now(),
};

function report(phase, message) {
  Object.assign(state, { phase, message, updatedAt: Date.now() });
  const element = document.querySelector("#status");
  if (element) element.textContent = message;
}

function currentLabels() {
  try {
    return API.Misc.getCurrentlyLoadingLabels().map((label) => String(label).slice(-96));
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

/** fetch mit hartem Zeitlimit — roavatar-renderer setzt selbst keins. */
function fetchWithTimeout(input, init = {}) {
  const signals = [];
  if (init.signal) signals.push(init.signal);
  signals.push(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  return nativeFetch(input, {
    ...init,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  });
}

const nativeFetchDirect = (input, init = {}) => {
  const raw = input instanceof Request ? input.url : String(input);
  if (/^https:\/\//i.test(raw)) {
    return fetchWithTimeout(`/roblox-proxy?url=${encodeURIComponent(raw)}`, {
      method: init.method || "GET",
      signal: init.signal,
    });
  }
  return fetchWithTimeout(input, init);
};
FLAGS.FETCH_FUNC = nativeFetchDirect;

FLAGS.ONLINE_ASSETS = true;
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
 * Das Original lädt Texturen direkt per <img> von rbxcdn.com — ohne Timeout und
 * am Proxy vorbei. Ein hängender CDN-Socket blockiert sonst den kompletten
 * Render bis zum globalen Zeitlimit. Deshalb: Abruf über den Proxy mit hartem
 * Zeitlimit; Fehler → undefined (gleiche Semantik wie image.onerror im Original).
 */
API.Generic.LoadImage = (url) => (async () => {
  const fetchStr = await API.Misc.assetURLToCDNURL(url);
  if (fetchStr instanceof Response || typeof fetchStr !== "string" || !/^https:\/\//i.test(fetchStr)) {
    return undefined;
  }
  const response = await fetchWithTimeout(`/roblox-proxy?url=${encodeURIComponent(fetchStr)}`);
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
  const succeeded = await outfitRenderer.prepareForThumbnail();
  if (!succeeded) throw new Error("Mindestens ein Avatar-Asset konnte nicht verarbeitet werden.");

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
    state.done = true;
    report("error", state.error);
  });
}
