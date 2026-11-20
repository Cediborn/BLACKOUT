// ============================================================
// WEATHER (Build 5) — rain over the court.
//   * streaks: one LineSegments draw call; drops fall through a box
//     over the court, slanted by a light wind, recycled at the bottom
//   * splashes: a small pool of rings that pop where drops land near
//     the play area (one InstancedMesh, one draw call)
//   * wet ground: every flat, low surface (court, asphalt, kerbs) goes
//     darker and glossier, so floodlights and headlights streak across
//     it. The dry values are stored on the material and put back exactly.
// Nothing here touches gameplay. Count scales with graphics quality.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Weather = (function () {
  var scene = null;
  var kind = 'dry';
  var streaks = null, pos = null, speed = null, count = 0;
  var rings = null, ringLife = null, ringNext = 0, RINGS = 48;
  var wetMats = [];
  var dummy = null;
  var levelFn = null;   // main.js hands over the graphics level
  var BOX = { w: 36, d: 28, h: 24 };
  var LEN = 0.95, WIND = 2.2, FALL = 22;

  function dropCount() {
    var q = 'high';
    try { q = (levelFn && levelFn()) || 'high'; } catch (e) { /* default */ }
    return q === 'low' ? 600 : q === 'medium' ? 1200 : 2000;
  }

  function seed(i, anywhere) {
    var o = i * 6;
    var x = (Math.random() * 2 - 1) * BOX.w;
    var z = (Math.random() * 2 - 1) * BOX.d;
    var y = anywhere ? Math.random() * BOX.h : BOX.h + Math.random() * 4;
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
    pos[o + 3] = x - WIND * LEN / FALL * 3; pos[o + 4] = y - LEN; pos[o + 5] = z;
    speed[i] = FALL * (0.8 + Math.random() * 0.4);
  }

  function buildStreaks() {
    count = dropCount();
    pos = new Float32Array(count * 6);
    speed = new Float32Array(count);
    for (var i = 0; i < count; i++) seed(i, true);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var m = new THREE.LineBasicMaterial({ color: 0xc6d6e6, transparent: true, opacity: 0.5, depthWrite: false });
    streaks = new THREE.LineSegments(g, m);
    streaks.frustumCulled = false;
    streaks.renderOrder = 5;
    streaks.name = 'weatherRain';
    scene.add(streaks);
  }

  function buildRings() {
    var g = new THREE.RingGeometry(0.05, 0.09, 12);
    g.rotateX(-Math.PI / 2);
    var m = new THREE.MeshBasicMaterial({ color: 0xd6e4f0, transparent: true, opacity: 0.55, depthWrite: false });
    rings = new THREE.InstancedMesh(g, m, RINGS);
    rings.frustumCulled = false;
    rings.name = 'weatherSplash';
    ringLife = new Float32Array(RINGS);
    dummy = new THREE.Object3D();
    for (var i = 0; i < RINGS; i++) { dummy.scale.set(0.0001, 1, 0.0001); dummy.updateMatrix(); rings.setMatrixAt(i, dummy.matrix); }
    scene.add(rings);
  }

  // flat + low + wide = something you walk on
  function wetten(on) {
    var i;
    if (!on) {
      for (i = 0; i < wetMats.length; i++) {
        var m = wetMats[i], d = m.userData._lgDry;
        if (!d) continue;
        if (m.isMeshStandardMaterial) { m.roughness = d.r; m.metalness = d.m; }
        m.color.copy(d.c);
        delete m.userData._lgDry;
      }
      wetMats.length = 0;
      return;
    }
    var box = new THREE.Box3(), size = new THREE.Vector3();
    scene.traverse(function (o) {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || o === sheen) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      box.setFromObject(o);
      if (box.isEmpty()) return;
      box.getSize(size);
      if (box.max.y > 0.25 || size.y > 0.3 || size.x < 2.5 || size.z < 2.5) return;
      for (var k = 0; k < mats.length; k++) {
        var mt = mats[k];
        if (!mt || !mt.color || mt.isMeshBasicMaterial || mt.userData._lgDry || mt.transparent) continue;
        mt.userData._lgDry = { r: mt.roughness, m: mt.metalness, c: mt.color.clone() };
        if (mt.isMeshStandardMaterial) { mt.roughness = Math.min(mt.roughness, 0.3); mt.metalness = Math.max(mt.metalness, 0.08); }
        mt.color.multiplyScalar(0.72);
        wetMats.push(mt);
      }
    });
  }

  // a thin glossy film over the court: Phong specular picks up every
  // floodlight, lamp and headlight as a streak on the wet asphalt
  var sheen = null;
  function buildSheen() {
    var g = new THREE.PlaneGeometry(40, 58, 1, 1);
    g.rotateX(-Math.PI / 2);
    var m = new THREE.MeshPhongMaterial({ color: 0x000000, specular: 0x5f6b78, shininess: 60, transparent: true, opacity: 0.36, depthWrite: false });
    sheen = new THREE.Mesh(g, m);
    sheen.position.y = 0.06;
    sheen.renderOrder = 2;
    sheen.name = 'weatherSheen';
    scene.add(sheen);
  }

  // ---- FOG: the current time-of-day fog pulled in close (Build 6) ----
  function applyFog(on) {
    if (!scene || !scene.fog || !LG.Lighting || !LG.Lighting.fogBase) return;
    var b = LG.Lighting.fogBase();
    scene.fog.color.setHex(b.color);
    if (!on) { scene.fog.near = b.near; scene.fog.far = b.far; return; }
    var dark = LG.Lighting.mode && LG.Lighting.mode() !== 'day';
    scene.fog.color.lerp(new THREE.Color(dark ? 0x1c232c : 0xa7adb2), dark ? 0.5 : 0.75);
    scene.fog.near = 6;
    scene.fog.far = Math.max(34, b.far * 0.32);
  }

  // ---- WIND: gusts carry dust and leaves across, and bend balls in the air ----
  var dust = null, dpos = null, dvel = null, DUST = 260, windT = 0;
  function buildDust() {
    dpos = new Float32Array(DUST * 6); dvel = new Float32Array(DUST);
    for (var i = 0; i < DUST; i++) seedDust(i, true);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    dust = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xb59a73, transparent: true, opacity: 0.55, depthWrite: false }));
    dust.frustumCulled = false; dust.name = 'weatherWind';
    scene.add(dust);
  }
  function seedDust(i, anywhere) {
    var o = i * 6, x = anywhere ? (Math.random() * 2 - 1) * BOX.w : -BOX.w - Math.random() * 8;
    var y = Math.random() < 0.7 ? Math.random() * 1.2 : Math.random() * 6;
    var z = (Math.random() * 2 - 1) * BOX.d, len = 0.18 + Math.random() * 0.5;
    dpos[o] = x; dpos[o + 1] = y; dpos[o + 2] = z;
    dpos[o + 3] = x + len; dpos[o + 4] = y + (Math.random() - 0.5) * 0.08; dpos[o + 5] = z + (Math.random() - 0.5) * 0.1;
    dvel[i] = 7 + Math.random() * 6;
  }
  function gust() { return 0.55 + 0.45 * Math.sin(windT * 0.7) * Math.sin(windT * 0.23 + 1.1); }
  // world acceleration on a ball in the air (m/s^2); zero unless WIND
  function windAccel() {
    if (kind !== 'wind') return { x: 0, z: 0 };
    var g = gust();
    return { x: 3.2 * g, z: 0.9 * g };
  }

  function set(k) {
    var want = (k === 'rain' || k === 'fog' || k === 'wind') ? k : 'dry';
    if (!scene || !window.THREE) { kind = want; return kind; }
    // re-wet every time: a court change builds a new, dry surface
    wetten(false);
    if (want === 'rain') {
      if (!streaks) buildStreaks();
      if (!rings) buildRings();
      if (!sheen) buildSheen();
      streaks.visible = true; rings.visible = true; sheen.visible = true;
      wetten(true);
    } else {
      if (streaks) streaks.visible = false;
      if (rings) rings.visible = false;
      if (sheen) sheen.visible = false;
    }
    applyFog(want === 'fog');
    if (want === 'wind') { if (!dust) buildDust(); dust.visible = true; }
    else if (dust) dust.visible = false;
    kind = want;
    return kind;
  }

  function update(dt) {
    windT += dt;
    if (kind === 'wind' && dust) {
      var gs = gust(), dd = Math.min(dt, 0.05);
      for (var j = 0; j < DUST; j++) {
        var q = j * 6, mvx = dvel[j] * gs * dd;
        dpos[q] += mvx; dpos[q + 3] += mvx;
        dpos[q + 1] += Math.sin(windT * 3 + j) * 0.01; dpos[q + 4] = dpos[q + 1] + 0.02;
        if (dpos[q] > BOX.w) seedDust(j, false);
      }
      dust.geometry.attributes.position.needsUpdate = true;
    }
    if (kind !== 'rain' || !streaks) return;
    dt = Math.min(dt, 0.05);
    var drift = WIND * dt;
    for (var i = 0; i < count; i++) {
      var o = i * 6, dy = speed[i] * dt;
      pos[o + 1] -= dy; pos[o + 4] -= dy;
      pos[o] -= drift; pos[o + 3] -= drift;
      if (pos[o + 4] <= 0) {
        // a splash where it landed, if it landed near the play
        if (Math.abs(pos[o + 3]) < 16 && Math.abs(pos[o + 5]) < 11 && Math.random() < 0.08) ring(pos[o + 3], pos[o + 5]);
        seed(i, false);
      }
      if (pos[o] < -BOX.w) { pos[o] += BOX.w * 2; pos[o + 3] += BOX.w * 2; }
    }
    streaks.geometry.attributes.position.needsUpdate = true;

    var dirty = false;
    for (var r = 0; r < RINGS; r++) {
      if (ringLife[r] <= 0) continue;
      ringLife[r] -= dt;
      rings.getMatrixAt(r, dummy.matrix);
      dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
      var t = 1 - Math.max(0, ringLife[r]) / 0.35;
      var sc = ringLife[r] > 0 ? 0.6 + t * 2.6 : 0.0001;
      dummy.scale.set(sc, 1, sc);
      dummy.updateMatrix();
      rings.setMatrixAt(r, dummy.matrix);
      dirty = true;
    }
    if (dirty) rings.instanceMatrix.needsUpdate = true;
  }

  function ring(x, z) {
    var r = ringNext; ringNext = (ringNext + 1) % RINGS;
    ringLife[r] = 0.35;
    dummy.position.set(x, 0.03, z);
    dummy.quaternion.identity();
    dummy.scale.set(0.6, 1, 0.6);
    dummy.updateMatrix();
    rings.setMatrixAt(r, dummy.matrix);
    rings.instanceMatrix.needsUpdate = true;
  }

  return {
    build: function (sc, lvl) { scene = sc; levelFn = lvl || null; return this; },
    set: set,
    update: update,
    kind: function () { return kind; },
    active: function () { return kind === 'rain' && !!streaks && streaks.visible; },
    windAccel: windAccel,
    info: function () { return { kind: kind, drops: count, wet: wetMats.length }; },
  };
})();
