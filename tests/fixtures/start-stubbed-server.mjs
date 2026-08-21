#!/usr/bin/env node
/**
 * Startet den ECHTEN Server (src/server.js), aber mit gestubbtem Roblox-Netzwerk
 * (tests/fixtures/stub-roblox-fetch.mjs). Nur für Tests – der Stub wird
 * installiert, BEVOR der Server geladen wird, damit jede fetch()-Anfrage des
 * Proxys und der OpenCloud-Key-Probe über den Stub läuft.
 *
 * Erforderliche Env: PORT, SKIP_DISCORD=true; optional ROBLOX_OPENCLOUD_API_KEY.
 */
import { installStubRobloxFetch } from "./stub-roblox-fetch.mjs";

installStubRobloxFetch({ log: (line) => console.log(new Date().toISOString(), line) });

await import("../../src/server.js");
