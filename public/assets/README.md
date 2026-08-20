# Lokale Renderer-Assets

Diese Dateien sind die statischen „roavatar“-Assets (R15/R6-Rigs, Composit-Meshes,
Kopf-/Körper-Meshes, Standard-Gesichtstextur, Partikeltexturen) aus dem
[RoAvatar-Projekt](https://github.com/steinann/RoAvatar) (GPL-3.0), das vom
Autor von `roavatar-renderer` gepflegt wird.

**Warum liegen sie hier lokal statt online?**

Seit Roblox (April 2025) unauthentifizierte Asset-Delivery-Anfragen einschränkt,
antwortet `assetdelivery.roblox.com/v1|v2/asset?id=…` für die privaten
Bibliotheks-Assets des Renderers mit HTTP 401
(`Authentication required to access Asset.`). Der Bot hat – bewusst – keinen
Roblox-Cookie und kann diese Assets daher nicht mehr online laden. Der Renderer
wird deshalb mit `FLAGS.ONLINE_ASSETS = false`, `FLAGS.ASSETS_PATH = "/assets/rbxasset/"`
und `FLAGS.RIG_PATH = "/assets/"` betrieben; die statischen Dateien werden beim
Build von Vite aus `public/` nach `dist/` kopiert und vom Bot selbst ausgeliefert.

Die eigentlichen Avatar-Assets des gerenderten Users (Kleidung, Körperteile,
Accessoires, Animationen) kommen weiterhin live von Roblox – über den
versionierten Asset-Delivery-Endpunkt `assetdelivery.roblox.com/v2/assetId/{id}/version/{version}`.

Quelle: <https://github.com/steinann/RoAvatar/tree/master/public/assets> (Stand 2026-08-20, v1.6.2)
