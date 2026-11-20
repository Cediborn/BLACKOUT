// ============================================================
// STREETLIFE — small living details around the block (Build 3).
//
//   * PIGEONS   two flocks peck about on the sidewalks. Anyone walking
//               close (or a goal roar) sends them up: they flap off, circle
//               over the street and settle back down later.
//   * STEAM     manhole vents in the road breathe slow white plumes.
//   * FESTOON   strings of warm bulbs sag over both stands; they come up
//               bright at night through LG.Lighting's emissive pass.
//   * FOOD CART a street-food cart with an umbrella, a grill that smokes
//               and a vendor (a real body once the athlete has loaded).
//   * LITTER    paper scraps and leaves tumble across the ground in gusts.
//
// Purely cosmetic: nothing here is in collision/goal/physics lists, and it
// uses its own seeded PRNG (never Math.random), so the replayed simulation
// stream stays identical. Everything is instanced: 11 draws in total.
// ============================================================
var LG = window.LG = window.LG || {};

LG.StreetLife = (function () {
  var root = null, t = 0, built = false;
  var _s = 0xB10C5;
  function rnd() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
  function jit(a, b) { return a + (b - a) * rnd(); }

  var _M = new THREE.Matrix4(), _P = new THREE.Vector3(), _Q = new THREE.Quaternion(),
    _S = new THREE.Vector3(), _E = new THREE.Euler(0, 0, 0, 'YXZ'), _ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  function inst(geo, mat, n, shadow) {
    var m = new THREE.InstancedMesh(geo, mat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = !!shadow;
    return m;
  }
  function put(m, i, x, y, z, rx, ry, rz, sx, sy, sz) {
    _P.set(x, y, z); _E.set(rx || 0, ry || 0, rz || 0); _Q.setFromEuler(_E);
    _S.set(sx == null ? 1 : sx, sy == null ? (sx == null ? 1 : sx) : sy, sz == null ? (sx == null ? 1 : sx) : sz);
    _M.compose(_P, _Q, _S); m.setMatrixAt(i, _M);
  }

  // ============================================================ PIGEONS
  var FLOCKS = [{ x: 24.5, z: -15, r: 2.2 }, { x: -7, z: 29.5, r: 2.4 }, { x: -24, z: -24, r: 1.8 }];
  var PER = 7;
  var birds = [], pb = null, pw = null, flocks = [];
  function pigeonGeos() {
    var body = new THREE.SphereGeometry(0.1, 8, 6);
    if (typeof body.scale === 'function') body.scale(0.85, 0.8, 1.45);
    var head = new THREE.SphereGeometry(0.052, 7, 5);
    head.translate(0, 0.085, 0.13);
    var beak = new THREE.ConeGeometry(0.014, 0.04, 4);
    beak.rotateX(Math.PI / 2); beak.translate(0, 0.08, 0.19);
    var tail = new THREE.BoxGeometry(0.08, 0.015, 0.11);
    tail.translate(0, 0.01, -0.17);
    var bodyG = merge([body, head, beak, tail]);
    var wing = new THREE.BoxGeometry(0.2, 0.012, 0.13);
    wing.translate(0.1, 0, 0);                      // pivot at the shoulder
    return { body: bodyG, wing: wing };
  }
  function buildPigeons(g) {
    var G = pigeonGeos();
    var mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    var n = FLOCKS.length * PER;
    pb = inst(G.body, mat, n, true);
    pw = inst(G.wing, mat.clone(), n * 2, false);
    var c = new THREE.Color();
    var cols = [0x7d8590, 0x8a919b, 0x6b7179, 0x9aa0a8, 0x5d6168, 0xb9b4ac];
    FLOCKS.forEach(function (f, fi) {
      flocks.push({ x: f.x, z: f.z, r: f.r, state: 'ground', t: 0, alarm: 0 });
      for (var k = 0; k < PER; k++) {
        var i = fi * PER + k;
        var a = rnd() * 6.283, rr = Math.sqrt(rnd()) * f.r;
        birds.push({
          f: fi, hx: f.x + Math.cos(a) * rr, hz: f.z + Math.sin(a) * rr,
          x: 0, y: 0, z: 0, yaw: rnd() * 6.283, peck: rnd() * 10, wander: rnd() * 10,
          ph: rnd() * 6.283, orbit: jit(5, 8), alt: jit(5, 9), spd: jit(0.55, 0.8), delay: jit(0, 0.4),
        });
        var b = birds[birds.length - 1]; b.x = b.hx; b.z = b.hz;
        c.setHex(cols[(rnd() * cols.length) | 0]);
        pb.setColorAt(i, c); pw.setColorAt(i * 2, c); pw.setColorAt(i * 2 + 1, c);
      }
    });
    pb.instanceColor.needsUpdate = true; pw.instanceColor.needsUpdate = true;
    g.add(pb); g.add(pw);
  }
  function scare(fi) {
    var f = flocks[fi];
    if (f.state !== 'ground') return;
    f.state = 'air'; f.t = 0; f.dur = jit(7, 11);
  }
  function walkersNear(f) {
    // anyone walking (street folk) within 2.6 m of the flock centre
    try {
      var sc = LG.debug && LG.debug.scene;
      if (!LG.Living || !LG.Living.folkPositions) return false;
      var ps = LG.Living.folkPositions();
      for (var i = 0; i < ps.length; i++) {
        var dx = ps[i].x - f.x, dz = ps[i].z - f.z;
        if (dx * dx + dz * dz < (f.r + 1.6) * (f.r + 1.6)) return true;
      }
    } catch (e) { /* cosmetic */ }
    return false;
  }
  function updatePigeons(dt) {
    var i, k;
    for (i = 0; i < flocks.length; i++) {
      var f = flocks[i];
      f.t += dt;
      if (f.state === 'ground' && f.t > 3 && walkersNear(f)) scare(i);
      if (f.state === 'air' && f.t > f.dur) { f.state = 'land'; f.t = 0; }
      if (f.state === 'land' && f.t > 2.2) { f.state = 'ground'; f.t = 0; }
    }
    for (i = 0; i < birds.length; i++) {
      var b = birds[i], fl = flocks[b.f];
      var wingA = 0.15, lift = 0;
      if (fl.state === 'ground') {
        // peck, shuffle, turn
        b.wander -= dt;
        if (b.wander < 0) {
          b.wander = jit(1.5, 4);
          b.tx = b.hx + jit(-0.6, 0.6); b.tz = b.hz + jit(-0.6, 0.6);
        }
        if (b.tx != null) {
          var dx = b.tx - b.x, dz = b.tz - b.z, d = Math.sqrt(dx * dx + dz * dz);
          if (d > 0.03) {
            b.x += dx / d * Math.min(d, dt * 0.45); b.z += dz / d * Math.min(d, dt * 0.45);
            var want = Math.atan2(dx, dz), dy = Math.atan2(Math.sin(want - b.yaw), Math.cos(want - b.yaw));
            b.yaw += dy * Math.min(1, dt * 6);
          }
        }
        b.y += (0 - b.y) * Math.min(1, dt * 4);
        b.peck += dt;
        var pk = Math.sin(b.peck * 5) > 0.75 ? 0.5 : 0;     // head-bob peck
        put(pb, i, b.x, b.y + 0.07 + Math.abs(Math.sin(b.peck * 9)) * 0.008, b.z, pk, b.yaw, 0);
      } else {
        // air: climb out, circle above the street, glide back in
        var ft = Math.max(0, fl.t - b.delay);
        var flap = fl.state === 'land' ? 0.5 : 1;
        b.ph += dt * (b.spd * 1.0);
        var ang = b.ph;
        var ox = fl.x + Math.cos(ang) * b.orbit, oz = fl.z + Math.sin(ang) * b.orbit;
        var tgtY = fl.state === 'land' ? 0 : Math.min(b.alt, ft * 4.5);
        var tx = fl.state === 'land' ? b.hx : ox, tz = fl.state === 'land' ? b.hz : oz;
        var k2 = Math.min(1, dt * (fl.state === 'land' ? 1.6 : 1.2));
        var px = b.x, pz = b.z;
        b.x += (tx - b.x) * k2; b.z += (tz - b.z) * k2; b.y += (tgtY - b.y) * Math.min(1, dt * 2.2);
        if (Math.abs(b.x - px) + Math.abs(b.z - pz) > 1e-4) b.yaw = Math.atan2(b.x - px, b.z - pz);
        wingA = Math.sin((t + b.delay * 7) * 26 * flap) * 0.9;
        lift = 0;
        put(pb, i, b.x, b.y + 0.07, b.z, -0.15, b.yaw, 0);
      }
      // wings: shoulder pivot either side of the body
      var cy = Math.cos(b.yaw), sy = Math.sin(b.yaw);
      var wy = b.y + 0.1 + lift;
      if (fl.state === 'ground') {           // wings folded into the body
        pw.setMatrixAt(i * 2, _ZERO); pw.setMatrixAt(i * 2 + 1, _ZERO);
      } else {
        put(pw, i * 2, b.x + cy * 0.06, wy, b.z - sy * 0.06, 0, b.yaw, wingA);
        put(pw, i * 2 + 1, b.x - cy * 0.06, wy, b.z + sy * 0.06, 0, b.yaw + Math.PI, wingA);
      }
    }
    pb.instanceMatrix.needsUpdate = true; pw.instanceMatrix.needsUpdate = true;
  }

  // ============================================================ STEAM
  var VENTS = [{ x: 32.6, z: -12 }, { x: -33, z: 16 }, { x: 10, z: 37.6 }, { x: -14, z: -37.8 }];
  var PUFFS = 14, steam = null, puffs = [];
  function buildSteam(g) {
    var tex = puffTexture();
    var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.72, color: 0xe8ecf0 });
    var geo = new THREE.PlaneGeometry(1, 1);
    steam = inst(geo, mat, VENTS.length * PUFFS, false);
    var coverM = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.5 });
    VENTS.forEach(function (v, vi) {
      var cover = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.03, 18), coverM);
      cover.position.set(v.x, 0.016, v.z); cover.receiveShadow = true; g.add(cover);
      for (var k = 0; k < PUFFS; k++) puffs.push({ v: vi, age: (k / PUFFS) * 4.2, life: 4.2, dx: jit(-0.15, 0.15), dz: jit(-0.15, 0.15), spin: jit(-0.6, 0.6) });
    });
    g.add(steam);
  }
  function updateSteam(dt) {
    var cam = LG.debug && LG.debug.camera;
    var face = cam ? Math.atan2(cam.position.x, cam.position.z) : 0;
    for (var i = 0; i < puffs.length; i++) {
      var p = puffs[i], v = VENTS[p.v];
      p.age += dt;
      if (p.age > p.life) { p.age -= p.life; p.dx = jit(-0.15, 0.15); p.dz = jit(-0.15, 0.15); }
      var u = p.age / p.life;
      var wind = u * u * 1.4;
      var size = 0.5 + u * 2.1;
      var x = v.x + p.dx + wind * 0.8, z = v.z + p.dz + wind * 0.35;
      var fx = cam ? Math.atan2(cam.position.x - x, cam.position.z - z) : face;
      // fade in fast, out slow (scale to 0 at the very end)
      var a = Math.min(1, u * 6) * (1 - u);
      put(steam, i, x, 0.2 + u * 3.6, z, 0, fx, p.spin * u, size * (0.3 + a * 0.7), size * (0.3 + a * 0.7), 1);
    }
    steam.instanceMatrix.needsUpdate = true;
  }
  function puffTexture() {
    var c = document.createElement('canvas'); c.width = 64; c.height = 64;
    var g = c.getContext('2d');
    if (g && g.createRadialGradient) {
      var gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
      gr.addColorStop(0, 'rgba(255,255,255,0.75)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    }
    return new THREE.CanvasTexture(c);
  }

  // ============================================================ FESTOON LIGHTS
  function buildFestoon(g) {
    var strands = [];
    [1, -1].forEach(function (zs) {
      // three strands zig-zag over each stand, hung from 5 m posts
      var z0 = zs * 24.2, z1 = zs * 27.6;
      strands.push([[-10.5, 5.2, z0], [-3.5, 5.0, z1]], [[-3.5, 5.0, z1], [3.5, 5.0, z0]], [[3.5, 5.0, z0], [10.5, 5.2, z1]]);
      strands.push([[-10.5, 5.2, z1], [10.5, 5.2, z1]]);
    });
    var wpos = [], bulbs = [];
    strands.forEach(function (s) {
      var a = s[0], b = s[1], N = 14, prev = null;
      for (var i = 0; i <= N; i++) {
        var u = i / N, sag = Math.sin(u * Math.PI) * 0.55;
        var p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - sag, a[2] + (b[2] - a[2]) * u];
        if (prev) wpos.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
        if (i % 2 === 1) bulbs.push(p);
        prev = p;
      }
    });
    var lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
    g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x15161a })));
    // posts at the strand ends
    var postM = new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.7, metalness: 0.4 });
    [[-10.5, 24.2], [10.5, 24.2], [-10.5, 27.6], [10.5, 27.6], [-3.5, 27.6], [3.5, 24.2]].forEach(function (q) {
      [1, -1].forEach(function (zs) {
        var post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 5.2, 8), postM);
        post.position.set(q[0], 2.6, zs * q[1]); post.castShadow = true; g.add(post);
      });
    });
    var bulbM = new THREE.MeshStandardMaterial({ color: 0xfff1cc, emissive: 0xffc768, emissiveIntensity: 1.6, roughness: 0.3 });
    var bulb = inst(new THREE.SphereGeometry(0.075, 8, 6), bulbM, bulbs.length, false);
    bulbs.forEach(function (p, i) { put(bulb, i, p[0], p[1] - 0.09, p[2]); });
    bulb.instanceMatrix.needsUpdate = true;
    g.add(bulb);
    return bulbs.length;
  }

  // ============================================================ FOOD CART
  var CART = { x: -25.4, z: 2, ry: Math.PI / 2 };   // west sidewalk, serving towards the court
  var smoke = null, smokeP = [], vendor = null, vendorP = { vx: 0, vz: 0, facing: Math.PI / 2, stamina: 1 };
  function buildCart(g) {
    var cart = new THREE.Group();
    var bodyM = new THREE.MeshStandardMaterial({ color: 0xc9d1d8, roughness: 0.35, metalness: 0.6 });
    var redM = new THREE.MeshStandardMaterial({ color: 0xd8432e, roughness: 0.6 });
    var darkM = new THREE.MeshStandardMaterial({ color: 0x1f2226, roughness: 0.8 });
    var box = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.95, 1.0), bodyM); box.position.y = 0.75; box.castShadow = true; cart.add(box);
    var band = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.22, 1.02), redM); band.position.y = 0.95; cart.add(band);
    var grill = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.7), darkM); grill.position.set(-0.45, 1.26, 0); cart.add(grill);
    var glow = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.01, 0.6), new THREE.MeshStandardMaterial({ color: 0x401000, emissive: 0xff5a1a, emissiveIntensity: 0.9 }));
    glow.position.set(-0.45, 1.295, 0); cart.add(glow);
    // food on the grill (one merged mesh)
    var sks = [];
    for (var k = 0; k < 5; k++) {
      var skg = new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6);
      skg.rotateX(Math.PI / 2); skg.translate(-0.72 + k * 0.13, 1.33, 0); sks.push(skg);
    }
    cart.add(new THREE.Mesh(merge(sks), new THREE.MeshStandardMaterial({ color: 0x7a3d1c, roughness: 0.7 })));
    [-0.75, 0.75].forEach(function (x) {
      var wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.08, 14), darkM);
      wheel.rotation.x = Math.PI / 2; wheel.position.set(x, 0.28, 0.55); cart.add(wheel);
    });
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), darkM); pole.position.set(0.4, 2.2, 0); cart.add(pole);
    // striped umbrella: one cone with a painted 8-gore stripe texture
    var uc = document.createElement('canvas'); uc.width = 128; uc.height = 8;
    var ug = uc.getContext('2d');
    if (ug && ug.fillRect) for (var i2 = 0; i2 < 8; i2++) { ug.fillStyle = i2 % 2 ? '#f4f1e8' : '#d8432e'; ug.fillRect(i2 * 16, 0, 16, 8); }
    var utex = new THREE.CanvasTexture(uc);
    if (THREE.sRGBEncoding !== undefined) utex.encoding = THREE.sRGBEncoding;
    utex.magFilter = THREE.NearestFilter; utex.generateMipmaps = false; utex.minFilter = THREE.LinearFilter;
    var umb = new THREE.Mesh(new THREE.ConeGeometry(1.45, 0.5, 24, 1, true),
      new THREE.MeshStandardMaterial({ map: utex, roughness: 0.85, side: THREE.DoubleSide }));
    umb.position.set(0.4, 3.35, 0); umb.castShadow = true; cart.add(umb);
    // menu board (canvas)
    var c = document.createElement('canvas'); c.width = 256; c.height = 128;
    var cg = c.getContext('2d');
    if (cg && cg.fillText) {
      cg.fillStyle = '#1d1f22'; cg.fillRect(0, 0, 256, 128);
      cg.fillStyle = '#ffd34d'; cg.font = '900 34px Arial, sans-serif'; cg.textAlign = 'center';
      cg.fillText('STREET EATS', 128, 46);
      cg.fillStyle = '#f2f2f2'; cg.font = '700 22px Arial, sans-serif';
      cg.fillText('SKEWERS  •  CORN  •  SODA', 128, 92);
    }
    var board = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.5), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c), roughness: 0.8 }));
    board.position.set(0, 0.58, 0.505); cart.add(board);
    cart.position.set(CART.x, 0, CART.z);
    cart.rotation.y = CART.ry;
    g.add(cart);
    // grill smoke (reuses the puff sprite)
    smoke = inst(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: puffTexture(), transparent: true, depthWrite: false, opacity: 0.4, color: 0xbfc3c8 }), 8, false);
    for (var s = 0; s < 8; s++) smokeP.push({ age: s * 0.45, life: 3.6 });
    g.add(smoke);
    // vendor: a real body once the athlete has loaded
    if (LG.Athlete && LG.Athlete.onReady) LG.Athlete.onReady(function () {
      var def = { id: 'vendor', palette: { shirt: 0xf4f1e8, trim: 0xd8432e, pants: 0x2b3a55, skin: 0xa9713f, hair: 0x1d1a17 }, hairStyle: 7, body: { tall: 0.97, wide: 1.1 } };
      var m = LG.Athlete.build(def, { design: 'tee', lite: true, idx: 99 });
      if (!m) return;
      // vendor stands behind the cart (court side is +x), facing the court
      m.group.position.set(CART.x - 0.95, 0, CART.z - 0.25);
      m.group.rotation.y = Math.PI / 2;
      vendorP.model = m;
      vendor = m;
      root.add(m.group);
    });
  }
  var vendorT = 4;
  function updateCart(dt) {
    var cam = LG.debug && LG.debug.camera;
    // grill is at local x=-0.45 -> world (rotated +90deg about y): z + 0.45
    var gx = CART.x, gz = CART.z + 0.45;
    for (var i = 0; i < smokeP.length; i++) {
      var p = smokeP[i];
      p.age += dt; if (p.age > p.life) p.age -= p.life;
      var u = p.age / p.life, size = 0.25 + u * 1.3, a = Math.min(1, u * 5) * (1 - u);
      var x = gx + u * u * 0.9, z = gz + u * 0.2;
      var fx = cam ? Math.atan2(cam.position.x - x, cam.position.z - z) : 0;
      put(smoke, i, x, 1.45 + u * 2.4, z, 0, fx, 0, size * (0.3 + a * 0.7), size * (0.3 + a * 0.7), 1);
    }
    smoke.instanceMatrix.needsUpdate = true;
    if (vendor && vendor.anim) {
      vendorT -= dt;
      if (vendorT < 0) { vendor.anim.emote(((t | 0) % 3) ? 'idle_look' : 'yes', { dur: 3, restart: true }); vendorT = 7; }
      vendor.anim.update(dt, vendorP);
    }
  }

  // ============================================================ LITTER
  var BITS = 16, litter = null, bits = [];
  function buildLitter(g) {
    var geo = new THREE.PlaneGeometry(0.16, 0.12);
    var mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    litter = inst(geo, mat, BITS, false);
    var c = new THREE.Color();
    var cols = [0xe9e4d6, 0xd7cdb2, 0x9a6b2f, 0xb5782a, 0x6f7f3a, 0xf2f2ee, 0xc9b28a];
    for (var i = 0; i < BITS; i++) {
      // half on the court surface, half out on the sidewalks
      var side = i % 2;
      bits.push({ x: side ? jit(-27, 27) : jit(-9, 9), z: side ? (rnd() < 0.5 ? jit(26, 33) : -jit(26, 33)) : jit(-20, 20),
        y: 0, rx: 0, rz: rnd() * 6.283, vx: 0, vz: 0, spin: 0, lim: side ? 34 : 10, limZ: side ? 34 : 21, side: side });
      c.setHex(cols[(rnd() * cols.length) | 0]); litter.setColorAt(i, c);
    }
    litter.instanceColor.needsUpdate = true;
    g.add(litter);
  }
  function updateLitter(dt) {
    // gusts: a slow wind that rises and falls, mostly along +x
    var gust = Math.max(0, Math.sin(t * 0.21) * Math.sin(t * 0.53 + 1.3));
    var wx = 0.5 + gust * 3.2, wz = Math.sin(t * 0.17) * 0.8 * gust;
    for (var i = 0; i < bits.length; i++) {
      var b = bits[i];
      var k = 0.6 + (i % 5) * 0.12;
      b.vx += (wx * k - b.vx) * Math.min(1, dt * 1.5);
      b.vz += (wz * k - b.vz) * Math.min(1, dt * 1.5);
      var spd = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
      var moving = spd > 1.1;
      if (!moving) { b.vx *= 0.9; b.vz *= 0.9; }
      b.x += (moving ? b.vx : b.vx * 0.05) * dt;
      b.z += (moving ? b.vz : b.vz * 0.05) * dt;
      b.spin += (moving ? spd * 3 : 0) * dt;
      b.y = moving ? 0.02 + Math.abs(Math.sin(b.spin * 0.7)) * 0.18 * gust : 0.012;
      // wrap inside its own area
      if (b.x > b.lim) b.x = -b.lim; if (b.x < -b.lim) b.x = b.lim;
      if (b.z > b.limZ) b.z = b.side ? 26 : -b.limZ; if (b.z < -b.limZ) b.z = b.side ? -26 : b.limZ;
      if (b.side && Math.abs(b.z) < 25.5) b.z = b.z < 0 ? -26 : 26;
      put(litter, i, b.x, b.y, b.z, moving ? -Math.PI / 2 + Math.sin(b.spin) * 0.9 : -Math.PI / 2, b.rz + b.spin * 0.3, moving ? Math.cos(b.spin * 1.3) * 0.6 : 0);
    }
    litter.instanceMatrix.needsUpdate = true;
  }

  // ============================================================ helpers
  function merge(list) {
    var pos = [], nor = [];
    list.forEach(function (g) {
      var n = g.index ? g.toNonIndexed() : g;
      pos.push.apply(pos, Array.prototype.slice.call(n.attributes.position.array));
      nor.push.apply(nor, Array.prototype.slice.call(n.attributes.normal.array));
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    return out;
  }

  var info = { bulbs: 0, pigeons: 0, vents: VENTS.length, litter: BITS };
  function build(scene) {
    if (built || !scene) return root;
    built = true;
    _s = 0xB10C5;
    root = new THREE.Group();
    root.name = 'streetlife';
    var parts = [buildPigeons, buildSteam, buildFestoon, buildCart, buildLitter];
    parts.forEach(function (fn) {
      try {
        var r = fn(root);
        if (fn === buildFestoon) info.bulbs = r;
      } catch (e) { if (window.console) console.warn('[STREETLIFE] ' + (fn.name || 'part') + ' skipped -> ' + (e && e.message)); }
    });
    info.pigeons = birds.length;
    scene.add(root);
    if (LG.eventBus && LG.eventBus.on) {
      // the goal roar sends every flock up
      LG.eventBus.on('goal', function () { for (var i = 0; i < flocks.length; i++) scare(i); });
    }
    return root;
  }
  function update(dt) {
    if (!built) return;
    dt = Math.min(0.05, dt || 0.016);
    t += dt;
    try { if (pb) updatePigeons(dt); } catch (e) { /* cosmetic */ }
    try { if (steam) updateSteam(dt); } catch (e) { /* cosmetic */ }
    try { if (smoke) updateCart(dt); } catch (e) { /* cosmetic */ }
    try { if (litter) updateLitter(dt); } catch (e) { /* cosmetic */ }
  }
  return {
    build: build, update: update,
    scare: function (i) { if (i == null) { for (var k = 0; k < flocks.length; k++) scare(k); } else scare(i); },
    info: function () { return { bulbs: info.bulbs, pigeons: info.pigeons, vents: info.vents, litter: info.litter, flocks: flocks.map(function (f) { return f.state; }), vendor: !!vendor }; },
  };
})();
