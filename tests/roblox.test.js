import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedRobloxAssetUrl, openCloudAssetDeliveryUrl, validateUsername } from "../src/roblox.js";

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
