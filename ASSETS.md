# BLOCKOUT — Asset Manifest & Licences

Runtime-loaded assets referenced by the game code. Appearance is separate from
abilities: nothing here grants gameplay stats.

| Asset | Path | Used by | Licence | Author / Source |
| --- | --- | --- | --- | --- |
| Soccer player rig | `3d/soap_soccer_player.glb` | `js/realplayer.js`, `js/models.js` | CC-BY-4.0 | luccacatalan (Sketchfab) |
| Athlete body + 37 clips | `3d/athlete.glb` | `js/athlete.js` | CC0-1.0 | Quaternius — Universal Animation Library 1 + 2 |
| Fonts: Anton, Barlow, Barlow Condensed (7 × woff2, Latin) | `fonts/*.woff2` | `css/broadcast.css` | SIL OFL 1.1 (`fonts/OFL.txt`) | The Anton Project Authors; The Barlow Project Authors (via @fontsource on npm) |
| postprocessing 6.33.4 (pmndrs) | `lib/postprocessing.min.js` (bundled for three r147 as `window.POSTPROCESSING`) | `js/post.js` (MEDIUM/HIGH quality) | Zlib (`lib/postprocessing.LICENSE.md`) | Raoul van Rüschen (npm `postprocessing`, github.com/pmndrs/postprocessing) |
| PeerJS 1.5.5 (WebRTC helper) | `lib/peerjs.min.js` | `js/net.js` (loaded only when FRIEND MATCH is used) | MIT (`lib/peerjs.LICENSE`) | Michelle Bu, Eric Zhang (npm `peerjs`) |
| Menu music (5 tracks) | `audio/menu/*.mp3` | `js/menu-music.js` | See note below | Google generative AI |

## Generated in code (Build 3, no new files)

- **Garments** (`js/garments.js`): clothing shells cut from the CC0 athlete body and
  kit textures painted on a canvas at runtime.
- **Fan bodies** (`js/fanbody.js`): rigid, simplified parts of the CC0 athlete body.
- **Street folk** (`js/living.js`) and **street life** (`js/streetlife.js`: pigeons, steam,
  festoon lights, food cart, litter): built from primitives and canvas textures.
- No new third-party assets; credited in ABOUT → CREDITS → KITS.

## Athlete body (Phase 11)

- **File:** `3d/athlete.glb` (1.6 MB): the UAL mannequin (realistic proportions,
  65-bone humanoid skeleton) plus 37 authored clips: idle, walk, jog, sprint,
  back-pedal, strafes, turning leans, kick, slide tackle, hits, knock-downs and
  get-ups, celebrations and dejection.
- **Source:** Quaternius, *Universal Animation Library* and *Universal Animation
  Library 2* (Unreal-Godot GLB exports), obtained from the CC0 mirror
  github.com/tilakpatell/tilakverse-assets (packs "exactly as downloaded").
- **Licence:** CC0 1.0 (public domain). No attribution required; credited anyway
  in ABOUT → CREDITS.
- **Rebuild:** `node tools/build-athlete.mjs UAL1.glb UAL2.glb 3d/athlete.glb`
  (needs `@gltf-transform/core`, `/functions` and `/extensions`).
- Kits, faces, hair and shirt numbers are generated in code (`js/athlete.js`).

## Menu music

- **Files:** `Concrete Turf`, `Feel The Light`, `Inside My Head`, `Le Titane`,
  `Otra Vez` (`audio/menu/*.mp3`, ~12 min total).
- **Source:** every file carries valid C2PA Content Credentials signed by
  Google ("Created by Google Generative AI", SynthID watermark applied).
- **Terms:** the files do not record which Google product made them or its
  terms. Record the tool and its usage terms here before any public or
  commercial release.
- Credited in-game under ABOUT → CREDITS → MUSIC.

## Player base model

- **File:** `3d/soap_soccer_player.glb`
- **Licence:** Creative Commons Attribution 4.0 International (CC-BY-4.0)
- **Author:** luccacatalan (https://sketchfab.com/luccacatalan)
- **Source:** https://sketchfab.com/3d-models/soap-soccer-player-5ae4bf9d6a324cfda79ce1298ea2d333
- **Attribution:** Required. Retained here and in-game under ABOUT → CREDITS → MODEL.
- **Usage:** Base mesh for all eight roster characters. Skinned (7 meshes /
  6152 tris / 48 bones), tinted per-character by `js/cosmetics.js` and
  `js/config.js` palettes. Cosmetic outfits, faces, hairstyles and accessories
  are procedural box/cylinder overlays baked onto the bones at load; they change
  appearance only.

## Build 5 (menus, logo, weather)

- **Logo + app icons** (`index.html` SVG symbol `#bo-ball`, `icons/icon-*.svg`):
  original, drawn in SVG for BLACKOUT. The O is a ball half blacked out.
- **Rain, splashes, wet sheen** (`js/weather.js`) and the **dusk / blackout**
  lighting presets (`js/lighting.js`) are generated in code; no new files.
- **Fonts**: see the table above. Shipped locally and cached by the service
  worker, so the game still works offline.

## Build 6 (modes, keepers, friend match)

- Penalty Shootout, The Yard (cones, targets, rings), Rumble orbs, keeper
  dives/jumps and the fog and wind effects are generated in code; no new art files.
- FRIEND MATCH uses the free public PeerJS broker (0.peerjs.com) only to
  exchange the 6-character code; match data then goes phone to phone.

## Custom / original content (no third-party licence)

All streetwear outfits, boots, faces, hairstyles, accessories, courts, crowd,
buildings, HUD and UI art are original BLOCKOUT content authored in code
(procedural geometry) or as local source files. They carry no external licence
obligation.

## Untracked / not loaded at runtime

These files exist in the working tree but are **not referenced by any game
code** and are not shipped. They carry their own upstream licences and must not
be redistributed without checking them:

- `3d/Fast Run.fbx`, `3d/Running.fbx`, `3d/Running Slide.fbx` — Mixamo-style
  animation sources (not loaded; the GLB ships its own `PlayerRig` clips).
- `3d/kenney_city-kit-roads.zip` — Kenney City Kit roads (CC0 / Kenney
  licence); not extracted or loaded.
- `environment/overview.png`, `environment/other view.png` — reference
  screenshots, not loaded.

## Guarantees

- No club kits, badges, logos or unlicensed real-world football IP.
- No paid assets, external APIs or runtime network fetches for assets.
- No gameplay/stat advantage from any cosmetic.
