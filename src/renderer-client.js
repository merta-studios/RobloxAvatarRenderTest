import {
  API,
  Authentication,
  FLAGS,
  Outfit,
  OutfitRenderer,
  RBXRenderer,
} from "roavatar-renderer";

import "./renderer.css";

const state = window.__renderState = {
  phase: "idle",
  message: "Renderer wird initialisiert …",
  done: false,
  error: null,
};

function report(phase, message) {
  Object.assign(state, { phase, message });
  const element = document.querySelector("#status");
  if (element) element.textContent = message;
}

const nativeFetch = window.fetch.bind(window);
FLAGS.FETCH_FUNC = (input, init = {}) => {
  const raw = input instanceof Request ? input.url : String(input);
  if (/^https:\/\//i.test(raw)) {
    return nativeFetch(`/roblox-proxy?url=${encodeURIComponent(raw)}`, {
      method: init.method || "GET",
      signal: init.signal,
    });
  }
  return nativeFetch(input, init);
};
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

async function render(userId) {
  report("setup", "3D-Engine wird vorbereitet …");
  const setupSucceeded = await RBXRenderer.fullSetup(true, true, true);
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
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
