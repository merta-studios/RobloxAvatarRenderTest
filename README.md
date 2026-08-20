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
- `/health` für Render

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
6. In den Logs müssen nacheinander `HTTP: Port ...`, `Discord-Command registriert` und `Discord: eingeloggt als ...` erscheinen.
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
