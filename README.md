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

## What's new in 1.3.0

- **Real kits:** every outfit is now an actual garment on the body, not paint on a slim mannequin. BAGGY KIT is an oversized tee hanging past the shorts with elbow-length sleeves and knee-length baggy shorts; HOODIE has the hood up, a kangaroo pocket and drawstrings; HOOD DOWN has the hood folded on the back; TRACK TOP has a zip, stand collar and three stripes; JERSEY has a V-neck, chevron, crest, side panels and a sleeve band; LONG SLEEVE is a fitted compression top; WINDBREAKER is two-tone with a zip, reflective strip and stand collar; PINNIE is a see-through mesh bib with numbers over a tee; keepers wear a padded keeper kit. Numbers are printed on the fabric. The cloth moves with every animation.
- **Real fans:** every spectator is cut from the same realistic body as the players (with hair or hats, shoes, sleeves or bare forearms), and a third of each end wears the team scarf. Still about 9 draw calls for the whole crowd.
- **Real street people:** walkers and fence watchers are real animated people in street clothes (tees, hoodies, puffer jackets, tank tops, oversized tees, jeans). Walkers stroll at walking pace, some looking at their phones; watchers fold their arms, look around, cheer goals and react to near misses.
- **Street life:** pigeons that take off when people walk close or the crowd roars, steam from manholes, festoon lights over both stands (they glow at night), a street-food cart with a vendor and grill smoke, and litter blowing across the ground in gusts.
- Tests: `npm run test:build3` checks all of this on the real game in headless Chrome.

## What's new in 1.2.0

- **Realistic players:** a real-proportion human body with real animation clips (CC0, Quaternius Universal Animation Library), replacing the boxy figures. Each player is dressed in their kit on the body itself (shirt, collar and cuffs, shorts, socks, boots, skin, hair, keeper gloves, shirt number). Movement: idle, walk, jog, sprint, back-pedal, strafes, leaning into turns.
- **Real football actions:** authored kicks, slide tackles, getting hit, and keeper dives on saves.
- **Celebrations:** the scorer celebrates, dances, backflips or power-slides; teammates join in; the conceding side cries, shakes heads or folds arms; full-time reactions too.
- **Living crowd:** fans watch the ball and each one claps, points, waves, chats or stands hands-on-hips. They go "ooh" with hands on heads after a near miss, applaud saves, the conceding end slumps, and fans near the ball lean in.
- **Real traffic:** car-shaped sedans, hatchbacks, vans and taxis with spinning, steering wheels. They drive a one-way ring, slow for corners, keep their distance and brake with brake lights. Headlights glow at night.
- **Sharper city:** detailed building facades (brick, framed windows, blinds, AC units) whose lit windows glow at night.
- **New modes:** First to 5, and Street Twist (a daily rule twist: Moon Ball, Soap Floor, Big Ball or Turbo).
- Compare against the old bodies with `index.html?athlete=0`. `node tools/look.js <script>` films the real game from scripted camera angles.

## What's new in 1.1.0

- **Golden Goal:** a tied Street Cup match plays on at 0:00, and the next goal wins (capped at 90 s).
- **PLAY NOW:** one tap from the main menu into a Quick Match with your last star, kits, difficulty and court.
- **Graphics Quality:** AUTO / LOW / MEDIUM / HIGH in Settings → Display. It controls the render resolution and sun shadows.
- **Slide tackles:** the player model plays its own authored Tackle clip on every tackle attempt.
- **Mode rules:** each mode in `js/modes.js` now carries a `rules` block that the match reads, so new modes are mostly data.
- **Fixes:** Blaze no longer appears twice on his own team, and the credits now list the player model and the menu music.

## Assets and licences

See [ASSETS.md](ASSETS.md). The player model is CC BY 4.0 by luccacatalan. Three.js is MIT.
