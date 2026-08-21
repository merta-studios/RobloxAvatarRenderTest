/**
 * Einmaliger Nachweis des Produktionsfehlers (kein Teil der Testsuite):
 * Simuliert das ALTE Proxy-Verhalten (OpenCloud-Nachladung streamte die rohen
 * Binärdaten für assetdelivery/v2-Anfragen) gegen die ECHTE Bibliothek.
 * Ergebnis: GetAssetBuffer löst NIE auf – genau der „Asset fehlt nach 150 s
 * Guard-Deadline“-Fehler aus der Produktion.
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

// Die Bibliothek erzeugt eine unbehandelte Ablehnung (genau der Fehler) –
// für die Ausgabe unterdrücken, der Race-Timeout zeigt das Hängen.
process.on("unhandledRejection", (reason) => console.log("  (unbehandelte Ablehnung in der Bibliothek:", reason?.message || reason, ")"));

const binary = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x52, 0x42, 0x58, 0x4d]);

// ALTES Proxy-Verhalten: assetdelivery/v2-Anfrage → rohe Binärdaten (200).
FLAGS.FETCH_FUNC = (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("assetdelivery.roblox.com/v2/")) {
    return Promise.resolve(new Response(binary, { status: 200, headers: { "content-type": "application/octet-stream" } }));
  }
  return Promise.resolve(new Response(binary, { status: 200 }));
};

const outcome = await Promise.race([
  API.Asset.GetAssetBuffer("rbxassetid://13576957688").then(
    (result) => `aufgelöst: ${result?.constructor?.name}`,
    (error) => `rejected: ${error?.message}`,
  ),
  new Promise((resolve) => setTimeout(() => resolve("NIE AUFGELÖST (Endlos-Hänger wie in Produktion)"), 3000)),
]);
console.log("ALTES Verhalten (Binary statt Envelope):", outcome);
process.exit(0);
