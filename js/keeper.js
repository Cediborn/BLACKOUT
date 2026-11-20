// ============================================================
// KEEPER — the dedicated goalkeeper brain (Build 8 overhaul).
//
// Root causes this rewrite fixes:
//   * no positioning model — the keeper mirrored ball.x * 0.55 with a
//     fixed small step off the line, so he never narrowed an angle and a
//     ball played across the box simply went round him;
//   * a "collect" rule that sent him up to 5 m off his line for ANY slow
//     loose ball inside ~7 m, whether or not an attacker would get there
//     first — then he walked back at 60% pace (the wandering keeper);
//   * no reaction model — he either saw a shot or he didn't, and he never
//     came off his line against a striker running through;
//   * possession was "stand still, snap the facing, kick after 0.9 s",
//     re-run every frame, with opponents allowed to lean on him.
//
// The brain now runs a small, explicit state machine:
//   SET       angle-narrowing position between ball and goal, depth by
//             distance, shuffles at set pace (never scampers)
//   RECOVER   out of position -> sprint back to the SET point
//   SHOT      a shot is on: wait out a reaction delay, then dive/step to
//             his READ of the crossing point (Match decides the save)
//   CLAIM     a loose ball / through pass he can reach FIRST inside his
//             box (time-to-ball race against every opponent)
//   RUSH      an attacker through on goal: come off the line on the
//             ball-goal line to narrow the angle, smother at his feet
//   DOWN      a smother that failed: he is on the floor for a beat
// and, with the ball, a possession machine:
//   SECURE -> DECIDE -> WINDUP -> (released)
// SECURE/DECIDE/WINDUP are PROTECTED (Match.keeperProtected): no tackle,
// opponents are steered and eased out of a bubble around him. A loose
// ball he merely touches is never protected.
// The actual save/parry roll lives in Match.updateKeepers, after ball
// physics and before the goal check.
// ============================================================
var LG = window.LG = window.LG || {};

LG.KeeperBrain = function (player) {
  this.p = player;
  this.state = 'set';
  this.thinkT = 0;
  this.actT = 0;
  this.lastHadBall = false;
  this.moveTarget = { x: 0, z: player.z };
  this.poss = null;          // { st, t, decideT, plan, evalT }
  this.downT = 0;            // on the floor after a failed smother
  this.smotherCd = 0;
  this.threatSeq = null;     // kick seq of the shot being reacted to
  this.threatT = 0;          // seconds since that shot was first seen
};

LG.KeeperBrain.prototype = {
  // signed world "own goal line" helpers (team0 defends +z, team1 defends -z)
  line: function () {
    var halfL = LG.Config.court.length / 2;
    return this.p.team === 0 ? halfL : -halfL;
  },
  sign: function () {
    return this.p.team === 0 ? 1 : -1;   // +1 = traveling +z toward my goal
  },
  // metres in front of my line (positive = on the field side)
  off: function (z) { return (this.line() - z) * this.sign(); },
  zAt: function (off) { return this.line() - this.sign() * off; },

  clampZoneX: function (x) {
    var K = LG.Config.keeper;
    return LG.Util.clamp(x, -(K.areaW || 6.2), K.areaW || 6.2);
  },
  clampZoneZ: function (z) {
    var K = LG.Config.keeper, o = this.off(z);
    return this.zAt(LG.Util.clamp(o, 0.25, K.rushMax || 6.5));
  },

  skill: function () { return LG.Difficulty.forKeeper(this.p.team); },

  // is he inside his own box (where he may handle the ball)?
  inArea: function () {
    var K = LG.Config.keeper, me = this.p;
    return this.off(me.z) < (K.areaD || 6.5) + 0.5 && Math.abs(me.x) < (K.areaW || 6.2) + 0.5;
  },

  // Move toward a point with a speed cap (fraction of top speed). The dead
  // zone + proportional approach stops the jitter of a body hunting a point.
  moveToward: function (tx, tz, reach) {
    var me = this.p;
    var U = LG.Util;
    var dx = tx - me.x, dz = tz - me.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    var cap = Math.min(1, (reach || me.maxSpeed) / me.maxSpeed);
    if (d < 0.06) { me.want.x = 0; me.want.z = 0; return d; }
    var s = Math.min(1, d / 0.45);
    me.want.x = U.clamp(dx / d, -1, 1) * cap * s;
    me.want.z = U.clamp(dz / d, -1, 1) * cap * s;
    return d;
  },

  faceToward: function (x, z, dt, rate) {
    var me = this.p;
    var a = Math.atan2(x - me.x, z - me.z);
    var da = Math.atan2(Math.sin(a - me.facing), Math.cos(a - me.facing));
    me.facing += da * Math.min(1, (dt || 0.016) * (rate || 8));
  },

  // A keeper reads a shot, they do not compute it. The read is stable for the
  // whole kick (derived from the kick sequence), so the dive is a commitment —
  // and it is scaled by how far the shot is from the keeper: a shot straight at
  // them is read perfectly, a shot to the corner is a guess.
  readError: function (ball, px) {
    var K = LG.Config.keeper;
    var seq = (ball._kickSeq || 0) + this.p.team * 7 + this.p.idx * 13;
    var h = Math.sin(seq * 12.9898) * 43758.5453;
    h = h - Math.floor(h);
    var raw = (h - 0.5) * 2;                                  // -1..1
    // sure about a ball at him, guessing about one at the corner
    var confidence = Math.min(1, Math.abs((px || 0) - this.p.x) / 1.6);
    var fuzz = 1 / (this.skill().goalkeeperReaction || 1);
    return raw * (K.readSpread || 1.5) * confidence * fuzz * 0.9;
  },

  // reaction delay for this keeper (seconds before the body commits)
  reactDelay: function () {
    var K = LG.Config.keeper;
    return (K.reactBase || 0.16) / (this.skill().goalkeeperReaction || 1);
  },

  // How fast this keeper can actually stretch: a keeper's dive, never an
  // outfield sprint, and slightly slower on an easier level.
  diveReach: function () {
    var react = this.skill().goalkeeperReaction || 1;
    return (LG.Config.keeper.diveSpeed || 4.2) * (0.75 + 0.25 * react);
  },

  // where the play will be in a moment (perception, not prophecy)
  readPlay: function () {
    var M = LG.Match, ball = M.ball;
    var car = M.ownerPlayer();
    if (car) return { x: car.x + car.vx * 0.3, z: car.z + car.vz * 0.3, carrier: car };
    var t = Math.min(0.45, 0.2 + ball.speed() * 0.01);
    return { x: ball.x + ball.vx * t, z: ball.z + ball.vz * t, carrier: null };
  },

  // ---------------- the SET position ----------------
  // Stand on the line from the ball to a point just behind the middle of the
  // goal, as far off the line as the distance of the play allows. Wide and
  // deep, he hugs the near post; with an attacker wide in the box he keeps a
  // step toward the middle for the cut-back.
  setPoint: function (play) {
    var K = LG.Config.keeper, U = LG.Util;
    var C = LG.Config.court, gw = C.goalWidth / 2;
    var sign = this.sign(), line = this.line();
    var gz = line + sign * 0.9;                         // anchor behind the line
    var dx = play.x, dz = play.z - gz;
    var dist = Math.sqrt(dx * dx + dz * dz) || 1;
    var front = this.off(play.z);                        // play's distance off my line
    var lineOff = K.lineOff || 0.55, maxOff = K.maxOff || 2.4;
    var off;
    if (front < 3) off = lineOff;
    else if (front < 11) off = U.lerp(lineOff, 1.7, (front - 3) / 8);
    else if (front < 22) off = 1.7;
    else off = U.lerp(1.7, maxOff, U.clamp((front - 22) / 12, 0, 1));
    // the point on the ball-goal line at that depth
    var t = (off + 0.9) / Math.max(0.5, (-dz * sign) / dist) / dist;
    var x = dx * Math.min(1, t);
    var limit = off < 1.2 ? gw - 0.35 : gw + 0.2;
    x = U.clamp(x, -limit, limit);
    // ball at or behind the line, wide: tuck in at the near post
    if (front < 1.2 && Math.abs(play.x) > gw) { x = (play.x > 0 ? 1 : -1) * (gw - 0.45); off = 0.4; }
    // a carrier wide in the box can square it: give the far post a step
    if (play.carrier && Math.abs(play.x) > gw + 1.5 && front < 9) x *= 0.75;
    return { x: x, z: this.zAt(off), off: off };
  },

  // ---------------- time-to-ball race ----------------
  // Earliest point on the loose ball's path that I reach before every
  // opponent, inside my box. Returns {x,z,t} or null.
  claimPoint: function () {
    var M = LG.Match, ball = M.ball, me = this.p, K = LG.Config.keeper;
    if (ball.owner || ball.y > 2.3) return null;
    var P = LG.Config.physics;
    var k = -60 * Math.log(P.groundDrag || 0.984);
    var sp = ball.speed();
    if (sp > 17) return null;                                 // a strike, not a pass
    // a ball driven AT the goal is a shot to be saved, not a pass to claim
    var vz = ball.vz * this.sign();
    if (sp > 9 && vz > 4) {
      var tl = Math.max(0, this.off(ball.z)) / vz;
      var cross = ball.x + ball.vx * tl;
      if (Math.abs(cross) < LG.Config.court.goalWidth / 2 + 1.0) return null;
    }
    var opps = M.opponents(me);
    var myV = me.maxSpeed * (K.recoverSpeed || 0.95) * 1.1;
    var margin = 0.22 / (this.skill().goalkeeperReaction || 1);
    for (var i = 0; i <= 14; i++) {
      var t = i * 0.09;
      var f = sp > 0.1 ? (1 - Math.exp(-k * t)) / k : 0;
      var x = ball.x + ball.vx * f, z = ball.z + ball.vz * f;
      var o = this.off(z);
      if (o < -0.2) break;                                   // past my line
      if (o > (K.areaD || 6.5) || Math.abs(x) > (K.areaW || 6.2)) continue;
      var mine = me.distTo(x, z) / myV;
      if (mine > t + 0.12) continue;
      var theirs = 1e9;
      for (var j = 0; j < opps.length; j++) {
        var q = opps[j];
        if (q.isGoalkeeper || q.stun > 0.2) continue;
        var tq = Math.max(0, q.distTo(x, z) - 0.6) / (q.maxSpeed * (q.sprintMul || 1.4));
        if (tq < theirs) theirs = tq;
      }
      if (mine + margin < theirs) return { x: x, z: z, t: t };
      return null;                                          // first reachable spot is contested
    }
    return null;
  },

  // ---------------- 1v1: is an attacker through on goal? ----------------
  throughOnGoal: function (car) {
    var M = LG.Match, me = this.p, K = LG.Config.keeper;
    if (!car || car.team === me.team) return false;
    var front = this.off(car.z);
    if (front < 0.6 || front > (K.rushDist || 9.5)) return false;
    if (Math.abs(car.x) > (K.areaW || 6.2) + 1) return false;
    // heading at goal (or standing in front of it)
    var toward = -car.vz * this.sign();
    if (toward < -1.0) return false;
    // no covering defender between him and the goal
    var mates = M.teamPlayers(me.team);
    for (var i = 0; i < mates.length; i++) {
      var d = mates[i];
      if (d === me || d.isGoalkeeper || d.stun > 0) continue;
      var df = this.off(d.z);
      if (df < front - 0.3 && df > -0.5 && Math.abs(d.x - car.x) < 2.6 + (front - df) * 0.25) return false;
    }
    return true;
  },

  update: function (dt) {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var K = LG.Config.keeper;
    var ball = M.ball;
    if (!ball) return;

    this.thinkT -= dt;
    this.actT -= dt;
    if (this.smotherCd > 0) this.smotherCd -= dt;
    if (me.stun > 0) { me.want.x = 0; me.want.z = 0; me.want.sprint = false; return; }

    // ---------------- WITH THE BALL ----------------
    if (me.hasBall) { this.possession(dt); return; }
    if (this.lastHadBall) { this.lastHadBall = false; this.poss = null; me._gkProtected = false; }
    me._gkProtected = false;

    // ---------------- on the floor after a failed smother ----------------
    if (this.downT > 0) {
      this.downT -= dt;
      this.state = 'down';
      me.want.x = 0; me.want.z = 0; me.want.sprint = false;
      return;
    }

    // ---------------- INCOMING SHOT ----------------
    var th = typeof M.keeperThreat === 'function' ? M.keeperThreat(me) : null;
    if (th) {
      var seq = ball._kickSeq || 0;
      if (this.threatSeq !== seq) { this.threatSeq = seq; this.threatT = 0; }
      this.threatT += dt;
      this.state = 'shot';
      me.want.sprint = false;
      var tx = this.clampZoneX(th.px + this.readError(ball, th.px));
      var tz = this.zAt(U.clamp(this.off(me.z), 0.25, Math.max(0.35, this.off(me.z))));
      if (this.threatT < this.reactDelay()) {
        // still reading it: set the feet, a half step toward the line of the ball
        this.moveToward(U.lerp(me.x, tx, 0.15), me.z, me.maxSpeed * 0.35);
      } else {
        this.moveToward(tx, tz, this.diveReach());
        // Build 6: commit the body — a dive or a jump the eye can read
        if (LG.KeeperMotion) LG.KeeperMotion.onThreat(me, tx, tz, ball);
      }
      this.faceToward(ball.x, ball.z, dt, 14);
      return;
    }
    this.threatSeq = null;

    var play = this.readPlay();
    var car = play.carrier;

    // ---------------- RUSH: close down a striker who is through ----------------
    if (car && this.throughOnGoal(car)) {
      this.state = 'rush';
      var cd = me.distTo(car.x, car.z);
      // on the ball-goal line, between him and the middle of the goal
      var gx = 0, gz = this.line();
      var vx = car.x - gx, vz = car.z - gz, vl = Math.sqrt(vx * vx + vz * vz) || 1;
      var stand = Math.max(0.7, Math.min(vl - 0.9, K.rushMax || 6.5));
      var rx = gx + vx / vl * stand, rz = gz + vz / vl * stand;
      rz = this.clampZoneZ(rz);
      this.moveTarget = { x: this.clampZoneX(rx), z: rz };
      this.moveToward(this.moveTarget.x, this.moveTarget.z, me.maxSpeed * (K.recoverSpeed || 0.95));
      me.want.sprint = cd > 3;
      this.faceToward(car.x, car.z, dt, 10);
      if (cd < (K.smotherR || 1.25) && this.smotherCd <= 0) this.smother(car);
      return;
    }

    // ---------------- CLAIM a ball he gets to first ----------------
    var cp = this.claimPoint();
    if (cp) {
      this.state = 'claim';
      this.moveTarget = { x: cp.x, z: cp.z };
      var dd = this.moveToward(cp.x, cp.z, me.maxSpeed * (K.recoverSpeed || 0.95));
      me.want.sprint = dd > 1.5;
      this.faceToward(ball.x, ball.z, dt, 10);
      return;
    }

    // ---------------- SET / RECOVER ----------------
    var sp = this.setPoint(play);
    this.moveTarget = { x: sp.x, z: sp.z };
    var err = me.distTo(sp.x, sp.z);
    if (err > 1.5) {
      this.state = 'recover';
      this.moveToward(sp.x, sp.z, me.maxSpeed * (K.recoverSpeed || 0.95));
      me.want.sprint = err > 3.5;
    } else {
      this.state = 'set';
      this.moveToward(sp.x, sp.z, me.maxSpeed * (K.setSpeed || 0.62));
      me.want.sprint = false;
    }
    this.faceToward(ball.x, ball.z, dt, 6);
  },

  // Go down at the attacker's feet. Success = the keeper has it (protected
  // after the secure beat); failure = he is on the floor for a moment and a
  // good dribbler can go round him. Uses one gameplay roll.
  smother: function (car) {
    var M = LG.Match, me = this.p, K = LG.Config.keeper, ball = M.ball;
    this.smotherCd = 1.4;
    if (!car.hasBall) return;
    var sk = this.skill();
    // a carrier facing him square-on is easier to block than one already past
    var fx = Math.sin(car.facing), fz = Math.cos(car.facing);
    var tx = me.x - car.x, tz = me.z - car.z, tl = Math.sqrt(tx * tx + tz * tz) || 1;
    var square = LG.Util.clamp((fx * tx + fz * tz) / tl, 0, 1);
    var chance = (K.smotherChance || 0.42) * (sk.goalkeeperSaveAbility || 1) *
      (0.65 + 0.35 * square) * (1.1 - (car.stats.dribble || 5) * 0.03);
    if (LG.Skills && LG.Skills.evades && LG.Skills.evades(car)) chance *= 0.25;
    var won = Math.random() < LG.Util.clamp(chance, 0.05, 0.75);
    if (LG.KeeperMotion) LG.KeeperMotion.onThreat(me, car.x, car.z, ball);
    if (won) {
      M.release(car);
      car.stun = Math.max(car.stun, 0.3);
      ball.vx = ball.vy = ball.vz = 0;
      M.possess(ball, me);
      M.statSide(me.team).saves++;
      if (M.bus) M.bus.emit('keeperSave', { gk: me, parry: false, smother: true });
    } else {
      this.downT = 0.55;
      me.vx *= 0.3; me.vz *= 0.3;
    }
  },

  // ============================================================
  // POSSESSION — SECURE -> DECIDE -> WINDUP -> released
  // ============================================================
  holding: function () {
    return !!(this.p.hasBall && this.poss && this.poss.st !== 'gone');
  },

  possession: function (dt) {
    var me = this.p, M = LG.Match, K = LG.Config.keeper, U = LG.Util;
    if (!this.lastHadBall || !this.poss || this.poss.st === 'gone') {
      this.lastHadBall = true;
      // a ball gathered in his own box is in his hands; one picked up
      // anywhere else (never by design) is just a loose-ball touch
      this.poss = { st: 'secure', t: 0, plan: null, evalT: 0, hands: this.inArea(),
        decideT: this.decideTime() };
      me.distributeT = (K.secureT || 0.35) + this.poss.decideT;
    }
    var ps = this.poss;
    ps.t += dt;
    me._gkProtected = !!ps.hands;
    me.want.sprint = false;
    // legacy: distributeT counts down to the release (read by older checks)
    me.distributeT = Math.max(0, me.distributeT - dt);

    if (ps.st === 'secure') {
      me.want.x = 0; me.want.z = 0;
      this.faceToward(me.x, this.zAt(this.off(me.z) + 6), dt, 5);
      if (ps.t >= (K.secureT || 0.35)) { ps.st = 'decide'; ps.t = 0; }
      return;
    }

    if (ps.st === 'decide') {
      ps.evalT -= dt;
      if (ps.evalT <= 0) { ps.plan = this.plan(); ps.evalT = 0.15; }
      var plan = ps.plan;
      // walk (never run) to a sensible release spot: a step off the line,
      // a little toward the side he means to play
      var spotX = U.clamp(me.x * 0.6 + (plan && plan.target ? U.clamp(plan.target.x * 0.15, -1.2, 1.2) : 0), -2.2, 2.2);
      var spotZ = this.zAt(U.clamp(this.off(me.z), 0.8, 1.6));
      if (me.distTo(spotX, spotZ) > 0.25) this.moveToward(spotX, spotZ, me.maxSpeed * 0.2);
      else { me.want.x = 0; me.want.z = 0; }
      var lookX = plan && plan.target ? plan.target.x : me.x;
      var lookZ = plan && plan.target ? plan.target.z : this.zAt(this.off(me.z) + 8);
      this.faceToward(lookX, lookZ, dt, 4);
      var total = (K.secureT || 0.35) + ps.t;
      var go = false;
      if (plan && plan.score > 1.15 && ps.t >= (K.decideMin || 0.45)) go = true;
      else if (ps.t >= ps.decideT && plan && plan.score > 0.55) go = true;
      else if (total >= (K.holdMax || 3.2) * 0.8) go = true;
      else if (plan && plan.kind === 'clear' && plan.urgent && ps.t >= (K.decideMin || 0.45) * 0.6) go = true;
      if (go && this.actT <= 0) {
        if (!plan || (plan.kind !== 'clear' && !this.planStillSafe(plan))) plan = this.plan(true);
        ps.plan = plan;
        ps.st = 'windup'; ps.t = 0;
        me.distributeT = K.windupT || 0.28;
        if (LG.KeeperMotion && plan && (plan.kind === 'roll' || plan.kind === 'throw') && LG.KeeperMotion.windup) LG.KeeperMotion.windup(me, plan.kind);
      }
      return;
    }

    if (ps.st === 'windup') {
      me.want.x = 0; me.want.z = 0;
      var tg = ps.plan && ps.plan.target;
      if (tg) this.faceToward(tg.x, tg.z, dt, 7);
      if (ps.t >= (K.windupT || 0.28)) this.execute(ps.plan);
      return;
    }
  },

  // look-up time: longer when nobody is near him, shorter under pressure;
  // a sharper keeper reads it quicker
  decideTime: function () {
    var K = LG.Config.keeper, U = LG.Util;
    var press = this.pressureOn();
    var t = U.lerp(K.decideMax || 1.1, K.decideMin || 0.45, press);
    var react = this.skill().goalkeeperReaction || 1;
    var mul = 1 / Math.sqrt(react);
    // tiny human-like variation, without touching the gameplay RNG stream
    var h = Math.sin(((LG.Match.ball && LG.Match.ball._kickSeq) || 1) * 7.13 + this.p.team) * 0.5 + 0.5;
    return t * mul * (0.9 + h * 0.2);
  },

  // 0..1: how hard the nearest opponents are pressing him
  pressureOn: function () {
    var M = LG.Match, me = this.p;
    var opps = M.opponents(me), best = 1e9;
    for (var i = 0; i < opps.length; i++) {
      if (opps[i].isGoalkeeper) continue;
      var d = opps[i].distTo(me.x, me.z);
      if (d < best) best = d;
    }
    return LG.Util.clamp((9 - best) / 5.5, 0, 1);
  },

  // Score every outlet: rolled/thrown short to a free defender, a driven ball
  // to a runner in space, or a clearance. Lanes and the receiver's space are
  // checked against every opponent — no blind kicks.
  plan: function (final) {
    var me = this.p, M = LG.Match, K = LG.Config.keeper, U = LG.Util;
    var goal = M.enemyGoal(me.team);
    var mates = M.teamPlayers(me.team);
    var press = this.pressureOn();
    var best = null;
    for (var i = 0; i < mates.length; i++) {
      var m = mates[i];
      if (m === me || m.isGoalkeeper) continue;
      var d = m.distTo(me.x, me.z);
      if (d < 2.5) continue;
      var forward = (m.z - me.z) * (goal.z > 0 ? 1 : -1);
      if (forward < 0.5) continue;                         // never back toward goal
      var kind = d <= (K.rollMax || 9) ? 'roll' : d <= (K.throwMax || 16) ? 'throw' : 'kick';
      var lane = this.laneClearance(m, kind);
      var space = this.crowdOf(m);
      if (space < 2.0) continue;                           // smothered: no
      if (kind !== 'kick' && lane < (K.passLaneClear || 1.55)) continue;
      if (kind === 'kick' && lane < 1.0) continue;
      var open = U.clamp((space - 2.0) / 3.5, 0, 1);
      var safeLane = U.clamp((lane - 1.2) / 3, 0, 1);
      var score = 0.45 + open * 0.75 + safeLane * 0.3 + U.clamp(forward * 0.02, 0, 0.45) - d * 0.012;
      if (kind === 'kick') score -= 0.15 - press * 0.25;    // under pressure, go long
      if (kind === 'roll' && press > 0.6) score -= 0.4;     // don't roll it into a press
      if (m.idx === 0 && kind !== 'kick') score += 0.1;     // build from the back
      if (!best || score > best.score) best = { kind: kind, target: m, score: score };
    }
    if (best) return best;
    return { kind: 'clear', target: null, score: 0.6, urgent: press > 0.5 || this.surrounded() };
  },

  planStillSafe: function (plan) {
    if (!plan || !plan.target) return false;
    var K = LG.Config.keeper;
    if (this.crowdOf(plan.target) < 1.8) return false;
    var lane = this.laneClearance(plan.target, plan.kind);
    return plan.kind === 'kick' ? lane >= 0.9 : lane >= (K.passLaneClear || 1.55) * 0.9;
  },

  // closest any opponent gets to the pass lane (and its end). A kicked
  // ball is in the air for most of the lane, so only its landing matters.
  laneClearance: function (target, kind) {
    var me = this.p, M = LG.Match;
    var ax = me.x, az = me.z, bx = target.x + target.vx * 0.5, bz = target.z + target.vz * 0.5;
    var len2 = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
    if (len2 < 0.04) return 0;
    var opps = M.opponents(me), min = 1e9;
    for (var i = 0; i < opps.length; i++) {
      var o = opps[i];
      if (o.isGoalkeeper) continue;
      var t = ((o.x - ax) * (bx - ax) + (o.z - az) * (bz - az)) / len2;
      t = LG.Util.clamp(t, kind === 'kick' ? 0.7 : 0, 1);
      var cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
      var d = o.distTo(cx, cz);
      if (d < min) min = d;
    }
    return min;
  },

  execute: function (plan) {
    var me = this.p, M = LG.Match;
    if (this.poss) this.poss.st = 'gone';
    me._gkProtected = false;
    me.distributeT = 0;
    this.actT = 0.6;
    var ball = M.ball;
    if (!plan || plan.kind === 'clear' || !plan.target) {
      this.clear();
      M.bus.emit('keeperDistribute', { gk: me, target: null, kind: 'clear' });
      return;
    }
    ball.y = ball.r;
    if (plan.kind === 'roll') M.passTo(me, plan.target, { lead: true, vy: 0.12 });
    else M.passTo(me, plan.target, { lead: true });
    M.bus.emit('keeperDistribute', { gk: me, target: plan.target, kind: plan.kind });
  },

  // ---------------- DISTRIBUTION (immediate) ----------------
  // Kept for direct callers (tests, modes): decide and release right now,
  // using the same evaluation as the possession machine.
  distribute: function () {
    var plan = this.plan(true);
    this.execute(plan);
  },

  // Opponents crowding the keeper: with this many inside surroundR the keeper
  // has no safe pass and must hoof it clear.
  surrounded: function () {
    var M = LG.Match;
    var me = this.p;
    var K = LG.Config.keeper;
    var opps = M.teamPlayers(1 - me.team);
    var n = 0, i;
    for (i = 0; i < opps.length; i++) {
      if (opps[i].isGoalkeeper) continue;
      if (opps[i].distTo(me.x, me.z) < (K.surroundR || 2.6) + 1.5) n++;
    }
    return n >= (K.surroundN || 2);
  },

  // Would this kick travel toward MY own goal? Used as a hard veto.
  towardOwnGoal: function (tx, tz) {
    var me = this.p;
    var dz = tz - me.z;
    return dz * this.sign() > -0.35;   // level with or behind us = own-goal risk
  },

  // Kept for older callers: a binary lane/landing check.
  passIsSafe: function (target) {
    if (this.towardOwnGoal(target.x, target.z)) return false;
    var K = LG.Config.keeper;
    return this.crowdOf(target) >= 2.0 && this.laneClearance(target, 'throw') >= (K.passLaneClear || 1.55);
  },

  // Nearest OUTFIELD opponent to a candidate — crowded mates are bad outlets.
  crowdOf: function (cand) {
    var M = LG.Match;
    var opps = M.teamPlayers(1 - this.p.team);
    var min = 1e9, i;
    for (i = 0; i < opps.length; i++) {
      var o = opps[i];
      if (o.isGoalkeeper) continue;
      var d = o.distTo(cand.x, cand.z);
      if (d < min) min = d;
    }
    return min;
  },

  pickTarget: function () {
    var p = this.plan(true);
    return p && p.target ? p.target : null;
  },

  // Safety valve: no reliable teammate -> clear it upfield into OPEN space,
  // toward the touchline when pressed. The landing spot is chosen from
  // sampled candidates by how far it stays from every opponent. ALWAYS away
  // from our own goal.
  clear: function () {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var Pt = LG.Pitch;
    var sign = this.sign();
    var dir = -sign;
    var opps = M.teamPlayers(1 - me.team).filter(function (o) { return !o.isGoalkeeper; });
    var hw = Pt.hw(2), hl = Pt.hl(2);
    var best = null, bestScore = -1;
    for (var i = 0; i < 14; i++) {
      var ax = U.clamp((U.rand() - 0.5) * hw * 1.6, -hw, hw);
      var az = U.clamp(me.z + dir * (12 + U.rand() * 8) * Pt.sl(), -hl, hl);
      var dist = (az - me.z) * dir;
      var min = 1e9;
      for (var k = 0; k < opps.length; k++) {
        var o = opps[k];
        var ddx = o.x - ax, ddz = o.z - az;
        var d2 = ddx * ddx + ddz * ddz;
        if (d2 < min) min = d2;
      }
      var score = min * 1.4 + dist * 0.12 + Math.abs(ax) * 0.15 + U.rand() * 0.5;
      if (score > bestScore) { bestScore = score; best = { x: ax, z: az }; }
    }
    if (!best) best = { x: U.clamp(me.x * 0.4, -8, 8), z: U.clamp(me.z + dir * 14, -hl, hl) };
    var dx = best.x - me.x, dz = best.z - me.z;
    var dd = Math.sqrt(dx * dx + dz * dz) || 1;
    if (dz * sign > -0.5) {
      dz = dir * Math.max(6, Math.abs(dz));
      dd = Math.sqrt(dx * dx + dz * dz) || 1;
    }
    var P = LG.Config.physics;
    if (this.poss) this.poss.st = 'gone';
    me._gkProtected = false;
    M.release(me);
    M.ball.y = M.ball.r;
    M.ball.kick((dx / dd) * P.passPower * 1.5, 2.4, (dz / dd) * P.passPower * 1.5);
    me.kickAnim = 1;
    M.ball.lastKicker = me;
    M.ball.kickT = 0.3;
    LG.Particles.dust(me.x, me.z, 2);
  },
};

