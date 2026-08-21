import test from "node:test";
import assert from "node:assert/strict";
import {
  extractOpenCloudAssetLocation,
  inspectOpenCloudAssetResponse,
  isAllowedRobloxAssetUrl,
  openCloudAssetDeliveryUrl,
  validateUsername,
} from "../src/roblox.js";

test("validiert Roblox-Usernamen", () => {
  assert.equal(validateUsername("Builderman"), "Builderman");
  assert.equal(validateUsername(" abc_123 "), "abc_123");
  assert.throws(() => validateUsername("ab"));
  assert.throws(() => validateUsername("name-with-dash"));
});

test("Proxy erlaubt ausschließlich Roblox Asset-Hosts über HTTPS", () => {
  assert.equal(isAllowedRobloxAssetUrl("https://avatar.roblox.com/v1/users/1/avatar"), true);
  assert.equal(isAllowedRobloxAssetUrl("https://t3.rbxcdn.com/abc"), true);
  assert.equal(isAllowedRobloxAssetUrl("https://evil-rbxcdn.com/a"), false);
  assert.equal(isAllowedRobloxAssetUrl("http://avatar.roblox.com/a"), false);
  assert.equal(isAllowedRobloxAssetUrl("https://example.com/a"), false);
});

test("contentdelivery.roblox.com ist erlaubt – dort liegen die OpenCloud-Locations", () => {
  // Produktions-Log (2026-08-21, Deploy mit PR #15), pro Asset zweimal:
  //   [proxy] OpenCloud-Location mit unerlaubtem Host contentdelivery.roblox.com:
  //   HTTP 200, https://contentdelivery.roblox.com/v1/bytes/sc2/<hash>?__token__=… – nächster Versuch
  assert.equal(
    isAllowedRobloxAssetUrl("https://contentdelivery.roblox.com/v1/bytes/sc2/2ff1f4f1?__token__=exp=1755777777~acl=%2f*~hmac=deadbeef"),
    true,
  );
  // Exakter Host-Vergleich: Suffix-/Präfix-Tricks bleiben verboten.
  assert.equal(isAllowedRobloxAssetUrl("https://evil-contentdelivery.roblox.com.attacker.com/v1/bytes/sc2/x"), false);
  assert.equal(isAllowedRobloxAssetUrl("https://contentdelivery.roblox.com.attacker.com/v1/bytes/sc2/x"), false);
  assert.equal(isAllowedRobloxAssetUrl("https://evilcontentdelivery.roblox.com/v1/bytes/sc2/x"), false);
  assert.equal(isAllowedRobloxAssetUrl("http://contentdelivery.roblox.com/v1/bytes/sc2/x"), false);
});

test("extractOpenCloudAssetLocation liest PascalCase- und camelCase-Antworten", () => {
  assert.equal(
    extractOpenCloudAssetLocation({ Location: "https://t1.rbxcdn.com/pascal", RequestId: "request-1" }),
    "https://t1.rbxcdn.com/pascal",
  );
  assert.equal(
    extractOpenCloudAssetLocation({ location: "https://t2.rbxcdn.com/camel" }),
    "https://t2.rbxcdn.com/camel",
  );
  assert.equal(
    extractOpenCloudAssetLocation({ LOCATION: "https://t3.rbxcdn.com/case-insensitive" }),
    "https://t3.rbxcdn.com/case-insensitive",
  );
});

test("extractOpenCloudAssetLocation liest Batch-Arrays case-insensitive", () => {
  assert.equal(
    extractOpenCloudAssetLocation({ Locations: [{ Location: "https://t4.rbxcdn.com/pascal-batch" }] }),
    "https://t4.rbxcdn.com/pascal-batch",
  );
  assert.equal(
    extractOpenCloudAssetLocation({ locations: [{ ignored: true }, { location: "https://t5.rbxcdn.com/camel-batch" }] }),
    "https://t5.rbxcdn.com/camel-batch",
  );
});

test("extractOpenCloudAssetLocation lehnt Fehler- und leere Antworten ab", () => {
  assert.equal(extractOpenCloudAssetLocation({ Errors: [{ Code: 0, Message: "Asset nicht verfügbar" }] }), null);
  assert.equal(extractOpenCloudAssetLocation({ errors: [{ message: "Authentication required" }] }), null);
  assert.equal(extractOpenCloudAssetLocation({ Errors: [] }), null);
  assert.equal(
    extractOpenCloudAssetLocation({ Location: "https://t1.rbxcdn.com/must-not-win", Errors: [{ Message: "error" }] }),
    null,
  );
  assert.equal(extractOpenCloudAssetLocation(null), null);
  assert.equal(extractOpenCloudAssetLocation(undefined), null);
  assert.equal(extractOpenCloudAssetLocation({}), null);
});

test("Nicht-JSON-OpenCloud-Antwort bleibt als unveränderter Rohcontent durchreichbar", async () => {
  const bytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0x52, 0x42, 0x58, 0x4d]);
  const response = new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
  });

  const inspected = await inspectOpenCloudAssetResponse(response);
  assert.deepEqual(inspected, {
    kind: "raw",
    reason: "content-type",
    contentType: "application/octet-stream",
  });
  assert.equal(response.bodyUsed, false, "Inspektion darf den weiterzureichenden Body nicht verbrauchen");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("Ungültiges JSON wird als Rohcontent klassifiziert, ohne den Original-Body zu verbrauchen", async () => {
  const response = new Response("<roblox-asset>", {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  const inspected = await inspectOpenCloudAssetResponse(response);
  assert.equal(inspected.kind, "raw");
  assert.equal(inspected.reason, "parse-error");
  assert.equal(inspected.bodyText, "<roblox-asset>");
  assert.ok(inspected.parseError instanceof SyntaxError);
  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), "<roblox-asset>");
});

test("JSON-OpenCloud-Antwort wird aus einem Clone gelesen", async () => {
  const body = JSON.stringify({ Location: "https://t1.rbxcdn.com/asset" });
  const response = new Response(body, { headers: { "content-type": "application/problem+json" } });
  const inspected = await inspectOpenCloudAssetResponse(response);
  assert.equal(inspected.kind, "json");
  assert.deepEqual(inspected.json, { Location: "https://t1.rbxcdn.com/asset" });
  assert.equal(response.bodyUsed, false);
});

test("openCloudAssetDeliveryUrl leitet assetdelivery-URLs auf die OpenCloud-API um", () => {
  // Versionierte URL (die der Renderer für bekannte Assets nutzt) → Version bleibt erhalten.
  assert.equal(
    openCloudAssetDeliveryUrl("https://assetdelivery.roblox.com/v2/assetId/13576957688/version/17576717563"),
    "https://apis.roblox.com/asset-delivery-api/v1/assetId/13576957688/version/17576717563",
  );
  assert.equal(
    openCloudAssetDeliveryUrl("https://assetdelivery.roblox.com/v1/assetId/27112025"),
    "https://apis.roblox.com/asset-delivery-api/v1/assetId/27112025",
  );
  // Unversionierte URL (unbekannte Asset-ID) → ohne Version.
  assert.equal(
    openCloudAssetDeliveryUrl("https://assetdelivery.roblox.com/v2/asset?id=13576957688&contentRepresentationPriorityList=abc"),
    "https://apis.roblox.com/asset-delivery-api/v1/assetId/13576957688",
  );
  // Keine Asset-ID ableitbar → null (kein OpenCloud-Versuch).
  assert.equal(openCloudAssetDeliveryUrl("https://assetdelivery.roblox.com/v2/asset"), null);
  assert.equal(openCloudAssetDeliveryUrl("https://assetdelivery.roblox.com/v2/asset?id=abc"), null);
  assert.equal(openCloudAssetDeliveryUrl("https://example.com/foo"), null);
  assert.equal(openCloudAssetDeliveryUrl("not a url"), null);
});

test("openCloudAssetDeliveryUrlCandidates liefert versioniert zuerst, dann unversioniert", async () => {
  const { openCloudAssetDeliveryUrlCandidates } = await import("../src/roblox.js");
  // Versionierte URL → beide Kandidaten (versioniert exakt, unversioniert als
  // Rückfallebene, falls OpenCloud die Versionsnummer nicht akzeptiert).
  assert.deepEqual(
    openCloudAssetDeliveryUrlCandidates("https://assetdelivery.roblox.com/v2/assetId/13576957688/version/17576717563"),
    [
      "https://apis.roblox.com/asset-delivery-api/v1/assetId/13576957688/version/17576717563",
      "https://apis.roblox.com/asset-delivery-api/v1/assetId/13576957688",
    ],
  );
  // Unversionierte URL → nur der unversionierte Kandidat.
  assert.deepEqual(
    openCloudAssetDeliveryUrlCandidates("https://assetdelivery.roblox.com/v2/asset?id=13576957688"),
    ["https://apis.roblox.com/asset-delivery-api/v1/assetId/13576957688"],
  );
  assert.deepEqual(openCloudAssetDeliveryUrlCandidates("https://example.com/foo"), []);
});

test("pickEnvelopeLocation bevorzugt den zum Roblox-AssetFormat passenden Eintrag", async () => {
  const { pickEnvelopeLocation } = await import("../src/roblox.js");
  const envelope = {
    locations: [
      { assetFormat: "source", location: "https://t0.rbxcdn.com/source" },
      { assetFormat: "avatar_meshpart_head", location: "https://t0.rbxcdn.com/head" },
    ],
  };
  assert.equal(pickEnvelopeLocation(envelope, "avatar_meshpart_head"), "https://t0.rbxcdn.com/head");
  assert.equal(pickEnvelopeLocation(envelope), "https://t0.rbxcdn.com/source");
  assert.equal(pickEnvelopeLocation(envelope, "unbekannt"), "https://t0.rbxcdn.com/source");
  // Direkte Location (Antwortform der OpenCloud-API ohne locations-Array).
  assert.equal(pickEnvelopeLocation({ location: "https://t1.rbxcdn.com/direct" }), "https://t1.rbxcdn.com/direct");
  // Fehler-Antworten bleiben ausgeschlossen.
  assert.equal(pickEnvelopeLocation({ errors: [{ code: 401 }] }), null);
  assert.equal(pickEnvelopeLocation(null), null);
});

test("buildLocationsEnvelope erzeugt genau das Format, das getCDNURLFromAssetDelivery parst", async () => {
  const { buildLocationsEnvelope } = await import("../src/roblox.js");
  const envelope = buildLocationsEnvelope("https://fts.rbxcdn.com/sc2/abc?__token__=x", "avatar_meshpart_head");
  // Die Bibliothek liest data.locations[0].location – das muss immer gesetzt sein.
  assert.equal(envelope.locations[0].location, "https://fts.rbxcdn.com/sc2/abc?__token__=x");
  assert.equal(envelope.locations[0].assetFormat, "avatar_meshpart_head");
  const fallback = buildLocationsEnvelope("https://t2.rbxcdn.com/y");
  assert.equal(fallback.locations[0].assetFormat, "source");
});
