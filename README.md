# Roblox Avatar Render Test – Discord Bot

Ein ressourcenschonender Discord-Bot für `/render_avatar username:<USERNAME>`. Der Bot lädt die **echte Avatar-Konfiguration und die zugehörigen 3D-Assets** von Roblox, baut den Avatar in einer lokalen Three.js/WebGL-Szene zusammen und sendet das selbst gerenderte PNG an Discord.

> **Keine Thumbnail API:** Dieses Projekt ruft weder `thumbnails.roblox.com` noch einen Roblox-Endpunkt zur Erzeugung eines fertigen Avatarbildes/3D-Thumbnails auf.

## Funktionen

- Slash Command nur für Discord-Administratoren
- Username-Auflösung über `users.roblox.com`
- Avatar-Konfiguration über `avatar.roblox.com`
- Meshes, Texturen, Rig und Accessoires über `assetdelivery.roblox.com` und `rbxcdn.com`
- lokale 640×640-PNG-Erzeugung mit RoAvatar-Renderer, Three.js und Headless Chromium
- Status-Updates in Discord bei jedem Arbeitsschritt plus Heartbeat alle 12 Sekunden
- globaler In-Process-Lock: immer nur **ein** Render gleichzeitig
- sofortige, private Ablehnung weiterer Aufträge
- Zeitlimits, Asset-Größenlimit, eingeschränkter Roblox-Proxy und garantierte Browser-Bereinigung
- `/health` für Render, abhängig vom Discord-Verbindungsstatus
- ausführliche Diagnose-Logs mit Zeitstempel und Phasen-Tags (`[diagnose]`, `[login]`, `[gateway]`, `[commands]`, …)

## Warum nicht „Avatar als OBJ herunterladen“?

Roblox liefert die einzelnen Avatar-Assets über Asset Delivery überwiegend als Roblox-Modelle (`RBXM`) und Meshes im Roblox-eigenen Format – nicht als fertige, zusammengesetzte OBJ-Datei. Eine OBJ-Datei des vollständigen Avatars bekommt man bequem nur über Robloxs **3D-Thumbnail-Pipeline**; genau diese soll hier ausdrücklich nicht benutzt werden.

Deshalb ist der technisch saubere Weg in diesem Test:

1. Username in User-ID umwandeln.
2. Aktuelle Avatar-Definition abrufen.
3. Rig, Body Parts, Accessoires, Meshes und Texturen einzeln über Asset Delivery laden.
4. Roblox-Dateien im Browser parsen und den Avatar zusammensetzen.
5. Das Ergebnis selbst mit WebGL rendern.

Das erfüllt die Vorgabe ohne Thumbnail API. Layered Clothing und sehr komplexe neue Assets sind deutlich aufwendiger als ein fertiges OBJ und können auf Robloxs kleinstem Tarif lange dauern.

## Discord-Bot erstellen

1. Öffne das [Discord Developer Portal](https://discord.com/developers/applications) und klicke **New Application**.
2. Unter **Bot** einen Bot erstellen und den Token kopieren.
3. Unter **General Information** die **Application ID** kopieren.
4. Unter **OAuth2 → URL Generator** auswählen:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Attach Files`, `Use Application Commands`
5. Den generierten Link öffnen und den Bot auf den Testserver einladen.
6. Im Discord-Client den Developer Mode aktivieren, den Testserver rechtsklicken und die **Server ID** kopieren.

Der Bot braucht **keinen Roblox-Cookie**. Niemals `.ROBLOSECURITY` als Environment Variable hinterlegen.

## Deployment auf Render

### Empfohlen: Blueprint

1. Dieses Repository zu GitHub pushen.
2. Im Render Dashboard **New → Blueprint** wählen.
3. Repository auswählen. Render erkennt `render.yaml` und baut den Docker-Service.
4. Folgende Secret-Variablen eintragen:

| Variable | Wert |
|---|---|
| `DISCORD_TOKEN` | Bot Token aus dem Discord Developer Portal |
| `DISCORD_APPLICATION_ID` | Application ID |
| `DISCORD_GUILD_ID` | ID des Testservers (empfohlen) |

5. Deploy starten.
6. In den Logs müssen nacheinander `[http] HTTP: Port …`, die `[diagnose]`-Zeilen (DNS, TCP), `[preflight] Token akzeptiert …` **oder** `[preflight] Discord-REST nicht nutzbar … Gateway-Login läuft trotzdem`, `[login] Versuch 1: Verbinde mit dem Discord-Gateway …`, `[gateway] Discord: eingeloggt als …` erscheinen. Command-Registrierung folgt danach; bei 1015 wird sie im Hintergrund wiederholt. **Login vor REST-Registrierung** – der Bot darf nicht offline bleiben, nur weil Cloudflare `discord.com` sperrt.
7. Auf dem Testserver `/render_avatar username:Builderman` ausprobieren.

Mit `DISCORD_GUILD_ID` erscheint der Command normalerweise sofort. Ohne diese Variable wird er global registriert; globale Discord-Commands können verzögert sichtbar werden.

### Manuelle Render-Einstellungen

Falls kein Blueprint verwendet wird:

- Service Type: **Web Service**
- Runtime: **Docker**
- Dockerfile: `./Dockerfile`
- Health Check Path: `/health`
- Instanzen: **genau 1**
- Environment Variables wie oben

Nicht horizontal skalieren: Der Ein-Auftrag-Lock ist absichtlich im Prozessspeicher. Zwei Instanzen könnten je einen Render gleichzeitig annehmen.

## Ressourcen auf 0,1 CPU / 500 MB RAM

Die Konfiguration ist auf den kleinen Testtarif ausgerichtet:

- Chromium wird nur für einen Auftrag gestartet und danach immer geschlossen.
- Nur ein Chromium-Renderer-Prozess und nur ein Avatar gleichzeitig.
- 640×640, Device Scale 1, kein Post Processing und kein Hidden Surface Removal.
- Layered-Clothing-Worker sind deaktiviert, damit keine Parallel-Last entsteht.
- **Kein permanenter WebGL-Renderloop:** WebGL läuft in der Cloud über SwiftShader (reines Software-Rendering). Ein fortlaufender `requestAnimationFrame`-Loop würde auf 0,1 CPU den kompletten Browser-Thread blockieren, sodass Downloads und Mesh-Parsing verhungern und jeder Render ins Zeitlimit läuft. Der Renderer zeichnet deshalb genau **einen finalen Frame**, nachdem alle Assets kompiliert sind.
- **Harte Zeitlimits pro Anfrage:** Jeder Asset-Download im Renderer hat ein 60-Sekunden-Limit (über den Proxy). Ein einzelner hängender Request blockiert nie den ganzen Render.
- **Fortschritts-Watchdog:** Bleibt der Render 240 s ohne jede Bewegung in einer Phase hängen, bricht er mit einer konkreten Fehlermeldung ab (Phase + zuletzt geladenes Asset) statt 420 s lang still zu warten.
- **Phasen-Logs:** Jede Render-Phase wird mit Laufzeit in den Server-Logs protokolliert (`[render] userId=… Phase assets – … (+42 s)`). Bei einem Timeout nennt die Discord-Antwort die letzte Phase.
- Node-Heap ist im Container auf 160 MB begrenzt.
- Jeder einzelne Proxy-Download ist standardmäßig auf 30 MB begrenzt.
- Render-Timeout: 420 Sekunden.

Das verhindert unkontrollierte Parallelität, ist aber keine Garantie, dass jeder extrem komplexe Avatar unter 500 MB gerendert werden kann. Bei OOM zuerst `MAX_ASSET_MB` nicht erhöhen, komplexe Layered-Clothing-Avatare testen und gegebenenfalls einen größeren Render-Tarif nutzen. 0,1 CPU bedeutet außerdem, dass ein Render mehrere Minuten dauern kann.

## Variablen

Siehe `.env.example`.

| Variable | Pflicht | Standard | Beschreibung |
|---|---:|---:|---|
| `DISCORD_TOKEN` | ja | – | Discord Bot Token |
| `DISCORD_APPLICATION_ID` | ja | – | Discord Application ID |
| `DISCORD_GUILD_ID` | nein | – | Testserver für sofortige Command-Registrierung |
| `PORT` | bei Render automatisch | `10000` | HTTP-/Health-Port |
| `CHROMIUM_PATH` | nein | `/usr/bin/chromium` | Chromium im Docker-Image |
| `RENDER_TIMEOUT_SECONDS` | nein | `420` | 60–840 Sekunden |
| `MAX_ASSET_MB` | nein | `30` | Maximalgröße je Roblox-Asset, 5–60 MB |
| `REST_TIMEOUT_SECONDS` | nein | `20` | Timeout pro REST-Anfrage, 5–300 Sekunden |
| `LOGIN_TIMEOUT_SECONDS` | nein | `90` | Maximale Zeit für den Gateway-Login, 10–600 Sekunden |
| `LOGIN_ATTEMPTS` | nein | `0` | Gateway-Login-Versuche; `0` = unbegrenzt weiterversuchen (empfohlen), sonst 1–100 |
| `LOGIN_BACKOFF_SECONDS` | nein | `5` | Start-Wartezeit zwischen Login-Versuchen, 0–60 Sekunden (verdoppelt sich) |
| `LOGIN_BACKOFF_MAX_SECONDS` | nein | `300` | Obergrenze für das Backoff, 5–3600 Sekunden |
| `AUTO_SELECT_FAMILY` | nein | `false` | Node „Happy Eyeballs“ (paralleles IPv4/IPv6-Verbinden) wieder aktivieren |
| `DNS_RESULT_ORDER` | nein | `ipv4first` | DNS-Reihenfolge: `ipv4first` (Standard) behebt Verbindungs-Hänger in Containern ohne IPv6-Route; `verbatim` nutzt die System-Reihenfolge |
| `HEALTH_REQUIRE_DISCORD` | nein | `false` | Wenn `true`, antwortet `/health` mit 503, solange der Bot nicht mit Discord verbunden ist |
| `DISCORD_DEBUG` | nein | `false` | Ausführliche Debug-Logs von discord.js (REST/WebSocket) |

## Startreihenfolge, Timeouts und Diagnose

Beim Start passiert Folgendes – jede Phase loggt mit eigenem Tag und Zeitstempel:

1. **`[http]`** Der HTTP-Server öffnet den Port, damit der Render-Healthcheck erreichbar ist.
2. **`[diagnose]`** Vor dem Login wird die Netzwerkstrecke zu Discord geprüft: DNS-Auflösung von `gateway.discord.gg` und rohe TCP-Probe auf Port 443. **Kein** unauthentifizierter REST-Call auf `/gateway` – genau der hat auf Render-Free-IPs Cloudflare 1015 ausgelöst und die Sperre verlängert.
3. **`[preflight]`** `GET /gateway/bot` mit Bot-Token, nacheinander über `discord.com`, `canary.discord.com`, `ptb.discord.com` und `discordapp.com`. 401 bricht ab. **HTTP 429 / Cloudflare 1015 überspringt den Login nicht** – der Bot geht trotzdem auf das Gateway. Betroffene Hosts kommen in den echten `Retry-After`-Cooldown (Header, nicht das JSON-Feld 30 s).
4. **`[login]`** Gateway-WebSocket. Wenn REST 1015 liefert, nutzt discord.js intern den Fallback `wss://gateway.discord.gg` statt 6 Stunden auf `/gateway/bot` zu warten. `ClientReady` ist nötig, damit der Bot als online gilt. Backoff nur, wenn auch der WebSocket scheitert.
5. **`[commands]`** Erst nach erfolgreichem Login wird der Slash-Command per REST registriert. Jede einzelne REST-Anfrage hat ein Timeout (`REST_TIMEOUT_SECONDS`), die gesamte Registrierung zusätzlich eine harte Deadline (3 Versuche à Timeout plus Puffer). Scheitert die Registrierung, **bleibt der Bot online** und der Fehler ist in Logs und `/health` sichtbar.

Gateway-Ereignisse (Reconnect, Disconnect, Shard-Fehler, Warnungen) werden unter `[gateway]` bzw. `[discord]` geloggt. Während der Login-Phase laufen die rohen discord.js-Debug-Logs automatisch mit (`[debug]`); dauerhaft lassen sie sich mit `DISCORD_DEBUG=true` aktivieren, Fehler werden dann zusätzlich mit allen Details ausgegeben. Bot-Tokens werden in Logs und Health-Antworten grundsätzlich geschwärzt (`[REDACTED]`).

### IPv4 zuerst

Standardmäßig startet der Prozess mit `dns.setDefaultResultOrder("ipv4first")` und schaltet Node's „Happy Eyeballs“-Versuch ab (`net.setDefaultAutoSelectFamily(false)`, wieder aktivierbar über `AUTO_SELECT_FAMILY=true`). In Containern ohne IPv6-Route verhindert das bekannte Verbindungs-Hänger zum Discord-Gateway (Node 22 versucht sonst zuerst IPv6). Über `DNS_RESULT_ORDER=verbatim` lässt sich auf die System-Reihenfolge umschalten.

**Healthcheck:** `GET /health` liefert standardmäßig **200**, sobald der HTTP-Server läuft – auch während der Bot noch auf Discord wartet. Das ist Absicht: Ein 503 lässt Render den Container töten und erzeugt eine Neustart-Schleife, in der der Bot nie online kommt. Mit `HEALTH_REQUIRE_DISCORD=true` antwortet `/health` wie früher mit 503, solange Discord nicht verbunden ist. Die Antwort enthält den Discord-Status (User, Ping, Gateway, letzter Fehler) sowie den Stand der Command-Registrierung:

```json
{
  "ok": true,
  "busy": false,
  "job": null,
  "uptime": 42,
  "discord": { "ready": true, "status": "ready", "user": "MeinBot#0000", "ping": 41, "lastError": null, "lastLoginError": null },
  "commands": { "state": "registered", "target": "Guild 123", "count": 1, "durationMs": 812 }
}
```

Der tatsächliche Verbindungsstand steht immer im Feld `discord` (`status`, `loginAttempt`, `nextRetryAt`, `lastPreflight`, `lastLoginError`) – auch wenn der Healthcheck 200 meldet.

## Troubleshooting: Bot bleibt offline / Login hängt

Typisches Log-Muster: `[login] Versuch 1/3: Verbinde mit dem Discord-Gateway …`, dann `[debug] Preparing to connect to the gateway...` und danach nichts mehr bis zum Timeout. Das heißt praktisch immer: **die REST-Anfrage `/gateway/bot`, die discord.js intern vor dem WebSocket macht, kommt nicht durch.** Die `[preflight]`-Zeile zeigt jetzt den Grund im Klartext:

| Log-Zeile | Bedeutung | Lösung |
|---|---|---|
| `[preflight] Discord lehnt den Token ab (HTTP 401 …)` | Token falsch, abgelaufen oder mit Präfix/Leerzeichen kopiert | Im Developer Portal **Bot → Reset Token**, neuen Wert in Render als `DISCORD_TOKEN` speichern (ohne `Bot `-Präfix, ohne Anführungszeichen) und Service neu deployen |
| `cloudflare-error=1015` / `HTTP 429` | Rate Limit auf der (geteilten) Ausgangs-IP – auf Render Free häufig | Warten (der Bot versucht es mit wachsendem Backoff selbst weiter), Region wechseln oder auf einen kostenpflichtigen Plan mit anderer IP gehen |
| `cloudflare-error=1010` / HTML-Antwort | Anfrage wurde von Cloudflare geblockt (z. B. wegen unpassendem User-Agent) | Ist im Code behoben: alle Anfragen laufen mit gültigem `DiscordBot`-User-Agent |
| `[preflight] … nicht erreichbar: … fetch failed` | Egress-Block, Proxy oder TLS-Problem im Container | Netzwerk/Region prüfen, `curl` aus der Render-Shell testen (siehe unten) |
| `[preflight] Token akzeptiert …`, aber der Gateway-Login läuft ins Timeout | WebSocket-Strecke ist blockiert oder IPv6 hängt | `DNS_RESULT_ORDER=ipv4first` (Standard) beibehalten, ggf. Region wechseln, `DISCORD_DEBUG=true` setzen |

Die `[diagnose]`-Zeilen vom Start zeigen zusätzlich, auf welcher Ebene es hakt:

- **DNS** (`[diagnose] DNS gateway.discord.gg: …`): Fehler oder nur IPv6-Adressen → DNS-/Netzwerkproblem im Container.
- **TCP** (`[diagnose] TCP gateway.discord.gg:443 …`): `FEHLER` oder Timeout → Port 443 ist aus dem Container nicht erreichbar (Egress-Block, Region).
- **REST** (`[diagnose] REST /gateway: HTTP …`): Kommt hier HTML statt JSON zurück, steht der genaue Cloudflare-Fehlercode samt `cf-ray` im Log.

Im Render-Service per Shell testen:

```bash
curl -v --max-time 10 -H 'User-Agent: DiscordBot (https://example.com, 1.0.0)' https://discord.com/api/v10/gateway
curl -s --max-time 10 -H "Authorization: Bot $DISCORD_TOKEN" -H 'User-Agent: DiscordBot (https://example.com, 1.0.0)' https://discord.com/api/v10/users/@me
curl -s localhost:10000/health
```

Liefert `/users/@me` ein JSON mit der Bot-ID, ist der Token in Ordnung; kommt `401`, muss der Token erneuert werden. `/health` zeigt den laufenden Versuch samt `lastPreflight` und `lastLoginError`.

## Lokal entwickeln

Voraussetzungen: Node.js 22+ und Chromium.

```bash
cp .env.example .env
# Werte in .env eintragen und exportieren, z. B. mit deiner Shell
npm install
npm test
npm run build
npm start
```

Der produktive Server liest `.env` nicht automatisch. Lokal die Werte in der Shell exportieren; bei Render werden sie im Dashboard gesetzt.

## Troubleshooting: „Der Render hat das Zeitlimit überschritten“

Der Fehler kommt mit Zusatzinfo, z. B. `… (letzte Phase: „assets“, zuletzt: „Originale Roblox-Assets und Meshes werden geladen …“)`. So liest man das:

- **`unbekannt`** – Der Renderer-Code ist nie angelaufen (es wurde keine Phase gemeldet). Klassischer Grund war ein fehlendes `draco_decoder.js`: `roavatar-renderer` erwartet das globale `DracoDecoderModule` aus diesem klassischen Script, das VOR dem gebündelten Modul geladen werden muss (liegt unter `public/`, wird von Vite nach `dist/` kopiert und in `index.html` eingebunden). Der Bot meldet hier inzwischen den konkreten Seitenfehler (`Der Renderer konnte nicht initialisiert werden: …`); in den Render-Logs steht zusätzlich `Renderer page error`.
- **`browser`** – Chromium selbst ist nicht gestartet. Render-Logs prüfen (`[render]`), meist Speicher-Problem beim Start.
- **`setup`** – WebGL2-Kontext konnte nicht erstellt werden. Sehr unwahrscheinlich mit SwiftShader; Render-Logs prüfen.
- **`profile`** – `avatar.roblox.com` nicht erreichbar oder der User blockiert die Avatar-Auskunft.
- **`assets`** – Ein Asset-Download hängt oder scheitert (Roblox-Rate-Limit, moderiert/gelöscht, zu groß). In den Logs steht dank Fortschritts-Watchdog nach 240 s das konkrete Asset: `Kein Fortschritt … (zuletzt geladen: getAssetBufferInternal-rbxassetid://123…)`. Die Fehlermeldung `Mindestens ein Avatar-Asset konnte nicht verarbeitet werden.` nennt seit dem Fix zusätzlich die Fehlerstufe (`rig` = lokale Renderer-Assets fehlen, `humanoidDescription` = ein getragenes Asset scheitert, `renderDesc` = ein Mesh kompiliert nicht).
- **`finalize`** – Szene war fertig, aber das finale Bild konnte nicht gezeichnet werden (Speicher).

Alle Phasen werden mit Laufzeit geloggt (`[render] userId=… Phase … (+42 s)`), sodass man in den Render-Logs genau sieht, wo die Zeit hingeht. Ergänzend kann es die Fehlermeldung `Chromium ist während des Renders abgestürzt` geben — das ist praktisch immer das Speicherlimit des freien Tarifs.

## Verhalten und Grenzen

- Der Command erwartet den eindeutigen Roblox-**Username**, nicht den Display Name.
- Private/moderierte/gelöschte Assets oder temporäre Roblox-Rate-Limits können einen Render verhindern.
- Roblox kann seine Legacy-Web-APIs ohne Vorankündigung ändern.
- Einige besonders neue Dynamic Heads, Partikel oder Layered-Clothing-Kombinationen können vom Open-Source-Renderer noch nicht perfekt dargestellt werden.
- Der Lock gilt für genau eine laufende Service-Instanz.
- Render Free Services können bei Inaktivität schlafen. Ein dauerhaft verbundener Discord-Bot benötigt je nach aktuellem Render-Angebot eventuell einen kostenpflichtigen Always-on-Service.

## Sicherheit

- Keine Roblox-Cookies oder Benutzer-Credentials.
- `/roblox-proxy` akzeptiert nur HTTPS-Ziele auf fest erlaubten Roblox-/RBXCDN-Hosts.
- Asset-Größen- und Netzwerk-Zeitlimits begrenzen Speicherverbrauch.
- Discord prüft die Administratorberechtigung sowohl bei der Command-Definition als auch zur Laufzeit.

## Woher kommen die Assets?

Roblox verlangt seit April 2025 für die alten, unversionierten Asset-Delivery-Endpunkte
(`assetdelivery.roblox.com/v1|v2/asset?id=…`) zunehmend Authentifizierung
(HTTP 401, „Authentication required to access Asset.“). Der Bot hat bewusst keinen
Roblox-Cookie – deshalb lädt er Assets auf zwei cookie-freien Wegen:

1. **Statische Renderer-Assets lokal:** Das Basis-Rig (R15/R6), die Composit-Meshes,
   Standard-Kopfmeshes und -Texturen kommen aus `public/assets/`. Diese Dateien
   stammen aus dem [RoAvatar-Projekt](https://github.com/steinann/RoAvatar)
   (GPL-3.0, gleicher Autor wie `roavatar-renderer`). Der Renderer läuft mit
   `FLAGS.ONLINE_ASSETS = false` und holt sie über `/assets/…` vom Bot selbst –
   genau diese Assets antworteten online nur noch mit 401 und verursachten
   „Render fehlgeschlagen – Mindestens ein Avatar-Asset konnte nicht verarbeitet werden.“
2. **Avatar-Assets des Users versioniert:** Kleidung, Körperteile, Accessoires,
   Animationen und Texturen werden weiterhin live von Roblox geladen. Die
   Avatar-API liefert zu jedem getragenen Asset die `currentVersionId` mit; der
   Renderer schreibt Asset-Anfragen auf den versionierten Endpunkt
   `assetdelivery.roblox.com/v2/assetId/{id}/version/{version}` um
   (`src/asset-urls.js`), der ohne Cookie funktioniert. Assets ohne bekannte
   Version (z. B. Texturen in älteren Katalog-Assets) laufen weiter über den
   Legacy-Endpunkt, solange Roblox ihn bedient.

## Lizenz

GPL-3.0-only, weil `roavatar-renderer` unter GPL-3.0-only eingebunden ist. Siehe `LICENSE`.
Die statischen Renderer-Assets in `public/assets/` stammen aus
[steinann/RoAvatar](https://github.com/steinann/RoAvatar) (GPL-3.0) – siehe
`public/assets/README.md`.
