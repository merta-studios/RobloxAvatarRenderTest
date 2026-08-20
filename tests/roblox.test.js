import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedRobloxAssetUrl, validateUsername } from "../src/roblox.js";

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
