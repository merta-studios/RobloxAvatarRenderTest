/**
 * Versionierte Asset-Delivery-URLs für Roblox.
 *
 * Hintergrund: Seit April 2025 verlangt Roblox für Asset-Delivery-Endpunkte
 * zunehmend Authentifizierung. Der alte, unversionierte Endpunkt
 * `assetdelivery.roblox.com/v1|v2/asset?id=…` liefert für viele Assets HTTP 401
 * („Authentication required to access Asset.“). Ohne Cookie verfügbar bleibt der
 * versionierte Endpunkt `assetdelivery.roblox.com/v2/assetId/{id}/version/{version}`
 * – sofern die Versionsnummer bekannt ist. Die Avatar-API
 * (`avatar.roblox.com/v2/avatar/users/{id}/avatar`) liefert für jedes getragene
 * Asset `currentVersionId` gleich mit. Diese Versionsnummern werden hier
 * gesammelt und in Asset-Anfragen eingesetzt.
 *
 * Reine Funktionen ohne Browser-Abhängigkeiten, damit sie in Node getestet werden
 * können (`node --test`).
 */

/** Bekannte Asset-IDs → Versionsnummern (z. B. aus der Avatar-Antwort). */
export function createAssetVersionMap() {
  return new Map();
}

/**
 * Übernimmt `id`/`currentVersionId` aller Assets eines `Outfit`-Objekts in die
 * Versions-Map. Der Aufrufer kann statt des Outfit-Objekts auch die rohe
 * Avatar-JSON (`{ assets: [{ id, currentVersionId }] }`) übergeben.
 *
 * @param {object} outfitLike Outfit oder Avatar-JSON mit `assets`-Array
 * @param {Map<string, string>} versionById Ziel-Map (id → currentVersionId)
 * @returns {Map<string, string>} dieselbe Map (für Verkettung)
 */
export function recordAssetVersions(outfitLike, versionById) {
  const assets = Array.isArray(outfitLike?.assets) ? outfitLike.assets : [];
  for (const asset of assets) {
    const id = asset?.id ?? asset?.assetId;
    const version = asset?.currentVersionId ?? asset?.assetVersionId;
    if (!id || !version) continue;
    const idStr = String(id);
    const versionStr = String(version);
    if (!/^\d+$/.test(idStr) || !/^\d+$/.test(versionStr)) continue;
    versionById.set(idStr, versionStr);
  }
  return versionById;
}

const ASSET_ID_URL_PATTERN = /^\/v[12]\/asset$/;

/**
 * Schreibt eine unversionierte Asset-Delivery-URL auf den versionierten
 * Endpunkt um, wenn die Versionsnummer des Assets bekannt ist:
 *
 *   https://assetdelivery.roblox.com/v2/asset?id=123&…&contentRepresentationPriorityList=…
 *     → https://assetdelivery.roblox.com/v2/assetId/123/version/456
 *
 * Ist die Version unbekannt, bleibt die URL unverändert – der unversionierte
 * Endpunkt funktioniert für viele Katalog-Assets weiterhin. Query-Parameter
 * (inkl. `contentRepresentationPriorityList` für Kopf-Formen) bleiben erhalten.
 *
 * @param {string} rawUrl Zu prüfende URL
 * @param {Map<string, string>} versionById Versions-Map (id → version)
 * @returns {string} Umgeschriebene oder unveränderte URL
 */
export function rewriteAssetDeliveryUrl(rawUrl, versionById) {
  if (!versionById || versionById.size === 0) return rawUrl;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.protocol !== "https:" || url.hostname !== "assetdelivery.roblox.com") return rawUrl;
  if (!ASSET_ID_URL_PATTERN.test(url.pathname)) return rawUrl;

  const assetId = url.searchParams.get("id");
  if (!assetId || !/^\d+$/.test(assetId)) return rawUrl;

  const version = versionById.get(assetId);
  if (!version) return rawUrl;

  url.pathname = `/v2/assetId/${assetId}/version/${version}`;
  url.searchParams.delete("id");
  return url.href;
}
