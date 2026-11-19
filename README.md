# BLACKOUT — Street Football

A 3v3 street-football game with goalkeepers that runs in the browser. It is built with Three.js, has no build step, and installs as a PWA that plays offline after the first load. Progress is saved only in the browser's localStorage.

## Run it

Serve the folder over HTTP (the service worker and model loading need a real server, not `file://`):

```sh
npm run serve        # python3 -m http.server 8080
# then open http://localhost:8080
```

## Test it

```sh
npm test             # gameplay sim, boot + menu flow, presentation probes
```

The tests run headless in Node and need no install. GitHub runs the same command on every push (`.github/workflows/test.yml`).

To screenshot the real game in headless Chrome (set `CHROME=/path/to/chrome` if it isn't found):

```sh
node tools/shot.js --state menu --out menu.png
node tools/shot.js --glbtest --glbpose tackle:0.29 --out tackle.png
```

## What's new in 1.1.0

- **Golden Goal:** a tied Street Cup match plays on at 0:00, and the next goal wins (capped at 90 s).
- **PLAY NOW:** one tap from the main menu into a Quick Match with your last star, kits, difficulty and court.
- **Graphics Quality:** AUTO / LOW / MEDIUM / HIGH in Settings → Display. It controls the render resolution and sun shadows.
- **Slide tackles:** the player model plays its own authored Tackle clip on every tackle attempt.
- **Mode rules:** each mode in `js/modes.js` now carries a `rules` block that the match reads, so new modes are mostly data.
- **Fixes:** Blaze no longer appears twice on his own team, and the credits now list the player model and the menu music.

## Assets and licences

See [ASSETS.md](ASSETS.md). The player model is CC BY 4.0 by luccacatalan. Three.js is MIT.
