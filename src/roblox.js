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

/**
 * Hosts, die der Proxy laden darf. `contentdelivery.roblox.com` steht hier,
 * weil die OpenCloud Asset-Delivery-API (apis.roblox.com) ihre signierten
 * Locations real auf diesem Host ausliefert:
 *
 *   https://contentdelivery.roblox.com/v1/bytes/sc2/<hash>?__token__=exp=…~acl=…~hmac=…
 *
 * Ohne diesen Eintrag verwarf der Proxy JEDE erfolgreiche OpenCloud-Antwort
 * („OpenCloud-Location mit unerlaubtem Host contentdelivery.roblox.com:
 * HTTP 200 … – nächster Versuch“) und fiel auf den öffentlichen Endpunkt
 * zurück, der für UGC nichts Lieferbares hat. Genau das ließ Shirt, Hose und
 * Community-Accessoires trotz gültigem API-Key fehlen.
 */
const allowedHosts = new Set([
  "avatar.roblox.com",
  "assetdelivery.roblox.com",
  "contentdelivery.roblox.com",
  "users.roblox.com",
  "apis.roblox.com",
]);

export function isAllowedRobloxAssetUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== "https:") return false;
  return allowedHosts.has(url.hostname) || url.hostname === "rbxcdn.com" || url.hostname.endsWith(".rbxcdn.com");
}

function getCaseInsensitiveField(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = Object.entries(value).find(([key]) => key.toLowerCase() === fieldName.toLowerCase());
  return entry?.[1];
}

/**
 * Extrahiert das CDN-Ziel aus den unterschiedlichen Antwortvarianten der
 * OpenCloud Asset-Delivery-API. Der v1-Endpunkt verwendet PascalCase, ältere
 * bzw. andere Asset-Delivery-Antworten verwenden teilweise camelCase.
 * Fehlerantworten dürfen nie als erfolgreicher Location-Response gelten.
 *
 * @param {unknown} json bereits geparste OpenCloud-Antwort
 * @returns {string|null} Location oder null bei unbekanntem/fehlerhaftem Schema
 */
export function extractOpenCloudAssetLocation(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  const hasErrorsField = Object.keys(json).some((key) => key.toLowerCase() === "errors");
  if (hasErrorsField) return null;

  const direct = getCaseInsensitiveField(json, "location");
  if (typeof direct === "string" && direct.trim()) return direct;

  const locations = getCaseInsensitiveField(json, "locations");
  if (!Array.isArray(locations)) return null;
  for (const item of locations) {
    const location = getCaseInsensitiveField(item, "location");
    if (typeof location === "string" && location.trim()) return location;
  }
  return null;
}

/**
 * Klassifiziert die OpenCloud-Antwort, ohne den Original-Body zu verbrauchen.
 * So kann der Proxy Antworten mit binärem Content-Type oder kaputtem JSON als
 * direkten Asset-Body weiterreichen. JSON wird über einen Clone gelesen.
 *
 * @param {Response} response
 * @returns {Promise<
 *   {kind: "json", json: unknown, bodyText: string, contentType: string}
 *   | {kind: "raw", reason: "content-type" | "parse-error", contentType: string, bodyText?: string, parseError?: unknown}
 * >}
 */
export async function inspectOpenCloudAssetResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const mimeType = contentType.split(";", 1)[0].trim().toLowerCase();
  const hasJsonContentType = mimeType.endsWith("/json") || mimeType.endsWith("+json");
  if (!hasJsonContentType) {
    return { kind: "raw", reason: "content-type", contentType };
  }

  const bodyText = await response.clone().text();
  try {
    return { kind: "json", json: JSON.parse(bodyText), bodyText, contentType };
  } catch (parseError) {
    return { kind: "raw", reason: "parse-error", contentType, bodyText, parseError };
  }
}

/**
 * Liefert alle sinnvollen OpenCloud-Asset-Delivery-URLs für eine
 * assetdelivery.roblox.com-URL – versioniert zuerst (exakte Version aus der
 * Avatar-Antwort), danach unversioniert (aktuelle Version, falls Roblox die
 * Versionsnummer des OpenCloud-Endpunkts nicht akzeptiert).
 *
 * @param {string} rawUrl assetdelivery.roblox.com-URL
 * @returns {string[]} OpenCloud-URLs (eventuell leer)
 */
export function openCloudAssetDeliveryUrlCandidates(rawUrl) {
  const urls = [];
  const versioned = openCloudAssetDeliveryUrl(rawUrl);
  if (versioned) urls.push(versioned);
  const id = (() => {
    try {
      const url = new URL(rawUrl);
      const versionedMatch = /^\/v[12]\/assetId\/(\d+)/.exec(url.pathname);
      if (versionedMatch) return versionedMatch[1];
      const idParam = url.searchParams.get("id");
      return idParam && /^\d+$/.test(idParam) ? idParam : null;
    } catch { return null; }
  })();
  if (id) {
    const unversioned = `https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}`;
    if (!urls.includes(unversioned)) urls.push(unversioned);
  }
  return urls;
}

/**
 * Wählt aus einer Asset-Delivery-Antwort (`{location}` oder `{locations:[…]})`
 * die Location, die zum angeforderten Asset-Format passt. Die Bibliothek
 * liest hinterher blind `locations[0].location` – wir bestücken die Envelope
 * deshalb selbst mit dem besten Kandidaten.
 *
 * @param {unknown} json bereits geparste Asset-Delivery-Antwort
 * @param {string|null} [preferredAssetFormat] Wert des Roblox-AssetFormat-Headers (z. B. "avatar_meshpart_head")
 * @returns {string|null} Location oder null
 */
export function pickEnvelopeLocation(json, preferredAssetFormat = null) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  const hasErrorsField = Object.keys(json).some((key) => key.toLowerCase() === "errors");
  if (hasErrorsField) return null;

  const locationsEntry = Object.entries(json).find(([key]) => key.toLowerCase() === "locations");
  const locations = Array.isArray(locationsEntry?.[1]) ? locationsEntry[1] : null;
  if (locations) {
    const entries = locations
      .map((item) => {
        const location = getCaseInsensitiveField(item, "location");
        const format = getCaseInsensitiveField(item, "assetformat");
        return typeof location === "string" && location.trim()
          ? { location: location.trim(), format: typeof format === "string" ? format : null }
          : null;
      })
      .filter(Boolean);
    if (entries.length) {
      const preferred = preferredAssetFormat
        ? entries.find((entry) => entry.format === preferredAssetFormat)
        : null;
      return (preferred || entries[0]).location;
    }
  }

  const direct = getCaseInsensitiveField(json, "location");
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return null;
}

/**
 * Baut die JSON-Envelope, die roavatar-renderer (ASSETDELIVERY_V2) von jeder
 * assetdelivery.roblox.com/v2-URL erwartet:
 *
 *   {"locations":[{"assetFormat":"…","location":"https://…rbxcdn.com/…"}]}
 *
 * Die Bibliothek ruft auf der Antwort `response.json()` auf und liest
 * `data.locations[0].location` (getCDNURLFromAssetDelivery). Roh-Binärdaten
 * lassen diese Promise-Kette OHNE catch scheitern – das Asset lädt dann nie
 * und wird erst durch unsere Guard-Deadline nach 150 s übersprungen. Der Proxy
 * darf daher für Asset-Delivery-Anfragen NIE Binärdaten liefern, sondern muss
 * die Location in dieser Envelope weiterreichen.
 *
 * @param {string} location CDN-Location (z. B. https://fts.rbxcdn.com/…?__token__=…)
 * @param {string|null} [assetFormat] bekanntes Format der Location, sonst "source"
 * @returns {object} serialisierbare Envelope für response.json()
 */
export function buildLocationsEnvelope(location, assetFormat = null) {
  return {
    locations: [{ assetFormat: assetFormat || "source", location }],
  };
}

/**
 * Leitet eine assetdelivery.roblox.com-URL auf die offizielle OpenCloud
 * Asset-Delivery-API um (https://apis.roblox.com/asset-delivery-api/v1/…).
 * Die OpenCloud-Endpunkte sind seit April 2025 der einzige Weg, UGC-Assets
 * (Kleidung, Accessoires) ohne .ROBLOSECURITY-Cookie zu laden – mit einem
 * OpenCloud-API-Key (`x-api-key`) mit Scope `legacy-asset:manage`.
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
