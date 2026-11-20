// ============================================================
// BALL — real physics: roll, bounce, spin, walls, posts
// ============================================================
var LG = window.LG = window.LG || {};

LG.Ball = function () {
  var C = LG.Config.court;
  var P = LG.Config.physics;
  this.r = C.ballRadius;
  this.x = 0; this.y = C.ballRadius; this.z = 0;
  this.vx = 0; this.vy = 0; this.vz = 0;
  this.mesh = LG.Models.buildBall();
  this.mesh.position.set(0, C.ballRadius, 0);
  this.owner = null;          // player id currently controlling the ball
  this.lastHolderTeam = null; // who to credit kickoff after out
  this.noPk = null;           // player temporarily blocked from picking the ball up
  this.noPkT = 0;
  this.atRest = true;
  this.spin = 0;
  this.container = null;
  this.posts = [];            // {x,z} set by arena
};

LG.Ball.prototype = {
  reset: function (x, z) {
    this.x = x; this.z = z !== undefined ? z : 0;
    this.y = this.r;
    this.vx = this.vy = this.vz = 0;
    this.owner = null;
    this.noPk = null;
    this.noPkT = 0;
    this.atRest = true;
    // a fresh ball at kickoff must not inherit the previous play: a stale
    // lastKicker would pin the control mode to the wrong team, and a leftover
    // kickT would keep self-hit protection alive for seconds after the whistle
    this.lastKicker = null;
    this.kickT = 0;
    this.intendedReceiver = null;
    this.intendedT = 0;
    this._guided = null;
    this._kickSeq = (this._kickSeq || 0) + 1;   // invalidate old keeper save rolls
    this.curveT = 0;
    this._inGoal = 0;           // Build 8: which goal volume the ball is inside
    this._goalLatch = false;    // Build 8: a goal was already judged for this ball
    if (this.mesh) this.mesh.position.set(this.x, this.y, this.z);
  },

  speed: function () { return Math.sqrt(this.vx * this.vx + this.vz * this.vz); },
  speed3: function () { return Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz); },

  kick: function (vx, vy, vz) {
    this._kickSeq = (this._kickSeq || 0) + 1;
    var max = LG.Config.physics.maxBallSpeed;
    var m = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (m > max) { vx *= max / m; vy *= max / m; vz *= max / m; }
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.curveT = 0;
    this.owner = null;
    this.atRest = false;
    LG.Audio.sfx.kick(m / max);
  },

  // ------------------------------------------------------------
  // Build 8: the step is split into short collision sub-steps (at most
  // Config.goalFrame.subStep metres of travel each), so a 36 m/s strike
  // can no longer tunnel through a post, the crossbar or a net panel on
  // a slow frame. Drag/gravity are applied per sub-step with the same
  // per-second rates, so a ball travels exactly as far as before.
  step: function (dt, arena) {
    if (this.owner) return; // moving with the carrier — position set by player
    var F = LG.Config.goalFrame || {};
    var travel = Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz) * dt;
    var n = Math.max(1, Math.min(12, Math.ceil(travel / (F.subStep || 0.12))));
    var h = dt / n;
    for (var i = 0; i < n; i++) this.subStep(h);

    // at rest?
    var s = this.speed();
    this.atRest = s < 0.6 && this.y < this.r + 0.05;
    if (this.atRest && this.vy < 0.1) { this.vx = 0; this.vz = 0; this.vy = 0; }

    this.mesh.position.set(this.x, this.y, this.z);
    // rolling spin
    if (s > 0.1) {
      this.mesh.rotation.x += this.vz * dt / this.r;
      this.mesh.rotation.z -= this.vx * dt / this.r;
    }
  },

  subStep: function (dt) {
    var C = LG.Config.court;
    var P = LG.Config.physics;
    var px = this.x, py = this.y, pz = this.z;

    // gravity & height
    this.vy += P.gravity * dt;
    this.y += this.vy * dt;

    // Build 7: a finesse strike bends (lateral spin force) while in flight
    if (this.curveT > 0) {
      this.vx += (this.curveX || 0) * dt; this.vz += (this.curveZ || 0) * dt;
      this.curveT -= dt;
    }
    // horizontal integration
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // ground
    if (this.y <= this.r) {
      this.y = this.r;
      if (this.vy < 0) {
        var impact = -this.vy;
        // PHASE 4.2 — kill the bounce at the tail. Small impacts settle the
        // ball flat instead of letting it micro-hop its way down the court;
        // anything that would look/sound like a real bounce still gets one.
        if (impact < (P.bounceSettle || 1.2)) {
          this.vy = 0;
        } else {
          this.vy *= -P.bounce;
          if (impact > 4) {
            LG.Audio.sfx.ballBounce(Math.min(1, impact / 14));
            LG.Particles.dust(this.x, this.z, 2);
            if (this.vy < 0.4) this.vy = 0;
          }
        }
      }
      // rolling friction
      this.vx *= Math.pow(P.groundDrag, dt * 60);
      this.vz *= Math.pow(P.groundDrag, dt * 60);
    } else {
      // only a ball that is genuinely in the air loses the extra air drag —
      // applying both at once made every pass die halfway to its target
      this.vx *= Math.pow(P.airDrag, dt * 60);
      this.vz *= Math.pow(P.airDrag, dt * 60);
    }

    // ----- side fences (the long touchline cage) -----
    var halfW = C.width / 2 - this.r;
    if (this.x > halfW) { this.x = halfW; if (this.vx > 0) { this.vx *= -P.bounce * 0.8; this.hitWall(); } }
    if (this.x < -halfW) { this.x = -halfW; if (this.vx < 0) { this.vx *= -P.bounce * 0.8; this.hitWall(); } }

    // ----- the ends: end fence, goal frame, net pocket (LG.GoalFrame) -----
    LG.GoalFrame.collide(this, px, py, pz, dt);
  },

  hitWall: function () {
    // throttle wall sound
    var t = LG.Util.now();
    if (!this._lastWall || t - this._lastWall > 0.09) {
      this._lastWall = t;
      LG.Audio.sfx.wall();
    }
  },
};

// ============================================================
// GOAL FRAME (Build 8) — the goal as a physical object, and the ONE
// place that decides whether a goal was scored.
//
// Why: the old ends were a loose trigger zone. A ball was "in the mouth"
// whenever its CENTRE was inside the post line, the goal fired as soon as
// the centre touched the line (not the whole ball), a carried ball was
// never constrained at all (a player dribbling along the end line beside
// the post pushed the ball through the side netting and scored), a ball
// over the bar was caught by a "roof" clamp and dropped into the net (a
// goal), and the side-net code could never run (it needed |x| > gw inside
// a zone defined by |x| < gw) — so a ball rolling into the side netting
// from inside was teleported back out to the goal line.
//
// Now each end is built from separate parts:
//   WALL    the end fence: a plane at the goal line with a rectangular
//           hole (the mouth). Outside the hole the ball bounces off it.
//   FRAME   two post cylinders + the crossbar cylinder, lively bounce.
//   NET     side panels, roof and back panel of the pocket — soft, they
//           swallow the pace (absorb + friction), never reflect it out.
//   VOLUME  the box behind the line inside the frame. The ball only gets
//           in through the hole (ball._inGoal is set when the centre
//           crosses the plane INSIDE the hole), and judge() only awards a
//           goal when the WHOLE ball is past the line inside that volume.
// Contact with any net never scores on its own; nothing outside the mouth
// can ever reach the volume. Goals are latched per ball (no duplicates).
// ============================================================
LG.GoalFrame = (function () {
  var lastNet = 0;

  function dims(r) {
    var C = LG.Config.court, F = LG.Config.goalFrame || {};
    var gw = C.goalWidth / 2, inset = F.netInset != null ? F.netInset : 0.04;
    return {
      L2: C.length / 2, gw: gw, gh: C.goalHeight, gd: C.goalDepth,
      pr: F.postR || 0.07, br: F.barR || 0.06, r: r,
      inner: gw - inset - r,                 // side-net limit for the centre
      roof: C.goalHeight - inset - r,        // roof limit for the centre
      back: C.length / 2 + C.goalDepth - inset - r,   // back-net limit (|z|)
      postE: F.postBounce != null ? F.postBounce : 0.72,
      netE: F.netAbsorb != null ? F.netAbsorb : 0.18,
      netF: F.netFriction != null ? F.netFriction : 0.55,
      wallE: F.wallBounce != null ? F.wallBounce : 0.48,
    };
  }

  function netHit(ball, e, part, sp) {
    if (sp < 1.2) return;
    var t = LG.Util && LG.Util.now ? LG.Util.now() : 0;
    if (t - lastNet > 0.12) {
      lastNet = t;
      if (LG.Audio && LG.Audio.sfx && LG.Audio.sfx.net) LG.Audio.sfx.net(Math.min(1, sp / 20));
    }
    if (LG.eventBus && LG.eventBus.emit) LG.eventBus.emit('netHit', { end: e, part: part, speed: sp, x: ball.x, y: ball.y });
  }

  // vertical post: a circle in x/z, active while the ball overlaps its height
  function post(ball, D, px, pz) {
    if (ball.y - ball.r > D.gh + D.br) return;
    var dx = ball.x - px, dz = ball.z - pz, rr = D.pr + ball.r;
    var d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr || d2 < 1e-8) return;
    var d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
    ball.x = px + nx * rr; ball.z = pz + nz * rr;
    var vn = ball.vx * nx + ball.vz * nz;
    if (vn < 0) {
      ball.vx -= (1 + D.postE) * vn * nx;
      ball.vz -= (1 + D.postE) * vn * nz;
      woodwork(ball, px, 0.6, pz, -vn);
    }
  }

  // crossbar: a cylinder along x at (y = gh, z = line)
  function bar(ball, D, line) {
    if (Math.abs(ball.x) > D.gw + D.pr) return;
    var dy = ball.y - D.gh, dz = ball.z - line, rr = D.br + ball.r;
    var d2 = dy * dy + dz * dz;
    if (d2 >= rr * rr || d2 < 1e-8) return;
    var d = Math.sqrt(d2), ny = dy / d, nz = dz / d;
    ball.y = D.gh + ny * rr; ball.z = line + nz * rr;
    var vn = ball.vy * ny + ball.vz * nz;
    if (vn < 0) {
      ball.vy -= (1 + D.postE) * vn * ny;
      ball.vz -= (1 + D.postE) * vn * nz;
      woodwork(ball, ball.x, D.gh, line, -vn);
    }
  }

  function woodwork(ball, x, y, z, sp) {
    if (sp < 0.8) return;
    LG.Audio.sfx.post();
    LG.Particles.burst(x, y, z, 0xfff3c0, 8, 3, 3);
    // Phase 8: woodwork = a near-miss the reaction layer can play.
    // No RNG, no gameplay — just a signal on the shared bus.
    if (LG.eventBus && LG.eventBus.emit) LG.eventBus.emit('postHit', { x: x, z: z });
  }

  // the inside of the pocket: side nets, roof, back net (soft)
  function pocket(ball, D, e) {
    var zr = ball.z * e;
    if (zr > D.L2) {
      if (ball.x > D.inner) { var s1 = Math.abs(ball.vx); ball.x = D.inner; if (ball.vx > 0) { ball.vx = -ball.vx * D.netE; ball.vz *= D.netF; ball.vy *= 0.85; } netHit(ball, e, 'side', s1); }
      else if (ball.x < -D.inner) { var s2 = Math.abs(ball.vx); ball.x = -D.inner; if (ball.vx < 0) { ball.vx = -ball.vx * D.netE; ball.vz *= D.netF; ball.vy *= 0.85; } netHit(ball, e, 'side', s2); }
      if (ball.y > D.roof) { var s3 = Math.abs(ball.vy); ball.y = D.roof; if (ball.vy > 0) { ball.vy = -ball.vy * 0.1; ball.vx *= 0.8; ball.vz *= 0.8; } netHit(ball, e, 'roof', s3); }
    }
    if (zr > D.back) {
      var s4 = Math.abs(ball.vz);
      ball.z = e * D.back;
      if (ball.vz * e > 0) { ball.vz = -ball.vz * D.netE; ball.vx *= D.netF; ball.vy *= 0.6; }
      netHit(ball, e, 'back', s4);
    }
  }

  // resolve the ball against whichever end it is near. prev* = position
  // before this sub-step (used to tell which side of the plane it came from)
  function collide(ball, px, py, pz, dt) {
    var e = ball.z >= 0 ? 1 : -1;
    var D = dims(ball.r);
    var line = e * D.L2;
    var zr = ball.z * e;
    if (zr < D.L2 - ball.r - D.pr - 0.05 && !ball._inGoal) return;   // nowhere near

    if (ball._inGoal === e) {
      if (zr < D.L2 - ball.r) ball._inGoal = 0;      // rolled back out into play
    } else if (ball._inGoal) {
      ball._inGoal = 0;                              // (teleported elsewhere)
    }

    if (ball._inGoal !== e && zr > D.L2 - ball.r) {
      var inHole = Math.abs(ball.x) < D.gw && ball.y < D.gh;
      if (!inHole) {
        // the end fence / the panel above the crossbar
        ball.z = e * (D.L2 - ball.r);
        if (ball.vz * e > 0) { ball.vz = -ball.vz * D.wallE; ball.hitWall(); }
        zr = D.L2 - ball.r;
      } else if (zr > D.L2) {
        ball._inGoal = e;                            // in through the mouth
      }
    }

    // frame (both sides of it: a ball inside the mouth can still clip a post)
    post(ball, D, -D.gw, line);
    post(ball, D, D.gw, line);
    bar(ball, D, line);

    if (ball._inGoal === e) {
      pocket(ball, D, e);
      // the net bag drags on a ball inside it: a goal stays in the goal
      if (zr > D.L2 && dt > 0) {
        var k = Math.pow(0.18, dt);            // ~82% of its speed gone per second
        ball.vx *= k; ball.vz *= k;
      }
    }
  }

  // A carried ball is placed by its carrier, not integrated, so it must be
  // kept out of the frame and the nets explicitly: dribbling along the end
  // line beside the post can no longer push the ball into the side netting.
  // Returns true when the carried ball had to be moved.
  function constrainCarried(ball, carrier) {
    var D = dims(ball.r);
    var e = ball.z >= 0 ? 1 : -1, zr = ball.z * e;
    if (zr <= D.L2 - ball.r) { if (ball._inGoal && zr < D.L2 - ball.r) ball._inGoal = 0; return false; }
    var x0 = ball.x, z0 = ball.z;
    var inHole = Math.abs(ball.x) < D.gw - D.pr - ball.r * 0.5;
    if (!inHole && ball._inGoal !== e) {
      ball.z = e * (D.L2 - ball.r);
    } else {
      if (zr > D.L2) ball._inGoal = e;
      if (ball._inGoal === e) {
        if (ball.x > D.inner) ball.x = D.inner;
        if (ball.x < -D.inner) ball.x = -D.inner;
        if (ball.z * e > D.back) ball.z = e * D.back;
      }
    }
    return ball.x !== x0 || ball.z !== z0;
  }

  // Did this ball just become a goal? 'home' = the ball is in the SOUTH (+z)
  // net (home team's goal, so the away side scores), 'away' = the north net.
  // Only the whole ball past the line, inside the frame, having come in
  // through the mouth — and only once per ball until it is reset.
  function judge(ball) {
    if (!ball || ball._goalLatch || !ball._inGoal) return null;
    var D = dims(ball.r), e = ball._inGoal;
    var zr = ball.z * e;
    if (zr < D.L2 + ball.r - 1e-6) return null;              // not ALL of it over yet
    if (Math.abs(ball.x) > D.gw - D.pr) return null;          // (never true inside)
    if (ball.y - ball.r > D.gh) return null;
    return e > 0 ? 'home' : 'away';
  }

  return { collide: collide, constrainCarried: constrainCarried, judge: judge, dims: dims };
})();
