/**
 * Einmaliger Nachweis von Bug B (kein Teil der Testsuite, kein Netz nötig):
 *
 * Der öffentliche Asset-Delivery-Endpunkt beantwortet UGC-Anfragen teils mit
 * HTTP **200** und einem `{"errors":[…]}`-Body OHNE `locations`.
 * `API.Misc.getCDNURLFromAssetDelivery` der ECHTEN Bibliothek liest daraufhin
 * `data.locations[0].location` → TypeError „Cannot read properties of undefined
 * (reading '0')“, geworfen in eine Promise-Kette ohne `catch`
 * (`GetAssetBuffer` = `new Promise((resolve) => …then(resolve))`).
 *
 * Ergebnis: GetAssetBuffer löst NIE auf – exakt der „Zeitlimit 150 s“-Skip aus
 * der Produktion. Mit dem Ersatz aus src/library-guards.js löst derselbe Aufruf
 * sofort mit einer Response 502 auf.
 *
 *   node scripts/verify-bug-b.mjs
 */
import { readFileSync } from "node:fs";

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }),
  querySelector: () => null,
  querySelectorAll: () => [],
};
(0, eval)(readFileSync(new URL("../public/draco_decoder.js", import.meta.url), "utf8"));

const { API, FLAGS } = await import("roavatar-renderer");
const { patchGetCDNURLFromAssetDelivery } = await import("../src/library-guards.js");

// Die Bibliothek erzeugt eine unbehandelte Ablehnung (genau der pageerror) –
// für die Ausgabe abfangen, der Race-Timeout zeigt das Hängen.
process.on("unhandledRejection", (reason) => console.log("  (unbehandelte Ablehnung in der Bibliothek:", reason?.message || reason, ")"));

const errorsBody = JSON.stringify({ errors: [{ code: 401, message: "Authentication required to access Asset." }] });
// Produktionsnahes Proxy-Verhalten VOR dem Fix: HTTP 200 ohne locations.
FLAGS.FETCH_FUNC = () => Promise.resolve(new Response(errorsBody, {
  status: 200,
  headers: { "content-type": "application/json" },
}));
FLAGS.ENABLE_API_CACHE = false;

const race = (promise, label) => Promise.race([
  promise.then((result) => `aufgelöst: ${result?.constructor?.name ?? result}${result instanceof Response ? ` (HTTP ${result.status})` : ""}`,
    (error) => `rejected: ${error?.message}`),
  new Promise((resolve) => setTimeout(() => resolve(`NIE AUFGELÖST (Endlos-Hänger wie in Produktion) [${label}]`), 3000)),
]);

console.log("ORIGINAL (200 ohne locations):", await race(API.Asset.GetAssetBuffer("rbxassetid://99060033706897"), "original"));

patchGetCDNURLFromAssetDelivery(API, FLAGS);
console.log("MIT ERSATZ (200 ohne locations):", await race(API.Asset.GetAssetBuffer("rbxassetid://126241427519956"), "patched"));
process.exit(0);
