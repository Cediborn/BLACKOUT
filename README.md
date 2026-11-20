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

To film every menu and check the Build 5 screens (also part of `npm test`):

```sh
node tools/look.js tools/looks/menus.js --out looks-out/build5
```

## What's new in 1.8.0

- **Goalkeepers that keep goal:** keepers now narrow the angle (off the line as an attacker comes on, tucked in at the near post when the ball is wide), shuffle across facing the ball, sprint back when pulled out of position, claim loose balls and through passes they can genuinely reach first, and come off the line to smother a striker who is through. Shots get a short, level-dependent reaction delay and a committed read, so placed shots, close finishes and wrong-footed keepers still beat them. The ROGUE keeper no longer wanders off his line or lets balls go round him.
- **Calm, protected distribution:** a keeper who catches or gathers the ball secures it, looks up, walks it to a release spot and then rolls, throws or kicks it to the best open teammate, or clears it when every outlet is marked. While he holds it he cannot be tackled or bumped, and opponents (yours included) are eased out of a bubble around him. Loose balls and parries are still fair game.
- **A ROGUE side that attacks:** CPU carriers rate their chance (angle, distance, the gap the keeper leaves, bodies on the line) before shooting, aim for a corner, square it to a team-mate with a better chance, and carry the ball into better spots. Runners attack the far post and arrive at the edge of the box. Difficulty still sets appetite and accuracy; EASY rarely threatens, HARD keeps you busy.
- **Goals only when they are goals:** the goal is now a physical object: posts and crossbar you can hit, soft side, roof and back nets, and a real end fence (with a panel over the bar). A goal is the whole ball over the line inside the frame, counted once. Side netting, the outside of the goal, the woodwork, balls over the bar and a dribble into the netting beside the post can no longer score. Fast shots are swept in short steps so they can't tunnel through a post, and a ball in the net stays in the net (which ripples).
- **A bigger cage:** the court grows from 26 x 44 to 30 x 50. Fences, stands, benches, lights and street life moved with it, and the AI, kick-off shape and cameras all scale to the new size.

```sh
npm run test:build8    # the cage, the nets, goal detection, keeper possession in the real game
node tools/sim.js      # sections "Build 8a"–"Build 8e": goal line, keepers, possession, attack, court
```

## What's new in 1.7.0

- **Faster, snappier play on phones:** quicker kick-offs, sharper acceleration and turning, and a slightly higher top pace (passes and shots kept their tuned speeds). A slow phone no longer plays in slow motion: the match clock stays real-time even at 20 fps. The stadium is batched (about 240 fewer draw calls a frame), phones render at 1.5x instead of 2x, and the resolution steps down on its own when a frame runs long.
- **Smooth friend matches:** no more freeze-then-jump. Your friend's players are drawn a little behind real time and blended between updates, with a buffer that grows only when the connection is jittery; short dropouts are bridged by carrying everyone forward on their last motion. Your own player moves the instant you touch the stick and is gently corrected by the host. A WEAK SIGNAL chip shows when data stops. Updates are smaller (light 20 Hz updates, full ones 5 Hz) and inputs slow down while you are idle.
- **Five cameras:** 1 TELE, 2 WIDE TACTICAL (the classic), 3 DYNAMIC, 4 CLOSE and 5 FOCUS. Each has its own height, distance, lens and follow feel, works in portrait and landscape, glides between choices, never backs into the stands and keeps the ball in shot. Change it with the camera chip beside PAUSE, the C key or SETTINGS; it is saved.
- **Skill moves:** a SKILL button (keys F/U) takes SWITCH's place while you attack. The stick picks the move: none or forward for a BODY FEINT, back for a DRAG BACK, left/right for a ROULETTE, forward + SPRINT for a RAINBOW FLICK. Hold SKILL while charging SHOOT for a curled FINESSE shot; hold SHOOT as a pass arrives to strike it FIRST TIME or on the VOLLEY. The CPU uses them under pressure too. All moves have cooldowns and stamina costs, and they work in friend matches.
- **Better bodies:** players lean into turns and pitch forward when they accelerate, the ball is touched ahead in stride, arriving balls are cushioned, and a pressed player turns side-on to shield.
- **New graphics pipeline** ([pmndrs/postprocessing](https://github.com/pmndrs/postprocessing)): floodlight bloom, broadcast vignette and anti-aliasing on MEDIUM; HIGH adds a colour grade and SMAA. LOW stays without effects. Effects switch off by themselves while a phone is struggling.

```sh
npm run test:build7    # cameras, postprocessing, batching, skills in the real game
node tools/netprobe.js # online sync under lag, jitter, loss and a stall
node tools/skillprobe.js
```

## What's new in 1.6.0

- **Courts and conditions on one screen:** pick the court from a strip of tiles and set TIME (day, dusk, night, blackout), WEATHER (dry, rain, fog, wind), CROWD (empty to packed) and STREET LIFE (off to full) right beside it. A box explains what each pick changes on the pitch. Fog pulls the far end in; wind blows dust across and bends balls in the air.
- **Penalty Shootout:** five kicks each, then sudden death. Aim with the stick, hold SHOOT to charge (overhit flies over the bar), and when the CPU kicks, hold the stick left or right to pick your keeper's dive.
- **The Yard (training):** three 40-second drills: Target Practice, Speed Gates and Pass & Move, with 3 stars each. Every new star pays 25 coins once; your best scores are saved.
- **Rumble:** a full match where specials only come from glowing orbs on the court; run over one to grab any of the 8 abilities.
- **The CPU uses special moves:** each ROGUE player fires its ability when the moment fits (a burst into space, a power shot in range, Ice Grip as you bear down on goal…). EASY hesitates, HARD pounces.
- **Real goalkeeping:** keepers dive full stretch (take-off, flight, land on the side, get up), spring for high balls, crouch when an attacker closes in, throw short distributions and punch parries.
- **FRIEND MATCH:** host gets a 6-character code, your friend types it in, and you play each other online, phone to phone. Needs internet on both phones.

```sh
npm run test:build6    # court screen, shootout, yard, rumble, CPU specials, keeper dive
npm run test:friend    # two real game windows play a friend match (local link)
```

## What's new in 1.5.0

- **New look, everywhere:** a floodlight-broadcast skin over every menu (`css/broadcast.css`). Slab panels, Anton and Barlow type shipped with the game (works offline), spray pink and volt cyan accents, and the live 3D street drifting behind every pre-match screen.
- **New logo and app icon:** the O in BLACKOUT is a ball caught mid power cut.
- **Home hub:** a big KICK OFF, PLAY NOW with your last setup, Street Cup status (continue a run in one tap), today's Street Twist, your 3 active challenges, your coins and a bottom bar.
- **Loading screen:** 12 floodlights switch on as the game really loads, with a random ability tip.
- **Star cards:** an OVR rating (the average of the six stats), six stat bars, the ability with its one-line description, and the price or how many coins to go.
- **Modes:** icon tiles; Penalty Shootout, The Yard and Rumble are shown as SOON (not playable yet).
- **New conditions:** DUSK (low orange sun) and BLACKOUT (the power is cut: moonlight, a flickering generator lamp and car headlights), plus RAIN with streaks, splashes and wet, shiny asphalt. Pick them in MATCH SETUP or SETTINGS.
- **In the match:** a TV-style score box, round action buttons and a cyan ability ring. PAUSE shows the live score and match stats; FULL TIME lists how every coin was earned.

## What's new in 1.4.0

- **Kit room:** PLAYER STYLE is now two live 3D players, one from your team and one from the Rogue Squad. Tap a player to change that team's kit colour (the two teams can never match). Tap the orb under a player to change the team's kit style (Hoodie, Hood Down, Track Top, Jersey, Pinnie, Long Sleeve, Windbreaker, Baggy Kit). The whole team wears the style; keepers keep the keeper kit. Both choices are remembered and used by PLAY NOW.
- **No more GEAR box or colour grids.** Hair, accessories and skin are shuffled every match, and every squad of three has one black, one white and one mixed-skin player.

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
