// ============================================================
// LIGHTING — Day / Night match atmosphere
// The environment is built ONCE by arena.js; this module never
// touches that geometry.  It only re-balances the lights, fog,
// exposure and emissive glow that already exist, plus adds a
// couple of night-only pitch floods so the court reads as a
// real street pitch under artificial light instead of a global
// dark filter.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Lighting = (function () {
  var scene = null;
  var renderer = null;
  var mode = 'day';

  var hemi = null, ambient = null, sun = null;
  var fills = [];        // night-only overhead pitch lights
  var pointLights = [];  // { light, base }
  var emissives = [];    // { mat, base }
  var skies = [];        // { mat, base }
  var stats = { points: 0, emissives: 0, skies: 0 };

  var PRESETS = {
    day: {
      // Key/fill ratio is what sells depth: the directional sun carries the
      // scene, hemisphere only separates sky-lit tops from ground bounce, and
      // the ambient is just enough to keep shadow interiors readable.
      hemiSky: 0xaecbf2, hemiGround: 0x3a332c, hemiIntensity: 0.40,
      ambColor: 0x2f3949, ambIntensity: 0.15,
      sunColor: 0xfff1d6, sunIntensity: 2.35,
      fogColor: 0x9fb9d8, fogNear: 78, fogFar: 230,
      exposure: 1.0,
      pointIntensity: 0.3, pointDistance: 1.0,
      emissive: 0.35,
      skyTint: 0xffffff,
      fill: 0.0,
    },
    night: {
      // True night: the surroundings and horizon drop into deep shade while the
      // pitch stays lit by boosted lamp floods + the overhead fills. The court
      // reads as "street football at night under floodlights" — never a dark
      // filter on top of the daytime scene (sky tint, emissive windows/lamps
      // and the warm flood weights all carry the night look on their own).
      hemiSky: 0x2a3a5c, hemiGround: 0x080b12, hemiIntensity: 0.22,
      ambColor: 0x121a2c, ambIntensity: 0.18,
      sunColor: 0xa7bdff, sunIntensity: 0.22,   // cool "moon" fill, soft shadows
      fogColor: 0x05080f, fogNear: 42, fogFar: 115,
      exposure: 1.05,
      pointIntensity: 2.1, pointDistance: 1.25,
      emissive: 1.8,
      skyTint: 0x8697bc,
      fill: 1.1,
    },
    // Build 5 — golden hour: low warm sun, long shadows, lamps just coming on
    dusk: {
      hemiSky: 0xf2a879, hemiGround: 0x2b2231, hemiIntensity: 0.40,
      ambColor: 0x3b3043, ambIntensity: 0.20,
      sunColor: 0xff9d5c, sunIntensity: 1.55,
      fogColor: 0xb98473, fogNear: 60, fogFar: 185,
      exposure: 1.02,
      pointIntensity: 1.0, pointDistance: 1.1,
      emissive: 1.0,
      skyTint: 0xffc9a8,
      fill: 0.3,
      sunPos: [34, 11, 9],
      sky: 'night',
    },
    // Build 5 — BLACKOUT: the power is cut. Floodlights and street lamps die,
    // windows go dark; a cold moon, a flickering generator lamp, car
    // headlights and the festoon string keep the court just playable.
    blackout: {
      hemiSky: 0x2b3a5c, hemiGround: 0x040509, hemiIntensity: 0.24,
      ambColor: 0x111829, ambIntensity: 0.14,
      sunColor: 0x9fb8ff, sunIntensity: 0.42,
      fogColor: 0x020308, fogNear: 26, fogFar: 88,
      exposure: 1.0,
      pointIntensity: 0.06, pointDistance: 0.8,
      emissive: 0.12,
      skyTint: 0x3e4862,
      fill: 0.62,
      flicker: true,
      sky: 'night',
    },
  };
  var SUN_POS = [16, 30, 12];
  var flickT = 0, flickDrop = 0;

  function makeKeyLights() {
    hemi = new THREE.HemisphereLight(0x9db4da, 0x23272f, 0.72);
    scene.add(hemi);

    ambient = new THREE.AmbientLight(0x3a4150, 0.42);
    scene.add(ambient);

    sun = new THREE.DirectionalLight(0xffd9a0, 1.0);
    sun.position.set(16, 30, 12);
    sun.castShadow = true;
    var d = 26;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    scene.add(sun);

    // night-only overhead floods concentrated over the playable area.
    // They are created with intensity 0 and only "switched on" in Night mode,
    // so Day mode pays no visual or shader cost beyond the light slots.
    var spots = [[0, 17, -11], [0, 17, 11]];
    for (var i = 0; i < spots.length; i++) {
      var f = new THREE.PointLight(0xffe7bd, 0, 62, 1.25);
      f.position.set(spots[i][0], spots[i][1], spots[i][2]);
      f._lgFill = true;
      scene.add(f);
      fills.push(f);
    }
  }

  // Gather every light / emissive / sky material that already exists in the
  // environment so the presets can scale them.  Called once after the arena
  // and living layers are built.
  function collect(root) {
    if (!root) return;
    root.traverse(function (o) {
      if (!o) return;
      if (o.isPointLight && !o._lgFill) {
        if (o._lgBase === undefined) {
          o._lgBase = { intensity: o.intensity, distance: o.distance };
          pointLights.push(o);
          stats.points++;
        }
        return;
      }
      var m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (var i = 0; i < m.length; i++) collectMat(m[i]); return; }
      collectMat(m);
      // sky dome: back-side basic material
      if (m.isMeshBasicMaterial && m.side === THREE.BackSide && m.map && skies.indexOf(m) < 0) {
        skies.push(m);
        m._lgBase = m.color ? m.color.getHex() : 0xffffff;
        stats.skies++;
        var maps = m.userData && m.userData.lgMaps;
        if (maps) {
          m._lgDayMap = maps.day || null;
          m._lgNightMap = maps.night || null;
          // honour whichever mode is already active
          var wantMap = mode === 'day' ? m._lgDayMap : m._lgNightMap;   // every non-day mode uses the night dome
          if (wantMap && m.map !== wantMap) { m.map = wantMap; m.needsUpdate = true; }
        }
      }
    });
  }

  function collectMat(m) {
    if (!m || !m.emissive) return;
    if (emissives.indexOf(m) >= 0) return;
    if (m.emissive.r + m.emissive.g + m.emissive.b <= 0.001) return;
    emissives.push(m);
    m._lgBaseEmissive = m.emissiveIntensity !== undefined ? m.emissiveIntensity : 1;
    stats.emissives++;
  }

  function build(sc, rend) {
    scene = sc;
    renderer = rend || null;
    makeKeyLights();

    if (renderer) {
      // controlled tone mapping fixes the blown-out turf and keeps highlights
      // from clipping in both modes (ACES is present in the bundled three.js)
      if (THREE.ACESFilmicToneMapping !== undefined) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
      }
    }
    return { hemi: hemi, ambient: ambient, sun: sun, fills: fills };
  }

  function setMode(m) {
    mode = PRESETS[m] ? m : 'day';
    var P = PRESETS[mode];
    var skyKey = P.sky || mode;   // dusk + blackout use the night dome

    if (hemi) { hemi.color.setHex(P.hemiSky); hemi.groundColor.setHex(P.hemiGround); hemi.intensity = P.hemiIntensity; }
    if (ambient) { ambient.color.setHex(P.ambColor); ambient.intensity = P.ambIntensity; }
    if (sun) {
      sun.color.setHex(P.sunColor); sun.intensity = P.sunIntensity;
      var sp = P.sunPos || SUN_POS;
      sun.position.set(sp[0], sp[1], sp[2]);
    }

    if (scene && scene.fog) {
      scene.fog.color.setHex(P.fogColor);
      scene.fog.near = P.fogNear;
      scene.fog.far = P.fogFar;
    }

    for (var i = 0; i < pointLights.length; i++) {
      var l = pointLights[i];
      l.intensity = l._lgBase.intensity * P.pointIntensity;
      l.distance = l._lgBase.distance * P.pointDistance;
    }

    for (i = 0; i < fills.length; i++) fills[i].intensity = P.fill;

    for (i = 0; i < emissives.length; i++) {
      var em = emissives[i];
      em.emissiveIntensity = em._lgBaseEmissive * P.emissive;
    }

    for (i = 0; i < skies.length; i++) {
      var s = skies[i];
      if (s.color) s.color.setHex(P.skyTint);
      var skyMap = skyKey === 'day' ? s._lgDayMap : s._lgNightMap;
      if (skyMap && s.map !== skyMap) { s.map = skyMap; s.needsUpdate = true; }
    }

    if (renderer && renderer.toneMapping !== undefined) {
      renderer.toneMappingExposure = P.exposure;
    }

    return mode;
  }

  // Per-frame: only BLACKOUT does anything — the generator lamps over the
  // court stutter and now and then drop out for a beat. Reduced motion
  // keeps them steady. Never allocates.
  function update(dt) {
    var P = PRESETS[mode];
    if (!P || !P.flicker || !fills.length) return;
    var steady = LG.Settings && LG.Settings.reducedMotion && LG.Settings.reducedMotion();
    flickT += dt;
    if (flickDrop > 0) flickDrop -= dt;
    else if (!steady && Math.random() < dt * 0.35) flickDrop = 0.06 + Math.random() * 0.18;
    var k = steady ? 1 : (flickDrop > 0 ? 0.15 : 0.82 + 0.18 * Math.sin(flickT * 23.0) * Math.sin(flickT * 7.3));
    for (var i = 0; i < fills.length; i++) fills[i].intensity = P.fill * k;
  }

  return {
    build: build,
    collect: collect,
    setMode: setMode,
    update: update,
    modes: function () { return Object.keys(PRESETS); },
    mode: function () { return mode; },
    // what the environment actually contained when collect() ran
    stats: function () { return { points: stats.points, emissives: stats.emissives, skies: stats.skies }; },

    // Phase 10 graphics quality: sun shadows on/off + shadow-map size.
    // Toggling castShadow changes the light state, so three rebuilds the
    // affected programs by itself; a new map size drops the old shadow map
    // so it is reallocated at the new resolution on the next render.
    setShadows: function (on, size) {
      if (!sun) return false;
      sun.castShadow = !!on;
      size = size | 0;
      if (size > 0 && sun.shadow && sun.shadow.mapSize && sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        if (sun.shadow.map && sun.shadow.map.dispose) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      }
      return true;
    },
    shadowState: function () {
      return sun ? { on: !!sun.castShadow, size: sun.shadow && sun.shadow.mapSize ? sun.shadow.mapSize.x : 0 } : null;
    },
  };
})();


