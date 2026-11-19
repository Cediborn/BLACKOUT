// ============================================================
// CROWD — instanced spectator system (Phase 3C).
//
// The previous crowd drew every spectator as an independent group of ~9
// meshes: ~108 bodies, 499 meshes, ~389 draw calls (~28% of the frame).
// This module keeps a comparable head count but renders it with a handful of
// InstancedMeshes — one shared geometry + material per body part,
// per-instance colour/transform — and drives all animation from 12 phase
// groups instead of one controller per spectator.
//
//   6 instanced draws  instead of  ~389 individual draws
//
// Spectators are also scaled to a believable human height (~1.5-1.7 units,
// comparable to the players) and laid out in jittered clusters with home /
// away / side allegiance colours.
//
// Presentation only: nothing here touches players, ball, physics, AI,
// camera, kickoff orientation or scoring. No Math.random anywhere on the
// mid-match paths (private seed-pinned PRNG) so the simulation stream that
// the regression tests replay stays bit-identical.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Crowd = (function () {
  var CHEER_DUR = 2.8;   // goal reaction window
  var SWELL_DUR = 0.9;   // shot reaction window
  var NG_PER_SEC = 4;    // phase groups per section
  var SECTIONS = ['home', 'away', 'side'];
  // reaction stagger — nobody reacts at exactly the same instant
  var SEC_DELAY = { home: 0.0, away: 0.08, side: 0.14 };

  var HIP_FEET = 0.74;   // hip -> foot bottom, standing (feeds arena layout)

  var placements = [];
  var specs = [];
  var groups = [];
  var parts = null;
  var root = null;
  var bound = false;
  var t = 0, cheerT = 0, swellT = 0;
  var groanT = 0, clapT = 0, shotAt = -99, goalAt = -99, scoringSec = null;
  var GROAN_DUR = 1.6, CLAP_DUR = 1.8;
  var initMs = 0;
  // goal-reaction field (3D.4): per-spectator amplitude/delay primed once
  // per goal, read back by stats() for the probes
  var _reactMin = 1, _reactMax = 1, _primes = 0;
  var _cel = null;         // celebration variant that primed the last goal
  // 3D.6: celebration variant nudges the peak — group moments roar a touch
  // more, an own-goal shrug barely moves. Subtle by design (max +12%).
  var CEL_K = {
    huddle: 1.12, group: 1.12, wide: 1.06, slide: 1.06,
    signature: 1.04, point: 1.0, arms: 1.0, calm: 0.85,
  };

  // private deterministic PRNG — layout must not touch Math.random
  var _s = 0x5EED03;
  function prand() {
    _s = (_s * 1664525 + 1013904223) >>> 0;
    return _s / 4294967296;
  }
  function jit(a, b) { return a + (b - a) * prand(); }
  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  // ---------------- palettes ----------------
  var NEUTRAL = [
    0x3d4a63, 0x6b3d66, 0x3d6b50, 0x6b603d, 0x8b4a3a, 0x3a6b8b,
    0x7a5a2b, 0x5a3d7a, 0x2f6b6b, 0x8b5a2f, 0x4a5a2f, 0x7a3d4a,
  ];
  // subtle allegiance families (home = cyan/blue, away = red). Never the
  // whole section, so the crowd stays readable and never reads as one team.
  var HOME_TINT = [0x2f6b8b, 0x35788f, 0x2f7f9b, 0x3a6b8b, 0x2a5a7a, 0x3d5f7a];
  var AWAY_TINT = [0x8b3a45, 0x7a3d4a, 0x6b3d4a, 0x8b4a3a, 0x7a3040, 0x7a4550];
  var ACCENT = { home: 0x35e0ff, away: 0xff4d5e, side: null };
  var PANTS = [0x2a2e38, 0x3a3038, 0x2e3a2e, 0x3a3a3a, 0x4a3a2a, 0x22262e];
  var SKIN = [0xc99a76, 0xe0b48f, 0x8d5a3b, 0x6b4229, 0xa9744f, 0xd8a778];

  function pickColour(sec) {
    if (sec === 'side') return NEUTRAL[(prand() * NEUTRAL.length) | 0];
    var r = prand();
    var accent = ACCENT[sec];
    if (accent != null && r < 0.06) return accent;            // rare scarf/jersey pop
    if (r < 0.58) {
      var fam = sec === 'home' ? HOME_TINT : AWAY_TINT;
      return fam[(prand() * fam.length) | 0];
    }
    return NEUTRAL[(prand() * NEUTRAL.length) | 0];
  }

  // ---------------- geometry ----------------
  // Body space: hip pivot at the origin, +Y up, facing +Z at yaw 0.
  // Standing height = 0.7375 (feet) + 0.915 (head top) = 1.65 units before
  // the per-spectator scale (0.93-1.07) — comparable to a player.
  function box(w, h, d, x, y, z) {
    var g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  }
  // minimal merge for Box/Sphere/Capsule pieces (three r147 ships no
  // BufferGeometryUtils) — concatenates non-indexed position/normal/uv
  function merge(list) {
    var pos = [], nor = [], uv = [], idx = [], off = 0;
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      var ng = g.index ? g.toNonIndexed() : g;
      var p = ng.attributes.position, n = ng.attributes.normal, u = ng.attributes.uv;
      for (var k = 0; k < p.count; k++) {
        pos.push(p.getX(k), p.getY(k), p.getZ(k));
        nor.push(n.getX(k), n.getY(k), n.getZ(k));
        uv.push(u ? u.getX(k) : 0, u ? u.getY(k) : 0);
        idx.push(off + k);
      }
      off += p.count;
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    out.setIndex(idx);
    return out;
  }

  function buildGeometries() {
    // Phase 11: rounded limbs (capsules) instead of boxes
    function cap(r, len, x, y, z) {
      var g = new THREE.CapsuleGeometry(r, len, 2, 6);
      g.translate(x, y, z);
      return g;
    }
    var legs = merge([
      cap(0.062, 0.58, -0.105, -0.36, 0.012),
      cap(0.062, 0.58, 0.105, -0.36, 0.012),
      box(0.125, 0.075, 0.21, -0.105, -0.70, 0.045),
      box(0.125, 0.075, 0.21, 0.105, -0.70, 0.045),
    ]);
    var hip = box(0.30, 0.17, 0.19, 0, 0.045, 0);

    // torso: 0.74 tall capsule, origin at the waist; top (0.72) carries the
    // neck at 0.68 and the shoulders at 0.60 so nothing floats
    var torso = new THREE.CapsuleGeometry(0.16, 0.42, 3, 7);
    torso.translate(0, 0.36, 0);

    var head = new THREE.SphereGeometry(0.115, 8, 6);
    head.translate(0, 0.12, 0.012);   // origin -> neck pivot (top at +0.915)

    var arm = new THREE.CapsuleGeometry(0.046, 0.24, 2, 6);
    arm.translate(0, -0.16, 0);                       // origin -> shoulder
    var hand = new THREE.SphereGeometry(0.055, 5, 4);
    hand.translate(0, -0.33, 0);                      // origin -> shoulder

    return { legs: legs, hip: hip, torso: torso, head: head, arm: arm, hand: hand };
  }

  function makePart(geo, mat, count, castShadow) {
    var m = new THREE.InstancedMesh(geo, mat, count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;   // bounce moves instances inside the bound volume
    m.castShadow = !!castShadow;
    return m;
  }

  // ---------------- static per-spectator anchors ----------------
  // Anchors fold the constant transform (pivot translate, posture, static
  // lean/yaw, arm spread) so the per-frame cost is 1-2 matrix multiplies per
  // body part instead of a chain.
  var HIP = new THREE.Vector3(0, 0, 0);
  var WAIST = new THREE.Vector3(0, 0.10, 0);
  var NECK = new THREE.Vector3(0, 0.68, 0);
  var SH = new THREE.Vector3(0.215, 0.60, 0);
  var SH2 = new THREE.Vector3(-0.215, 0.60, 0);

  function anchor(pos, rx, ry, rz) {
    var e = new THREE.Euler(rx || 0, ry || 0, rz || 0, 'YXZ');
    return new THREE.Matrix4().compose(
      pos, new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(1, 1, 1));
  }

  function makeSpec(p) {
    var sec = p.section || 'side';
    var pool = [];
    for (var i = 0; i < groups.length; i++) if (groups[i].sec === sec) pool.push(groups[i]);
    var g = pool.length ? pool[(prand() * pool.length) | 0] : groups[0];
    var sit = !!p.sit;

    return {
      g: g, sec: sec, sit: sit,
      x: p.x + jit(-0.1, 0.1), z: p.z + jit(-0.1, 0.1),
      baseY: p.y, yaw: p.yaw + jit(-0.34, 0.34),
      scale: p.scale || jit(0.93, 1.07),
      bobK: sit ? 0.30 : jit(0.85, 1.15),
      swayK: jit(0.7, 1.35),
      leanK: jit(0.8, 1.3),
      headK: jit(0.7, 1.4),
      armK: jit(0.9, 1.1),
      reactK: 1,                                  // goal reaction amplitude
      // Phase 11: individual life — own arms, own gaze, own idle actions
      aLx: -0.1, aLz: 0, aRx: -0.1, aRz: 0, hy: 0, ty: 0, tilt: 0,
      actOff: jit(0, 30), actDur: jit(4.5, 9.5), seed: (prand() * 4294967296) >>> 0,
      rDelay: SEC_DELAY[sec] + (g ? g.micro : 0), // stable per-spec delay
      aLegs: sit ? anchor(HIP, -1.0 + jit(-0.12, 0.12), 0, 0) : anchor(HIP, 0, 0, 0),
      aHip: anchor(HIP, 0, 0, 0),
      aTorso: anchor(WAIST, jit(-0.07, 0.09), 0, 0),
      aHead: anchor(NECK, 0, jit(-0.16, 0.16), 0),
      aArmL: anchor(SH, 0, 0, jit(0.12, 0.34)),
      aArmR: anchor(SH2, 0, 0, -jit(0.12, 0.34)),
      shirt: pickColour(sec),
      pants: PANTS[(prand() * PANTS.length) | 0],
      skin: SKIN[(prand() * SKIN.length) | 0],
    };
  }

  // ---------------- build ----------------
  function begin() { placements.length = 0; }

  function put(o) { if (o) placements.push(o); }

  function build() {
    var t0 = now();
    _s = 0x5EED03;                 // deterministic layout every boot
    _reactMin = 1; _reactMax = 1; _primes = 0; _cel = null;
    root = new THREE.Group();
    root.name = 'crowd';
    specs = [];
    groups = [];
    parts = null;

    for (var si = 0; si < SECTIONS.length; si++) {
      for (var k = 0; k < NG_PER_SEC; k++) {
        groups.push({
          sec: SECTIONS[si], ph: prand() * 6.283, micro: jit(0.02, 0.24),
          amp: jit(0.85, 1.15), b: 0, bounce: 0, arm: 0, lean: 0, head: 0, sway: 0,
        });
      }
    }
    for (var i = 0; i < placements.length; i++) specs.push(makeSpec(placements[i]));

    var N = specs.length;
    if (N) {
      var geos = buildGeometries();
      var white = function () { return new THREE.MeshLambertMaterial({ color: 0xffffff }); };
      parts = {
        legs: makePart(geos.legs, white(), N, false),
        hip: makePart(geos.hip, white(), N, false),
        torso: makePart(geos.torso, white(), N, true),
        head: makePart(geos.head, white(), N, false),
        arm: makePart(geos.arm, white(), N * 2, false),
        hand: makePart(geos.hand, white(), N * 2, false),
      };
      // materials are separate instances so the three body-colour families
      // stay independent even though each base colour is white (modulated by
      // instanceColor)
      var c = new THREE.Color();
      for (i = 0; i < N; i++) {
        var s = specs[i];
        c.setHex(s.shirt);
        parts.torso.setColorAt(i, c);
        parts.arm.setColorAt(i * 2, c); parts.arm.setColorAt(i * 2 + 1, c);
        c.setHex(s.pants);
        parts.legs.setColorAt(i, c); parts.hip.setColorAt(i, c);
        c.setHex(s.skin);
        parts.head.setColorAt(i, c);
        parts.hand.setColorAt(i * 2, c); parts.hand.setColorAt(i * 2 + 1, c);
      }
      var names = ['legs', 'hip', 'torso', 'head', 'arm', 'hand'];
      for (i = 0; i < names.length; i++) {
        var pm = parts[names[i]];
        if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
        root.add(pm);
      }
      update(0);
      initMs = now() - t0;
      if (window.console && console.log) {
        console.log('[CROWD] build ' + initMs.toFixed(1) + 'ms bodies=' + N +
          ' draws=6 tris≈' + estimateTris(geos, N));
      }
    } else {
      initMs = now() - t0;
    }
    bind();
    return root;
  }

  function estimateTris(geos, n) {
    var total = 0;
    var names = ['legs', 'hip', 'torso', 'head', 'arm', 'hand'];
    for (var i = 0; i < names.length; i++) {
      var g = geos[names[i]];
      var c = (g.index && g.index.count) ||
        (g.attributes && g.attributes.position && g.attributes.position.count) || 0;
      total += c / 3 * (names[i] === 'arm' || names[i] === 'hand' ? 2 : 1);
    }
    return Math.round(total * n);
  }

  // ---------------- events ----------------
  // Prime the goal-reaction field (3D.4): amplitude falls off with distance
  // from the scorer, the scoring section swells a touch, the conceding
  // section stays flat (own goals: distance only). Delay keeps the section
  // stagger plus a stable index-hash spread — decided ONCE here, never
  // per frame, so each fan's reaction reads as one coherent rise-and-fall.
  function primeReact(g) {
    if (!g || !g.scorer || !specs.length) return;
    try {
      var sx = g.scorer.x, sz = g.scorer.z;
      scoringSec = (g.isOwnGoal || typeof g.team !== 'number') ? null
        : (g.team === 0 ? 'home' : 'away');
      // 3D.6: one shared intensity factor from the celebration variant —
      // decided once, applied before the section multipliers below
      var cel = LG.Celebration && LG.Celebration.current;
      var vk = (cel && typeof CEL_K[cel.type] === 'number') ? CEL_K[cel.type] : 1;
      _cel = cel && typeof cel.type === 'string' ? cel.type : null;
      var mn = 1e9, mx = -1e9;
      for (var i = 0; i < specs.length; i++) {
        var s = specs[i];
        var dx = s.x - sx, dz = s.z - sz;
        var k = LG.Util.clamp((1.18 - Math.sqrt(dx * dx + dz * dz) * 0.045) * vk, 0.38, 1.18);
        if (scoringSec && s.sec === scoringSec) k = Math.min(1.25, k * 1.06);
        else if (s.sec === 'side') k *= 0.9;
        else if (scoringSec) k *= 0.55;
        s.reactK = k;
        s.rDelay = SEC_DELAY[s.sec] + (s.g ? s.g.micro : 0) +
          (((i * 2654435761) >>> 12) & 0x1ff) / 512 * 0.3;
        if (k < mn) mn = k;
        if (k > mx) mx = k;
      }
      _reactMin = mn;
      _reactMax = mx;
      _primes++;
    } catch (e) { /* uniform reaction is the fallback */ }
  }

  function bind() {
    if (bound || !LG.eventBus || !LG.eventBus.on) return;
    LG.eventBus.on('goal', function (g) { cheerT = CHEER_DUR; goalAt = t; groanT = 0; primeReact(g); });
    // a save or a big tackle earns applause; a shot that doesn't score gets
    // the hands-on-heads "ooh" a moment later (see update)
    LG.eventBus.on('keeperSave', function () { clapT = CLAP_DUR; });
    LG.eventBus.on('postHit', function () { groanT = GROAN_DUR; });
    LG.eventBus.on('kickoff', function () { scoringSec = null; });
    // shot reaction: only real efforts swell (the weak poke emits power 0.4)
    LG.eventBus.on('shoot', function (ev) {
      if (ev && typeof ev.power === 'number' && ev.power < 0.5) return;
      swellT = SWELL_DUR;
      shotAt = t;
    });
    bound = true;
  }

  // ---------------- animation ----------------
  var _B = new THREE.Matrix4(), _T = new THREE.Matrix4(), _R = new THREE.Matrix4();
  var _P = new THREE.Vector3(), _S = new THREE.Vector3(), _Q = new THREE.Quaternion();
  var _E = new THREE.Euler(0, 0, 0, 'YXZ');
  var _E2 = new THREE.Euler(0, 0, 0, 'XYZ');
  var PART_ORDER = ['legs', 'hip', 'torso', 'head', 'arm', 'hand'];

  function update(dt) {
    if (!specs.length || !parts) return;
    t += dt;
    if (cheerT > 0) cheerT = Math.max(0, cheerT - dt);
    if (swellT > 0) swellT = Math.max(0, swellT - dt);
    if (groanT > 0) groanT = Math.max(0, groanT - dt);
    if (clapT > 0) clapT = Math.max(0, clapT - dt);
    // a real shot that has not become a goal 1.1 s later = "ooh"
    if (shotAt > -90 && t - shotAt > 1.1) {
      if (goalAt < shotAt) groanT = Math.max(groanT, GROAN_DUR);
      shotAt = -99;
    }
    // where the ball is: fans watch it, and the near end leans in
    var bx = 0, bz = 0, hasBall = false;
    try {
      var M = LG.Match;
      if (M && M.ball && isFinite(M.ball.x)) { bx = M.ball.x; bz = M.ball.z; hasBall = true; }
    } catch (e) { hasBall = false; }

    var elapsed = CHEER_DUR - cheerT;
    var swellE = SWELL_DUR - swellT;
    var i, g;

    // one curve per phase group — 12 evaluations instead of ~120 controllers
    for (i = 0; i < groups.length; i++) {
      g = groups[i];
      var gb = 0;
      if (cheerT > 0) {
        var e = elapsed - SEC_DELAY[g.sec] - g.micro;
        if (e > 0) gb = Math.min(1, e / 0.15) * Math.max(0, 1 - e / (CHEER_DUR - 0.6));
      }
      var sb = 0;
      if (swellT > 0) {
        var es = swellE - g.micro * 0.8;
        if (es > 0) sb = 0.42 * Math.min(1, es / 0.12) *
          Math.max(0, 1 - es / (SWELL_DUR - 0.25));
      }
      var b = gb + sb > 1 ? 1 : gb + sb;
      g.gb = gb;                  // goal envelope (per-spec scaled in loop 2)
      g.sb = sb;                  // shot swell (shared)
      g.b = b;                    // legacy aggregate, kept for stats()
      var ph = g.ph, A = g.amp;
      // idle + cheer components, split so loop 2 can recombine per fan
      // (bounce/lean/head/sway are linear in b; arm mixes through m)
      g.idleArm = -0.09 - 0.05 * Math.sin(t * 1.15 + ph * 1.3);
      g.cheerArm = -2.45 + 0.22 * Math.sin(t * 9 + ph);
      var m = Math.min(1, b * 1.25);
      g.arm = g.idleArm * (1 - m) + g.cheerArm * m;
      g.bI = A * 0.011 * Math.sin(t * 1.5 + ph);
      g.bC = A * 0.13 * Math.pow(Math.max(0, Math.sin(t * 7.5 + ph)), 0.7);
      g.bounce = g.bI + b * g.bC;
      g.lI = A * 0.03 * Math.sin(t * 0.9 + ph);
      g.lC = A * 0.10 * Math.sin(t * 7 + ph);
      g.lean = g.lI + b * g.lC;
      g.hI = A * 0.17 * Math.sin(t * 0.55 + ph * 1.7);
      g.hC = A * 0.12 * Math.sin(t * 6.5);
      g.head = g.hI + b * g.hC;
      g.sI = A * 0.02 * Math.sin(t * 0.8 + ph);
      g.sC = A * 0.05 * Math.sin(t * 6.5 + ph);
      g.sway = g.sI + b * g.sC;
    }

    var N = specs.length;
    for (i = 0; i < N; i++) {
      var s = specs[i], gg = s.g;
      // per-fan goal envelope: own delay + primed amplitude (3D.4). Pre-goal
      // this is exactly the group curve (reactK=1, rDelay=section+micro).
      var pb = 0;
      if (cheerT > 0) {
        var pe = elapsed - s.rDelay;
        if (pe > 0) pb = Math.min(1, pe / 0.15) * Math.max(0, 1 - pe / (CHEER_DUR - 0.6));
      }
      var b2 = pb * s.reactK + gg.sb;
      if (b2 > 1) b2 = 1;
      var m2 = Math.min(1, b2 * 1.25);
      var arm = gg.idleArm * (1 - m2) + gg.cheerArm * m2;
      var bounce = gg.bI + b2 * gg.bC;
      var lean = gg.lI + b2 * gg.lC;
      var head = gg.hI + b2 * gg.hC;
      var sway = gg.sI + b2 * gg.sC;

      // ---- Phase 11: individual behaviour on top of the group curves ----
      var k = Math.min(1, dt * 6);
      // gaze: follow the ball (head mostly, shoulders a little)
      if (hasBall) {
        var want = Math.atan2(bx - s.x, bz - s.z) - s.yaw;
        want = Math.atan2(Math.sin(want), Math.cos(want));
        if (want > 1.25) want = 1.25; else if (want < -1.25) want = -1.25;
        s.hy += (want - s.hy) * Math.min(1, dt * (2.2 + (s.seed & 3) * 0.4));
      }
      var dB = hasBall ? Math.sqrt((bx - s.x) * (bx - s.x) + (bz - s.z) * (bz - s.z)) : 99;
      var tense = dB < 15 ? (1 - dB / 15) : 0;          // the ball is near: lean in, stop fidgeting
      // idle action, picked per time slot from a stable hash (no RNG)
      var slot = Math.floor((t + s.actOff) / s.actDur);
      var hsh = ((s.seed ^ (slot * 2654435761)) >>> 0) % 100;
      var act = tense > 0.35 ? 'watch'
        : hsh < 38 ? 'rest' : hsh < 52 ? 'clap' : hsh < 62 ? 'point' : hsh < 72 ? 'hips'
        : hsh < 80 ? 'wave' : hsh < 90 ? 'fold' : 'talk';
      var lx = -0.08, lz = 0, rx = -0.08, rz = 0, tilt = 0, look = 0;
      var tt = t + s.actOff;
      switch (act) {
        case 'clap': lx = rx = -1.15; lz = -0.42 + 0.2 * Math.sin(tt * 13); rz = -lz; break;
        case 'point': rx = -1.55; rz = -0.12; break;
        case 'hips': lx = rx = 0.22; lz = 0.62; rz = -0.62; break;
        case 'wave': rx = -2.75; rz = -0.15 + 0.32 * Math.sin(tt * 7.5); break;
        case 'fold': lx = rx = -0.62; lz = -0.75; rz = 0.75; break;
        case 'talk': look = ((s.seed >> 3) & 1 ? 1 : -1) * 0.95; rx = -0.45 + 0.18 * Math.sin(tt * 3.1); break;
        case 'watch': tilt = 0.14 * tense; break;
      }
      // events override the idle action
      var concede = cheerT > 0 && scoringSec && s.sec !== 'side' && s.sec !== scoringSec;
      if (concede) {                                   // hands on heads, slumped
        lx = rx = -2.75; lz = -0.55; rz = 0.55; tilt = 0.18; arm = 0; bounce = 0;
      } else if (groanT > 0 && cheerT <= 0) {          // "ooh" — so close
        var gk2 = Math.min(1, (GROAN_DUR - groanT) / 0.2) * Math.min(1, groanT / 0.35);
        lx = lx * (1 - gk2) + -2.8 * gk2; rx = rx * (1 - gk2) + -2.8 * gk2;
        lz = lz * (1 - gk2) + -0.5 * gk2; rz = rz * (1 - gk2) + 0.5 * gk2;
        tilt = -0.1 * gk2;
      } else if (clapT > 0 && cheerT <= 0) {           // applause
        lx = rx = -1.2; lz = -0.42 + 0.2 * Math.sin(t * 15 + (s.seed & 7)); rz = -lz;
      }
      s.aLx += (lx - s.aLx) * k; s.aLz += (lz - s.aLz) * k;
      s.aRx += (rx - s.aRx) * k; s.aRz += (rz - s.aRz) * k;
      s.ty += (look - s.ty) * Math.min(1, dt * 3);
      s.tilt += (tilt - s.tilt) * Math.min(1, dt * 4);
      // the group cheer still drives raised arms on a goal (both arms)
      var cheerW = concede ? 0 : m2;
      var aLx = s.aLx * (1 - cheerW) + arm * cheerW, aRx = s.aRx * (1 - cheerW) + arm * cheerW;
      var aLz = s.aLz * (1 - cheerW), aRz = s.aRz * (1 - cheerW);
      head = head * 0.35 + s.hy * 0.85 + s.ty;
      lean = lean + s.tilt;

      _P.set(s.x, s.baseY + bounce * s.bobK, s.z);
      _E.set(0, s.yaw + sway * s.swayK + s.hy * 0.18, 0);
      _Q.setFromEuler(_E);
      _S.setScalar(s.scale);
      _B.compose(_P, _Q, _S);

      _T.multiplyMatrices(_B, s.aLegs);
      parts.legs.setMatrixAt(i, _T);
      _T.multiplyMatrices(_B, s.aHip);
      parts.hip.setMatrixAt(i, _T);

      _R.makeRotationX(lean * s.leanK);
      _T.multiplyMatrices(_B, s.aTorso);
      _T.multiply(_R);
      parts.torso.setMatrixAt(i, _T);

      _R.makeRotationY(head * s.headK);
      _T.multiplyMatrices(_B, s.aHead);
      _T.multiply(_R);
      parts.head.setMatrixAt(i, _T);

      _E2.set(aLx * s.armK, 0, aLz);
      _R.makeRotationFromEuler(_E2);
      _T.multiplyMatrices(_B, s.aArmL);
      _T.multiply(_R);
      parts.arm.setMatrixAt(i * 2, _T);
      parts.hand.setMatrixAt(i * 2, _T);
      _E2.set(aRx * s.armK, 0, aRz);
      _R.makeRotationFromEuler(_E2);
      _T.multiplyMatrices(_B, s.aArmR);
      _T.multiply(_R);
      parts.arm.setMatrixAt(i * 2 + 1, _T);
      parts.hand.setMatrixAt(i * 2 + 1, _T);
    }

    for (i = 0; i < PART_ORDER.length; i++) {
      var pm = parts[PART_ORDER[i]];
      if (pm) pm.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    begin: begin,
    put: put,
    build: build,
    update: update,
    hipFeet: HIP_FEET,
    get stats() {
      return {
        bodies: specs.length, initMs: initMs, groups: groups.length,
        cheer: cheerT, swell: swellT, arm0: groups.length ? groups[0].arm : 0,
        reactMin: _reactMin, reactMax: _reactMax, primes: _primes, cel: _cel,
      };
    },
  };
})();
