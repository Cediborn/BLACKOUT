// ============================================================
// CAMERA — five selectable match cameras (Build 7)
//
//   1 TELE BROADCAST   high in the stand, long lens: flat, TV-like, calm
//   2 WIDE TACTICAL    the original high, wide view — most of the pitch
//   3 DYNAMIC BROADCAST closer, leads the play, swings to the action angle
//   4 CLOSE ACTION     low and tight on the controlled player
//   5 PLAYER FOCUS     the closest: boots, touches and skill moves up close
//
// Every preset keeps the SAME screen axes for the current VIEW (portrait:
// behind the play on +z looking at -z; landscape: off the east touchline
// looking west), so the stick and buttons never change meaning. What each
// preset changes: height, distance, lens (fov), how much the ball pulls the
// frame, how far it leads the runner, how fast it reacts, how far it may
// drift, and (DYNAMIC) a swing toward the attacking direction.
// Switching blends every number over ~0.7 s — no cut. The closer presets
// widen automatically when the ball is far from your player, so passes,
// shots and the keeper stay in frame, and the camera is pulled in front of
// anything solid between it and the play (it never sits inside a wall).
// ============================================================
var LG = window.LG = window.LG || {};

LG.CameraPresets = [
  null,
  { id: 1, name: 'TELE BROADCAST',
    portrait:  { height: 26, distance: 34, fov: 30, ballW: 0.55, lead: 0.15, damp: 4.5, xClamp: 9,  zClamp: 17, lookY: 0.6, swing: 0 },
    landscape: { height: 21, distance: 36, fov: 29, ballW: 0.55, lead: 0.15, damp: 4.5, xClamp: 3,  zClamp: 15, lookY: 0.6, swing: 0 } },
  { id: 2, name: 'WIDE TACTICAL',
    portrait:  { height: 30, distance: 25, fov: 50, ballW: 0.42, lead: 0.24, damp: 6.5, xClamp: 11, zClamp: 18.5, lookY: 1.0, swing: 0 },
    landscape: { height: 30, distance: 25, fov: 54, ballW: 0.42, lead: 0.24, damp: 6.5, xClamp: 4,  zClamp: 14, lookY: 1.0, swing: 0 } },
  { id: 3, name: 'DYNAMIC BROADCAST',
    portrait:  { height: 13, distance: 16, fov: 46, ballW: 0.42, lead: 0.5, damp: 5.5, xClamp: 11, zClamp: 19, lookY: 1.0, swing: 4.5 },
    landscape: { height: 12, distance: 17, fov: 47, ballW: 0.42, lead: 0.5, damp: 5.5, xClamp: 8,  zClamp: 18, lookY: 1.0, swing: 4.5 } },
  { id: 4, name: 'CLOSE ACTION',
    portrait:  { height: 8.2, distance: 11, fov: 50, ballW: 0.3, lead: 0.36, damp: 7.5, xClamp: 12, zClamp: 20, lookY: 1.0, swing: 2 },
    landscape: { height: 7.6, distance: 11.5, fov: 50, ballW: 0.3, lead: 0.36, damp: 7.5, xClamp: 10, zClamp: 20, lookY: 1.0, swing: 2 } },
  { id: 5, name: 'PLAYER FOCUS',
    portrait:  { height: 5.0, distance: 7.4, fov: 54, ballW: 0.2, lead: 0.24, damp: 9, xClamp: 13, zClamp: 21, lookY: 1.1, swing: 1 },
    landscape: { height: 4.8, distance: 7.6, fov: 54, ballW: 0.2, lead: 0.24, damp: 9, xClamp: 12, zClamp: 21, lookY: 1.1, swing: 1 } },
];

LG.MatchCamera = function (camera) {
  this.camera = camera;
  this.followX = 0;
  this.followZ = 0;
  this.shakeT = 0;
  this.shakeAmp = 0;
  this.zoomPulse = 0;
  this._dbgMode = null;
  this.cur = null;            // the live (blended) numbers
  this._preset = null;
  this.swingZ = 0;
  this._occT = 0; this._occK = 1;
};

LG.MatchCamera.prototype = {
  isLandscape: function () {
    return !!(LG.Settings && LG.Settings.isLandscape && LG.Settings.isLandscape());
  },

  presetId: function () {
    var n = LG.Settings && LG.Settings.camera ? LG.Settings.camera() : 2;
    return LG.CameraPresets[n] ? n : 2;
  },

  // the target numbers for the chosen preset + view. WIDE TACTICAL returns
  // the Config.camera objects themselves (the original framing, tested).
  cfg: function () {
    var C = LG.Config.camera;
    var land = this.isLandscape();
    var id = this.presetId();
    if (id === 2) return land && C.landscape ? C.landscape : C;
    var P = LG.CameraPresets[id];
    return land ? P.landscape : P.portrait;
  },

  target: function () {
    var c = this.cfg(), land = this.isLandscape(), P = LG.CameraPresets[this.presetId()][land ? 'landscape' : 'portrait'];
    return {
      height: c.height, distance: c.distance, fov: c.fov,
      xClamp: c.xClamp, zClamp: c.zClamp,
      ballW: P.ballW, lead: P.lead, damp: P.damp, lookY: P.lookY, swing: P.swing,
    };
  },

  reset: function () {
    var land = this.isLandscape();
    var C = this.target();
    this.cur = Object.assign({}, C);
    this._preset = this.presetId() + (land ? 'L' : 'P');
    this.followX = 0; this.followZ = 0; this.swingZ = 0;
    this.shakeT = 0; this.zoomPulse = 0;
    this.camera.fov = C.fov;
    if (land) {
      this.camera.position.set(C.distance, C.height, 0);
      this.camera.lookAt(0, 1, 0);
    } else {
      this.camera.position.set(0, C.height, C.distance);
      this.camera.lookAt(0, 0, 0);
    }
    this.camera.updateProjectionMatrix();
  },

  shake: function (dur, amp) {
    if (LG.Settings && LG.Settings.reducedMotion && LG.Settings.reducedMotion()) return;
    this.shakeT = Math.max(this.shakeT, dur);
    this.shakeAmp = Math.max(this.shakeAmp, amp);
  },
  pulse: function (v) {
    if (LG.Settings && LG.Settings.reducedMotion && LG.Settings.reducedMotion()) return;
    this.zoomPulse = Math.max(this.zoomPulse, v);
  },

  // blend the live numbers toward the chosen preset (no cut on a switch)
  blend: function (dt) {
    var T = this.target(), key = this.presetId() + (this.isLandscape() ? 'L' : 'P');
    if (!this.cur) this.cur = Object.assign({}, T);
    if (this._preset !== key) {
      // a VIEW flip is a different world axis: snap; a preset switch blends
      if (this._preset && this._preset.slice(-1) !== key.slice(-1)) this.cur = Object.assign({}, T);
      this._preset = key;
    }
    var k = 1 - Math.exp(-dt * 4.2);
    for (var n in T) this.cur[n] += (T[n] - this.cur[n]) * k;
    return this.cur;
  },

  // keep the camera out of buildings, stands and fences: a cheap ray from
  // the look point to the camera every few frames; ease in front of a hit
  occlusion: function (lx, ly, lz, cx, cy, cz, dt) {
    this._occT -= dt;
    if (this._occT <= 0 && LG.debug && LG.debug.arena && window.THREE) {
      this._occT = 0.12;
      if (!this._ray) { this._ray = new THREE.Raycaster(); this._o = new THREE.Vector3(); this._d = new THREE.Vector3(); }
      this._o.set(lx, ly, lz);
      this._d.set(cx - lx, cy - ly, cz - lz);
      var len = this._d.length();
      this._d.normalize();
      this._ray.set(this._o, this._d);
      this._ray.far = len;
      var want = 1;
      try {
        var hits = this._ray.intersectObject(LG.debug.arena, true);
        for (var i = 0; i < hits.length; i++) {
          var h = hits[i], o = h.object, m = o.material;
          if (!o.visible || (m && (m.transparent || m.wireframe)) || h.distance < 3) continue;
          want = Math.max(0.35, (h.distance - 0.6) / len);
          break;
        }
      } catch (e) { /* never break the frame for this */ }
      this._occWant = want;
    }
    var w = this._occWant == null ? 1 : this._occWant;
    this._occK += (w - this._occK) * Math.min(1, dt * (w < this._occK ? 10 : 2.5));
    return this._occK;
  },

  // shared with the goal cinematic so its hand-back pose matches exactly
  venueClamp: function (cx, cz, land, C) {
    if (C.distance < 20) {
      var CC = LG.Config.court, hl = CC.length / 2 + 1.6, hw = CC.width / 2 + 1.6;
      if (land) { if (cx > hw) cx = hw; }
      else { if (cz > hl) cz = hl; if (cz < -hl - 6) cz = -hl - 6; cx = Math.max(-hw, Math.min(hw, cx)); }
    }
    return { x: cx, z: cz };
  },

  // where the ball lands on screen with the pose just set: grows 'keep'
  // when it nears an edge, relaxes it once the ball is comfortably inside
  watchBall: function (dt, bx, bz) {
    if (!(dt > 0) || bx === undefined) return;
    var cam = this.camera;
    // only on a real three.js camera (the node probes run stubbed THREE)
    if (cam.isPerspectiveCamera !== true || typeof THREE === 'undefined') return;
    cam.updateMatrixWorld();
    var v = this._bv || (this._bv = new THREE.Vector3());
    if (!v.project) return;
    v.set(bx, 0.3, bz).project(cam);
    var out = Math.max(Math.abs(v.x), Math.abs(v.y));
    if (v.z > 1) out = 2;                               // behind the camera
    this.ballNdc = out;
    var k = this.keep || 0;
    if (out > 0.78) k = Math.min(1, k + dt * (1.5 + (out - 0.78) * 4));
    else if (out < 0.55) k = Math.max(0, k - dt * 0.5);
    this.keep = k;
  },

  update: function (dt, targetX, targetZ, ballX, ballZ) {
    var U = LG.Util;
    var land = this.isLandscape();
    var C = this.blend(dt);

    if (land !== this._dbgMode) {
      this._dbgMode = land;
      if (LG.DBG) LG.DBG.log('[camera] ' + (land ? 'LANDSCAPE' : 'PORTRAIT') + ' preset ' + this.presetId());
    }

    // a ball far from the player pulls harder (passes, shots, the keeper),
    // and the close cameras widen a touch so it stays in frame
    var bdx = ballX - targetX, bdz = ballZ - targetZ;
    var bdist = Math.sqrt(bdx * bdx + bdz * bdz);
    var spread = U.clamp((bdist - 6) / 14, 0, 1);
    var ballW = U.lerp(C.ballW, Math.max(C.ballW, 0.55), spread);
    // BALL KEEPER: if the ball was drifting off screen last frame, pull the
    // framing toward it (and back off a little) until it is safely inside
    var keep = this.keep || 0;
    ballW = ballW + (1 - ballW) * keep * 0.7;
    var tx = U.lerp(targetX, ballX, ballW);
    var tz = U.lerp(targetZ, ballZ, ballW);

    var k = Math.min(1, dt * C.damp);
    this.followX = U.lerp(this.followX, tx, k);
    this.followZ = U.lerp(this.followZ, tz, k);

    if (land) {
      this.followX = U.clamp(this.followX, -C.xClamp, C.xClamp);
      this.followZ = U.clamp(this.followZ, -C.zClamp, C.zClamp);
      this.followX = U.clamp(this.followX, targetX - 20, targetX + 20);
      this.followZ = U.clamp(this.followZ, targetZ - 20, targetZ + 20);
    } else {
      // the ball keeper may follow a ball right to the end line / corner
      this.followX = U.clamp(this.followX, -C.xClamp - keep * 3, C.xClamp + keep * 3);
      this.followZ = U.clamp(this.followZ, -C.zClamp - keep * 4, C.zClamp + keep * 4);
      this.followX = U.clamp(this.followX, targetX - 13, targetX + 13);
      this.followZ = U.clamp(this.followZ, targetZ - 15, targetZ + 30);
    }

    // DYNAMIC: swing the camera a little toward where the play is heading
    var swingTarget = C.swing > 0.05 ? U.clamp((tz - this.followZ) * 2 + (ballZ - targetZ) * 0.15, -1, 1) * C.swing : 0;
    this.swingZ += (swingTarget - this.swingZ) * Math.min(1, dt * 1.6);

    var sx = 0, sy = 0;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      var a = this.shakeAmp * Math.max(0, this.shakeT);
      sx = (Math.random() - 0.5) * 2 * a;
      sy = (Math.random() - 0.5) * 2 * a;
      if (this.shakeT <= 0) this.shakeAmp = 0;
    }

    var cx, cy, cz, lx, ly = C.lookY, lz;
    if (land) {
      cx = this.followX + C.distance * (1 + keep * 0.5); cy = C.height * (1 + keep * 0.35); cz = this.followZ - this.swingZ;
      lx = this.followX; lz = this.followZ;
    } else {
      cx = this.followX + this.swingZ * 0.5; cy = C.height * (1 + keep * 0.35); cz = this.followZ + C.distance * (1 + keep * 0.5);
      lx = this.followX; lz = this.followZ - 2.5 * (1 - keep);
    }
    // stay out of solid geometry (only the closer presets can reach it)
    if (C.distance < 30) {
      var f = this.occlusion(lx, ly, lz, cx, cy, cz, dt);
      if (f < 0.999) { cx = lx + (cx - lx) * f; cy = Math.max(2.2, ly + (cy - ly) * f); cz = lz + (cz - lz) * f; }
    }
    // the close cameras never back out of the venue: past the end line /
    // touchline sit the nets, fences and stands, so they stop just inside
    // the boundary (the ball keeper widens the lens instead of retreating)
    var vc = this.venueClamp(cx, cz, land, C);
    cx = vc.x; cz = vc.z;
    this.camera.position.set(cx + sx, cy + sy * 0.6, cz + sx * 0.4);
    this.camera.lookAt(lx, ly, lz);
    this.watchBall(dt, ballX, ballZ);

    this.zoomPulse = Math.max(0, this.zoomPulse - dt * 0.5);
    var fov = C.fov - this.zoomPulse * 7 + (C.distance < 14 ? spread * 8 : 0) + keep * (C.distance < 20 ? 12 : 4);
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = U.lerp(this.camera.fov, fov, Math.min(1, dt * 10));
      this.camera.updateProjectionMatrix();
    }
  },
};
