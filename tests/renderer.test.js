import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

test("index.html lädt draco_decoder.js als klassisches Script VOR dem Renderer-Modul", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  const dracoIndex = html.indexOf('src="/draco_decoder.js"');
  const moduleIndex = html.indexOf('src="/src/renderer-client.js"');
  assert.ok(dracoIndex !== -1, "draco_decoder.js-Script-Tag fehlt");
  assert.ok(moduleIndex !== -1, "Renderer-Modul-Tag fehlt");
  assert.ok(dracoIndex < moduleIndex, "draco_decoder.js muss vor dem Renderer-Modul geladen werden");
  // Klassisches Script, kein type="module" – es muss synchron vor dem Modul ausgeführt werden.
  assert.doesNotMatch(html.slice(0, moduleIndex), /<script[^>]*type="module"[^>]*src="\/draco_decoder\.js"/);
});

test("public/draco_decoder.js definiert das globale DracoDecoderModule", () => {
  const draco = readFileSync(new URL("public/draco_decoder.js", root), "utf8");
  assert.match(draco, /var DracoDecoderModule = /, "globale Definition fehlt");
  assert.match(draco, /DracoDecoderModule\.ready/, "Embindung an DracoDecoderModule.ready fehlt");
});

test("Dockerfile kopiert public/ in die Build-Stage, damit Vite draco_decoder.js in dist/ ablegt", () => {
  const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");
  assert.match(dockerfile, /COPY public \.\/public/);
});

test("Dockerfile kopiert das gesamte src/ – sonst scheitert vite build an asset-urls.js", () => {
  const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");
  // PR #8 hat nur renderer-client.js + renderer.css kopiert. Vite konnte
  // ./asset-urls.js nicht auflösen, der Deploy blieb auf dem alten Image.
  assert.match(dockerfile, /COPY src \.\/src/);
  assert.doesNotMatch(dockerfile, /COPY src\/renderer-client\.js src\/renderer\.css/);
  assert.doesNotMatch(
    dockerfile,
    /COPY src\/server\.js src\/config\.js src\/commands\.js src\/roblox\.js src\/discord-net\.js/,
  );
});

test("Renderer nutzt lokale Bibliotheks-Assets statt der cookie-pflichtigen Online-Versionen", () => {
  const client = readFileSync(new URL("src/renderer-client.js", root), "utf8");
  // Seit Roblox unauthentifizierte Asset-Delivery einschränkt (HTTP 401 für die
  // privaten roavatar-Assets), müssen Rigs, Composit-Meshes & Standard-Texturen
  // lokal vom Bot ausgeliefert werden.
  assert.match(client, /FLAGS\.ONLINE_ASSETS = false/);
  assert.match(client, /FLAGS\.ASSETS_PATH = "\/assets\/rbxasset\/"/);
  assert.match(client, /FLAGS\.RIG_PATH = "\/assets\/"/);
  // Avatar-Assets laufen versioniert über assetdelivery (cookie-frei).
  assert.match(client, /rewriteAssetDeliveryUrl/);
  assert.match(client, /recordAssetVersions\(outfit, assetVersionById\)/);
  // Roblox-AssetFormat muss durch den Proxy, sonst kommen Accessoires/Köpfe im falschen Format.
  assert.match(client, /roblox-assetformat/);
  assert.match(client, /BUILD_ID/);
});

test("alle statischen roavatar-Assets sind im Repo vorhanden", () => {
  const required = [
    "public/assets/RigR15.rbxm",
    "public/assets/RigR6.rbxm",
    "public/assets/rbxasset/textures/face.png",
    "public/assets/rbxasset/avatar/meshes/torso.mesh",
    "public/assets/rbxasset/avatar/heads/head.mesh",
    "public/assets/rbxasset/avatar/compositing/CompositTShirt.mesh",
    "public/assets/rbxasset/avatar/compositing/CompositPantsTemplate.mesh",
    "public/assets/rbxasset/textures/particles/SquareParticle.png",
  ];
  for (const file of required) {
    assert.ok(existsSync(new URL(file, root)), `fehlendes lokales Asset: ${file}`);
  }
});

test("Server legt Build-Kennung, Diagnose-Logs und SKIP_DISCORD offen", () => {
  const server = readFileSync(new URL("src/server.js", root), "utf8");
  assert.match(server, /build: getBuildInfo\(\)/);
  assert.match(server, /config\.skipDiscord/);
  assert.match(server, /logRenderFailure/);
  assert.match(server, /\/render-debug/);
  assert.match(server, /roblox-assetformat/);
});

test("Renderer löst die lokalen Rig-Pfade deterministisch auf", () => {
  const client = readFileSync(new URL("src/renderer-client.js", root), "utf8");
  // Der ContentMap der Bibliothek wird beim Import gebaut – der Bot fängt die
  // Rig-Auflösung deshalb selbst ab, damit die lokalen Rigs immer absolut laden.
  assert.match(client, /roavatar:\/\/RigR15\.rbxm"\) return "\/assets\/RigR15\.rbxm/);
  assert.match(client, /roavatar:\/\/RigR6\.rbxm"\) return "\/assets\/RigR6\.rbxm/);
  // Lokale Texturen (Standard-Gesicht, Partikel) dürfen nicht am Proxy-HTTPS-Check scheitern.
  assert.match(client, /const remote = \/\^https:\\\/\\\//);
});

test("Renderer hängt nicht mehr an einzelnen Assets: Guard, Deadline und Skip-Reporting", () => {
  const client = readFileSync(new URL("src/renderer-client.js", root), "utf8");
  // GetAssetBuffer wird mit Rejection-/Deadline-Guard umhüllt (früher: Promise
  // ohne catch → Render hing ewig in Phase „assets“).
  assert.match(client, /guardGetAssetBuffer/);
  assert.match(client, /ASSET_LOAD_DEADLINE_MS = 150_000/);
  assert.match(client, /API\.Asset\.GetAssetBuffer = guardGetAssetBuffer/);
  // GetRBX deckt den RBXM-Pfad ab (fromBuffer wirft auf korrupten Formaten,
  // die .then(resolve)-Ketten der Bibliothek haben kein catch).
  assert.match(client, /guardGetRBX/);
  assert.match(client, /GET_RBX_DEADLINE_MS = 190_000/);
  assert.match(client, /API\.Asset\.GetRBX = guardGetRBX/);
  // Animation-Ladepfade („Animation was already loaded“-Wettlauf u. a.) werden
  // über die exportierten Prototype-Klassen entschärft – ohne node_modules-Eingriff.
  assert.match(client, /patchAnimatorWrapper\(AnimatorWrapper/);
  assert.match(client, /patchHumanoidDescriptionApply\(HumanoidDescriptionWrapper/);
  // Abgebrochene/failed Responses werden übersprungen statt den Render abzubrechen.
  assert.match(client, /skippedAssetIds/);
  assert.match(client, /state\.skippedAssets = \[\.\.\.skippedAssetIds\]/);
  // Der Watchdog ignoriert Labels bereits übersprungener Assets (die Bibliothek
  // räumt ihr Loading-Label bei Fehlern nicht ab).
  assert.match(client, /getCurrentlyLoadingLabels/);
  assert.match(client, /filter\(\(label\) => !skippedAssetIds\.has/);
});

test("prepareForThumbnail bekommt eine Stall-erkennende Deadline unter dem 240-s-Watchdog", () => {
  const client = readFileSync(new URL("src/renderer-client.js", root), "utf8");
  // Die Bibliothek löst prepareForThumbnail evtl. NIE auf (interne .then(resolve)-
  // Promises). Flache Deadlines würden legitime langsame Renders killen – deshalb
  // bricht nur echter Stillstand (200 s < Watchdog 240 s) ab.
  assert.match(client, /withStallDeadline\(outfitRenderer\.prepareForThumbnail\(\)/);
  assert.match(client, /PREPARE_STALL_LIMIT_MS = 200_000/);
  assert.match(client, /PREPARE_FLAT_LIMIT_MS = 400_000/);
  assert.match(client, /getProgressSignature: \(\) =>/);
});

test("fetchWithTimeout bricht nur die Header-Phase ab, nicht den Body-Stream", () => {
  const moduleSource = readFileSync(new URL("src/fetch-timeout.js", root), "utf8");
  assert.match(moduleSource, /AbortController/);
  // Der Timer wird beim Settlen gelöscht: große/langsame Bodies werden nicht
  // mehr nach 60 s mitten im Download abgebrochen.
  assert.match(moduleSource, /\.finally\(\(\) => clearTimeout\(timeout\)\)/);
  assert.doesNotMatch(moduleSource, /AbortSignal\.timeout/);
});

test("Server-Proxy kennt den OpenCloud-Fallback für assetdelivery-401s", () => {
  const server = readFileSync(new URL("src/server.js", root), "utf8");
  assert.match(server, /openCloudAssetDeliveryUrl/);
  assert.match(server, /x-api-key/);
  assert.match(server, /config\.openCloudApiKey/);
  assert.match(server, /skippedAssets/);
});

test("Discord-Fehlermeldung enthält Diagnose (Build, fehlgeschlagene Requests, Console)", () => {
  const server = readFileSync(new URL("src/server.js", root), "utf8");
  // Fix C: Statt nur der Phasen-Meldung sieht der User in Discord jetzt auch,
  // WELCHE Requests/Console-Fehler den Render abgebrochen haben – und anhand
  // der Build-ID, ob überhaupt der aktuelle Stand deployed ist.
  assert.match(server, /error\?\.diagnostics/);
  assert.match(server, /Diagnose:/);
  assert.match(server, /diagnostics\.failedRequests/);
  assert.match(server, /diagnostics\.consoleErrors/);
  assert.match(server, /diagnostics\.buildId/);
});
