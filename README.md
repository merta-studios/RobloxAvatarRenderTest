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
6. In den Logs müssen nacheinander `[http] HTTP: Port …`, die `[diagnose]`-Zeilen (DNS, TCP, REST-Probe), `[login] Versuch 1/3: Verbinde mit dem Discord-Gateway …`, `[gateway] Discord: eingeloggt als …` und `[commands] … Command(s) registriert …` erscheinen. **Die Netzwerk-Diagnose und der Gateway-Login passieren bewusst vor der Command-Registrierung** – erst wenn der Bot online ist, wird per REST registriert.
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
| `REST_TIMEOUT_SECONDS` | nein | `30` | Timeout pro REST-Anfrage, 5–300 Sekunden |
| `LOGIN_TIMEOUT_SECONDS` | nein | `60` | Maximale Zeit für den Gateway-Login, 10–600 Sekunden |
| `LOGIN_ATTEMPTS` | nein | `3` | Anzahl der Gateway-Login-Versuche beim Start, 1–10 |
| `LOGIN_BACKOFF_SECONDS` | nein | `5` | Wartezeit zwischen Login-Versuchen, 0–60 Sekunden |
| `DNS_RESULT_ORDER` | nein | `ipv4first` | DNS-Reihenfolge: `ipv4first` (Standard) behebt Verbindungs-Hänger in Containern ohne IPv6-Route; `verbatim` nutzt die System-Reihenfolge |
| `HEALTH_REQUIRE_DISCORD` | nein | `true` | `/health` antwortet mit 503, solange der Bot nicht mit Discord verbunden ist |
| `DISCORD_DEBUG` | nein | `false` | Ausführliche Debug-Logs von discord.js (REST/WebSocket) |

## Startreihenfolge, Timeouts und Diagnose

Beim Start passiert Folgendes – jede Phase loggt mit eigenem Tag und Zeitstempel:

1. **`[http]`** Der HTTP-Server öffnet den Port, damit der Render-Healthcheck erreichbar ist.
2. **`[diagnose]`** Vor dem Login wird die Netzwerkstrecke zu Discord geprüft: DNS-Auflösung von `gateway.discord.gg`, rohe TCP-Probe auf Port 443 und REST-Probe auf `https://discord.com/api/v10/gateway` – jeweils mit eigenem Zeitlimit und Log. Damit ist sofort sichtbar, auf welcher Ebene eine Verbindung hängt (DNS → TCP → TLS/REST → WebSocket).
3. **`[login]`** Der Bot verbindet sich mit dem **Discord-Gateway**. Es gibt bis zu `LOGIN_ATTEMPTS` Versuche (Standard 3, Abstand `LOGIN_BACKOFF_SECONDS`); jeder Versuch nutzt einen frischen Client und hat das Timeout `LOGIN_TIMEOUT_SECONDS`. Erst nach dem letzten fehlgeschlagenen Versuch wird der Prozess mit Fehlercode 1 beendet, damit Render den Container neu starten kann. So hängt der Bot nie lautlos fest.
4. **`[commands]`** Erst nach erfolgreichem Login wird der Slash-Command per REST registriert. Jede einzelne REST-Anfrage hat ein Timeout (`REST_TIMEOUT_SECONDS`), die gesamte Registrierung zusätzlich eine harte Deadline (3 Versuche à Timeout plus Puffer). Scheitert die Registrierung, **bleibt der Bot online** und der Fehler ist in Logs und `/health` sichtbar.

Gateway-Ereignisse (Reconnect, Disconnect, Shard-Fehler, Warnungen) werden unter `[gateway]` bzw. `[discord]` geloggt. Während der Login-Phase laufen die rohen discord.js-Debug-Logs automatisch mit (`[debug]`); dauerhaft lassen sie sich mit `DISCORD_DEBUG=true` aktivieren, Fehler werden dann zusätzlich mit allen Details ausgegeben. Bot-Tokens werden in Logs und Health-Antworten grundsätzlich geschwärzt (`[REDACTED]`).

### IPv4 zuerst

Standardmäßig startet der Prozess mit `dns.setDefaultResultOrder("ipv4first")` und schaltet Node's „Happy Eyeballs“-Versuch ab (`net.setDefaultAutoSelectFamily(false)`). In Containern ohne IPv6-Route verhindert das bekannte Verbindungs-Hänger zum Discord-Gateway (Node 22 versucht sonst zuerst IPv6). Über `DNS_RESULT_ORDER=verbatim` lässt sich auf die System-Reihenfolge umschalten.

**Healthcheck:** `GET /health` liefert standardmäßig **503**, solange der Bot nicht mit Discord verbunden ist, und **200**, sobald er bereit ist. Die Antwort enthält den Discord-Status (User, Ping, Gateway, letzter Fehler) sowie den Stand der Command-Registrierung:

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

Damit markiert Render den Service als ungesund, wenn der Bot nicht online ist – statt wie bisher ein „ok“ zu melden, obwohl der Bot nie verbunden war. Falls Render den Service dadurch zu aggressiv neu startet (z. B. während Discord-Ausfällen), kann der Healthcheck mit `HEALTH_REQUIRE_DISCORD=false` wieder auf „immer ok“ gestellt werden; der Discord-Status bleibt in der Antwort trotzdem sichtbar.

## Troubleshooting: Bot bleibt offline / Login hängt

Bleiben die Logs bei `[login] Versuch … Verbinde mit dem Discord-Gateway …` stehen, zeigen die `[diagnose]`-Zeilen vom Start, auf welcher Ebene die Verbindung hängt:

- **DNS** (`[diagnose] DNS gateway.discord.gg: …`): Fehler oder nur IPv6-Adressen → DNS-/Netzwerkproblem im Container.
- **TCP** (`[diagnose] TCP gateway.discord.gg:443 …`): `FEHLER` oder Timeout → Port 443 ist aus dem Container nicht erreichbar (Egress-Block, Region).
- **REST** (`[diagnose] REST https://discord.com/api/v10/gateway: HTTP …`): Scheitert bereits TLS/REST, liegt es an der Netzstrecke oder einem Proxy dazwischen.
- Sind DNS, TCP und REST in Ordnung, hängt aber der WebSocket-Login trotzdem, ist das ein bekanntes Muster auf Cloud-Plattformen (Node 22 versucht IPv6 zuerst; Container ohne IPv6-Route bleiben hängen – identische Symptome wurden z. B. von Railway-Nutzern berichtet, dort half teils ein Regionswechsel). Dagegen wirken `DNS_RESULT_ORDER=ipv4first` (Standard), die automatischen `[debug]`-Logs während der Login-Phase und gegebenenfalls ein Regionswechsel auf Render.

Im Render-Service per Shell testen:

```bash
curl -v --max-time 10 https://discord.com/api/v10/gateway
node -e "const s=require('net').connect(443,'gateway.discord.gg');s.setTimeout(5000,()=>{console.log('TCP-Timeout');process.exit(1)});s.on('connect',()=>console.log('TCP ok'));s.on('error',e=>console.log('TCP-Fehler:',e.message))"
curl -s localhost:10000/health
```

`curl -v` zeigt TLS-Fehler, die Node-Probe testet die rohe TCP-Verbindung zu Port 443, und `/health` meldet den laufenden Login-Versuch samt `lastLoginError`.

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

## Lizenz

GPL-3.0-only, weil `roavatar-renderer` unter GPL-3.0-only eingebunden ist. Siehe `LICENSE`.
