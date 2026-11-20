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

  function set(k) {
    var want = k === 'rain' ? 'rain' : 'dry';
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
    kind = want;
    return kind;
  }

  function update(dt) {
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
    info: function () { return { kind: kind, drops: count, wet: wetMats.length }; },
  };
})();
