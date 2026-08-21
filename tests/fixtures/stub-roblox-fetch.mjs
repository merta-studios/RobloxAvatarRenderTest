/**
 * Stub für alle Roblox-Netzwerkaufrufe des Servers (nur für Tests).
 *
 * Reproduziert das in den Produktions-Logs vom 2026-08-21 BELEGTE Verhalten
 * von Roblox – nicht das, was man sich wünscht:
 *
 *  - Die OpenCloud Asset-Delivery-API (apis.roblox.com/asset-delivery-api)
 *    nimmt nur Anfragen mit korrektem `x-api-key` an und antwortet mit
 *    HTTP 200 + Location auf **contentdelivery.roblox.com**:
 *      https://contentdelivery.roblox.com/v1/bytes/sc2/<hash>?__token__=exp=…~acl=…~hmac=…
 *    (PR #15 stubte hier `fts.rbxcdn.com` – deshalb waren die Tests grün,
 *    während der Proxy in Produktion jede Location als „unerlaubter Host“
 *    verwarf. Genau dieser Fixture-Fehler hat den Bug überleben lassen.)
 *  - assetdelivery.roblox.com (öffentlich, ohne Cookie) liefert für UGC
 *    zwei real beobachtete Varianten:
 *      a) HTTP 401 „Authentication required to access Asset.“
 *      b) HTTP 200 mit einem `{"errors":[…]}`-Body OHNE `locations`
 *         → Bibliothek liest `data.locations[0].location` ⇒ TypeError
 *           „Cannot read properties of undefined (reading '0')“ ⇒ Endlos-Hänger.
 *  - Roblox-eigene Assets liefert der versionierte Endpunkt unauthentifiziert
 *    als JSON-Locations-Envelope (Location auf rbxcdn.com).
 *  - Die CDN-Locations (contentdelivery.roblox.com bzw. *.rbxcdn.com) liefern
 *    die Binärdaten ohne Key.
 *
 * Wird von tests/fixtures/start-stubbed-server.mjs installiert, BEVOR
 * src/server.js geladen wird.
 */

export const STUB_API_KEY = "stub-opencloud-key-123";
export const STUB_CDN_BINARY = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x52, 0x42, 0x58, 0x4d, 0x00, 0x01, 0x02, 0x03]);

/** Signierte OpenCloud-Location, exakt im Produktions-Format. */
export function stubOpenCloudLocation(assetId) {
  return `https://contentdelivery.roblox.com/v1/bytes/sc2/stub-${assetId}`
    + "?__token__=exp=1755777777~acl=%2f*~hmac=deadbeefdeadbeefdeadbeefdeadbeef";
}

/** UGC-Assets (Community-Creator → Asset-Delivery verlangt Authentifizierung). */
const UGC_ASSETS = new Set(["13576957688", "73553031478451", "126241427519956", "99060033706897"]);

/**
 * UGC-Asset, das der ÖFFENTLICHE Endpunkt mit HTTP 200 + Errors-Body OHNE
 * `locations` beantwortet (Bug B). Die übrigen UGC-Assets antworten dort mit 401.
 */
export const STUB_UGC_200_WITHOUT_LOCATIONS = "99060033706897";
/** UGC-Asset, das der öffentliche Endpunkt mit HTTP 401 beantwortet. */
export const STUB_UGC_401 = "13576957688";

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
      log(`[stub] OpenCloud 200 für Asset ${assetId} (Key ok) → contentdelivery.roblox.com`);
      return jsonResponse({
        locations: [{ assetFormat: "source", location: stubOpenCloudLocation(assetId) }],
        requestId: "stub-opencloud-request",
      });
    }

    if (url.hostname === "assetdelivery.roblox.com") {
      const assetId = assetIdFromDeliveryUrl(rawUrl);
      if (assetId && UGC_ASSETS.has(assetId)) {
        if (assetId === STUB_UGC_200_WITHOUT_LOCATIONS) {
          // Real beobachtet: Status 200, Body enthält NUR errors – kein `locations`.
          log(`[stub] assetdelivery 200 OHNE locations für UGC-Asset ${assetId} (Errors-Body)`);
          return jsonResponse({ errors: [{ code: 401, message: "Authentication required to access Asset." }] }, 200);
        }
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

    if (url.hostname === "contentdelivery.roblox.com" || url.hostname === "fts.rbxcdn.com") {
      // Signierte CDN-Auslieferung: kein Key nötig, aber Token erforderlich.
      if (!url.searchParams.has("__token__")) {
        log(`[stub] CDN 403 ohne __token__: ${rawUrl}`);
        return new Response("Missing token", { status: 403 });
      }
      if (headers.has("x-api-key")) {
        // Der Proxy darf den OpenCloud-Key niemals an das CDN weiterreichen.
        log(`[stub] CDN 400 – x-api-key darf apis.roblox.com nicht verlassen: ${rawUrl}`);
        return new Response("API-Key an CDN geleakt", { status: 400 });
      }
      return new Response(STUB_CDN_BINARY, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }

    return realFetch(input, init);
  };
  return () => { globalThis.fetch = realFetch; };
}
