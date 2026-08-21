/**
 * Stub für alle Roblox-Netzwerkaufrufe des Servers (nur für Tests).
 *
 * Reproduziert das seit April 2025 reale Verhalten von Roblox:
 *  - assetdelivery.roblox.com liefert UGC-Assets ohne Authentifizierung HTTP 401
 *    („Authentication required to access Asset.“),
 *  - Roblox-eigene Assets liefert der versionierte Endunkt unauthentifiziert als
 *    JSON-Locations-Envelope,
 *  - die OpenCloud Asset-Delivery-API (apis.roblox.com/asset-delivery-api) nimmt
 *    nur Anfragen mit korrektem `x-api-key` an und antwortet mit {location},
 *  - die CDN-Location (fts.rbxcdn.com) liefert die Binärdaten ohne Key.
 *
 * Wird von tests/fixtures/start-stubbed-server.mjs installiert, BEVOR
 * src/server.js geladen wird.
 */

export const STUB_API_KEY = "stub-opencloud-key-123";
export const STUB_CDN_BINARY = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x52, 0x42, 0x58, 0x4d, 0x00, 0x01, 0x02, 0x03]);

/** UGC-Assets (Community-Creator → Asset-Delivery verlangt Authentifizierung). */
const UGC_ASSETS = new Set(["13576957688", "73553031478451", "126241427519956", "99060033706897"]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assetIdFromDeliveryUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const versioned = /^\/v[12]\/assetId\/(\d+)/.exec(url.pathname);
    if (versioned) return versioned[1];
    const id = url.searchParams.get("id");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function installStubRobloxFetch({ log = () => {} } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    let url;
    try { url = new URL(rawUrl); } catch { return realFetch(input, init); }

    // OpenCloud Asset-Delivery-API: nur mit korrektem x-api-key nutzbar.
    if (url.hostname === "apis.roblox.com" && url.pathname.startsWith("/asset-delivery-api/v1/assetId/")) {
      const match = /^\/asset-delivery-api\/v1\/assetId\/(\d+)(?:\/version\/(\d+))?/.exec(url.pathname);
      const assetId = match?.[1];
      if (headers.get("x-api-key") !== STUB_API_KEY) {
        log(`[stub] OpenCloud 401 für Asset ${assetId} (Key fehlt/falsch)`);
        return jsonResponse({ errors: [{ code: 0, message: "Invalid authentication data provided" }] }, 401);
      }
      log(`[stub] OpenCloud 200 für Asset ${assetId} (Key ok)`);
      return jsonResponse({ location: `https://fts.rbxcdn.com/sc2/stub-${assetId}?__token__=stub-token` });
    }

    if (url.hostname === "assetdelivery.roblox.com") {
      const assetId = assetIdFromDeliveryUrl(rawUrl);
      if (assetId && UGC_ASSETS.has(assetId)) {
        log(`[stub] assetdelivery 401 für UGC-Asset ${assetId}`);
        return jsonResponse({ errors: [{ code: 401, message: "Authentication required to access Asset." }] }, 401);
      }
      // Roblox-eigene Assets: unauthentifiziert verfügbare JSON-Locations-Envelope.
      if (assetId) {
        log(`[stub] assetdelivery 200 Envelope für Roblox-Asset ${assetId}`);
        return jsonResponse({
          locations: [{ assetFormat: "source", location: `https://fts.rbxcdn.com/sc2/stub-${assetId}?__token__=public-token` }],
          requestId: "stub-request", assetTypeId: 27,
        });
      }
      return jsonResponse({ errors: [{ code: 404, message: "Asset nicht gefunden" }] }, 404);
    }

    if (url.hostname === "fts.rbxcdn.com") {
      return new Response(STUB_CDN_BINARY, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }

    return realFetch(input, init);
  };
  return () => { globalThis.fetch = realFetch; };
}
