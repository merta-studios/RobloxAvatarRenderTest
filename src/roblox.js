const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

export class RobloxError extends Error {}

export function validateUsername(username) {
  const clean = username.trim();
  if (!USERNAME_PATTERN.test(clean)) {
    throw new RobloxError("Der Roblox-Username muss 3–20 Zeichen lang sein und darf nur Buchstaben, Zahlen und _ enthalten.");
  }
  return clean;
}

export async function resolveRobloxUser(username, signal) {
  const clean = validateUsername(username);
  const response = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "AvatarRenderTest/1.0" },
    body: JSON.stringify({ usernames: [clean], excludeBannedUsers: false }),
    signal,
  });
  if (!response.ok) throw new RobloxError(`Roblox Benutzer-API antwortete mit HTTP ${response.status}.`);
  const body = await response.json();
  const user = body.data?.[0];
  if (!user) throw new RobloxError(`Roblox-User „${clean}“ wurde nicht gefunden.`);
  return { id: Number(user.id), name: user.name, displayName: user.displayName };
}

const allowedHosts = new Set([
  "avatar.roblox.com",
  "assetdelivery.roblox.com",
  "users.roblox.com",
  "apis.roblox.com",
]);

export function isAllowedRobloxAssetUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== "https:") return false;
  return allowedHosts.has(url.hostname) || url.hostname === "rbxcdn.com" || url.hostname.endsWith(".rbxcdn.com");
}

/**
 * Leitet eine assetdelivery.roblox.com-URL auf die offizielle OpenCloud
 * Asset-Delivery-API um (https://apis.roblox.com/asset-delivery-api/v1/…).
 * Die OpenCloud-Endpunkte sind seit April 2025 der einzige Weg, UGC-Assets
 * (Kleidung, Accessoires) ohne .ROBLOSECURITY-Cookie zu laden – mit einem
 * OpenCloud-API-Key (`x-api-key`), der für beliebige öffentliche Assets reicht.
 *
 * Unterstützt versionierte und unversionierte URLs:
 *   /v2/assetId/123/version/456 → /asset-delivery-api/v1/assetId/123/version/456
 *   /v1/asset?id=123            → /asset-delivery-api/v1/assetId/123
 *
 * @param {string} rawUrl assetdelivery.roblox.com-URL
 * @returns {string|null} OpenCloud-URL oder null, wenn keine Asset-ID ableitbar ist
 */
export function openCloudAssetDeliveryUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const versioned = /^\/v[12]\/assetId\/(\d+)(?:\/version\/(\d+))?$/.exec(url.pathname);
  if (versioned) {
    const [, id, version] = versioned;
    return version
      ? `https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}/version/${version}`
      : `https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}`;
  }
  const id = url.searchParams.get("id");
  if (id && /^\d+$/.test(id)) {
    return `https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}`;
  }
  return null;
}
