import test from "node:test";
import assert from "node:assert/strict";
import {
  createAssetVersionMap,
  recordAssetVersions,
  rewriteAssetDeliveryUrl,
} from "../src/asset-urls.js";

test("recordAssetVersions sammelt id/currentVersionId aus der Avatar-JSON", () => {
  const map = createAssetVersionMap();
  recordAssetVersions({
    assets: [
      { id: 301811432, name: "Oakley Pants", currentVersionId: 10151325111 },
      { id: 607785314, currentVersionId: 955993454 },
      { id: 999, currentVersionId: undefined },
      { name: "ohne id", currentVersionId: 1 },
    ],
  }, map);
  assert.equal(map.get("301811432"), "10151325111");
  assert.equal(map.get("607785314"), "955993454");
  assert.equal(map.has("999"), false);
  assert.equal(map.size, 2);
});

test("recordAssetVersions akzeptiert assetId/assetVersionId als Aliase", () => {
  const map = createAssetVersionMap();
  recordAssetVersions({ assets: [{ assetId: 42, assetVersionId: 7 }] }, map);
  assert.equal(map.get("42"), "7");
});

test("rewriteAssetDeliveryUrl nutzt den versionierten Endpunkt bei bekannter Version", () => {
  const map = new Map([["301811432", "10151325111"]]);
  assert.equal(
    rewriteAssetDeliveryUrl("https://assetdelivery.roblox.com/v2/asset?id=301811432", map),
    "https://assetdelivery.roblox.com/v2/assetId/301811432/version/10151325111",
  );
  // v1-Form wird ebenfalls umgeschrieben (ASSETDELIVERY_V2 migriert ohnehin auf v2).
  assert.equal(
    rewriteAssetDeliveryUrl("https://assetdelivery.roblox.com/v1/asset?id=301811432", map),
    "https://assetdelivery.roblox.com/v2/assetId/301811432/version/10151325111",
  );
});

test("rewriteAssetDeliveryUrl lässt unbekannte IDs unverändert", () => {
  const map = new Map([["301811432", "10151325111"]]);
  const url = "https://assetdelivery.roblox.com/v2/asset?id=117612227055721";
  assert.equal(rewriteAssetDeliveryUrl(url, map), url);
});

test("rewriteAssetDeliveryUrl fasst contentRepresentationPriorityList nicht an", () => {
  // Format-Aushandlung (z. B. Kopf-Formen) bleibt auf dem Legacy-Endpunkt,
  // der sie zuverlässig unterstützt.
  const map = new Map([["123", "456"]]);
  const url = "https://assetdelivery.roblox.com/v2/asset?id=123&contentRepresentationPriorityList=abc";
  assert.equal(rewriteAssetDeliveryUrl(url, map), url);
});

test("rewriteAssetDeliveryUrl ignoriert fremde Hosts, Protokolle und Pfade", () => {
  const map = new Map([["123", "456"]]);
  const cases = [
    "https://avatar.roblox.com/v1/users/1/avatar",
    "https://t3.rbxcdn.com/abc?x=1",
    "http://assetdelivery.roblox.com/v2/asset?id=123",
    "https://assetdelivery.roblox.com/v2/assetId/123/version/456",
    "https://evil.com/v2/asset?id=123",
    "keine url",
  ];
  for (const url of cases) assert.equal(rewriteAssetDeliveryUrl(url, map), url);
});

test("rewriteAssetDeliveryUrl entfernt den id-Query-Parameter beim Umschreiben", () => {
  const map = new Map([["123", "456"]]);
  const rewritten = rewriteAssetDeliveryUrl("https://assetdelivery.roblox.com/v2/asset?id=123&foo=bar", map);
  const parsed = new URL(rewritten);
  assert.equal(parsed.pathname, "/v2/assetId/123/version/456");
  assert.equal(parsed.searchParams.get("foo"), "bar");
  assert.equal(parsed.searchParams.has("id"), false);
});
