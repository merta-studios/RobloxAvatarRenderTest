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
  assert.match(dockerfile, /COPY public \.\/public\//);
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
