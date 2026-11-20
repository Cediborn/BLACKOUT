// ============================================================
// AI — teammates & opponents
// ============================================================
var LG = window.LG = window.LG || {};

LG.AIBrain = function (player) {
  this.p = player;
  this.thinkT = 0;
  this.moveTarget = { x: player.x, z: player.z };
  this.actionCd = 0;
  this.desire = Math.random() * 0.3;     // personality: how eager to shoot
  this.dribbleT = Math.random() * 0.8;
  this.reactT = 0;                       // how long until they read the turnover
  this._lastPoss = null;
  this._holdSprint = false;              // pacing: release the tank before it empties
};

LG.AIBrain.prototype = {
  // The profile for the side this brain plays on. Deliberately NOT cached:
  // forTeam() is a table lookup, and never caching means changing the level
  // always changes gameplay immediately (there is no stale profile to miss).
  difficulty: function () {
    return LG.Difficulty.forTeam(this.p.team);
  },

  // which direction is "toward the enemy goal" for my team?
  attDir: function () {
    return this.p.team === 0 ? -1 : 1;
  },

  // How much an AI pass wobbles: how hard the passer is being pressed and how
  // good a passer they are, divided by this difficulty's passing accuracy.
  passError: function (pressure) {
    var D = this.difficulty();
    return pressure * (1 - this.p.stats.pass / 12) * 0.35 / (D.passAccuracy || 1);
  },

  // A deliberately mediocre target — used by mistakeRate so a bad pass is a bad
  // DECISION (a mate who is marked or behind the play), never random nonsense.
  randomMate: function () {
    var mates = LG.Match.teamPlayers(this.p.team);
    var pool = [];
    for (var i = 0; i < mates.length; i++) {
      var m = mates[i];
      if (m !== this.p && !m.isGoalkeeper) pool.push(m);
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  },

  update: function (dt) {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var ball = M.ball;
    var D = this.difficulty();

    this.actionCd = Math.max(0, this.actionCd - dt);
    if (me.stun > 0) { me.want.x = 0; me.want.z = 0; return; }

    // reading the game: a low-anticipation side is a beat late to a change of
    // possession, so loose balls and second balls fall to the alert side.
    // (This is the whole interception knob — no ball magnetism anywhere.)
    if (this._lastPoss !== M.possessionTeam) {
      this._lastPoss = M.possessionTeam;
      var slow = 1 - (D.interceptionAbility || 1);
      this.reactT = slow > 0 ? slow * 0.6 : 0;
    }
    if (this.reactT > 0) this.reactT = Math.max(0, this.reactT - dt);

    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = LG.Config.ai.thinkInterval * (D.reactionTime || 1) * (0.7 + Math.random() * 0.6);
      this.think();
    }

    // run onto a pass that is actually aimed at me — the ball's own motion sets
    // the lead, so two chasers never fight over the same intercept point
    if (ball && ball.intendedReceiver === me && ball.intendedT > 0 && !me.hasBall) {
      var lead = Math.min(0.4, 3 / Math.max(2, ball.speed()));
      this.moveTarget.x = LG.Pitch.cx(ball.x + ball.vx * lead, 0.4);
      this.moveTarget.z = LG.Pitch.cz(ball.z + ball.vz * lead, 0.4);
      if (ball.lastKicker && ball.lastKicker.team !== me.team) {
        // a loose opponent pass cut off — close it down hard
        this.moveTarget.x = ball.x;
        this.moveTarget.z = ball.z;
      }
    } else {
      // keep spacing: don't stack onto a mate or swarm a free ball
      this.separate(this.moveTarget, me.hasBall);
    }

    // move toward target
    var dx = this.moveTarget.x - me.x;
    var dz = this.moveTarget.z - me.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d > 0.35) {
      var sp = Math.min(1, d / 1.2);
      me.want.x = (dx / d) * sp;
      me.want.z = (dz / d) * sp;
    } else if (me.hasBall && M.possessionTeam === me.team) {
      // hold near ball with slight shuffle (avoid being static)
      me.want.x = Math.sin(U.rand() * 6.28) * 0.15;
      me.want.z = Math.cos(U.rand() * 6.28) * 0.15;
    } else {
      me.want.x = 0; me.want.z = 0;
    }

    // sprint when chasing or attacking goal — a side that has not read the
    // turnover yet jogs back instead of flying into the challenge
    var sprint = false;
    if (this.reactT <= 0 && M.possessionTeam !== me.team && this.isClosestChaser()) {
      var cCarrier = M.ownerPlayer();
      var cDist = cCarrier ? me.distTo(cCarrier.x, cCarrier.z) : me.distTo(ball.x, ball.z);
      sprint = cDist > (LG.Config.ai.containRange || 3.2); // sprint to close down, jog to contain
    }
    if (me.hasBall && me.team === M.possessionTeam) sprint = (M.distToGoal(me) > 8 && Math.random() < 0.4 * (D.attackingAggression || 1));
    // receivers sprint onto their own pass; defenders sprint to a cut ball
    if (ball && ball.intendedReceiver === me && ball.intendedT > 0 && !me.hasBall) {
      var tSp = ball.speed();
      sprint = sprint || (tSp > 12 && Math.random() < 0.7);
    }
    // PHASE 5.4 — AI stamina pacing: releasing SPRINT below 0.15 and only
    // picking it back up above 0.55 means the tank recovers at the FULL rate
    // (holding it forever, as the AI used to, halves recovery and leaves the
    // side jogging through the middle of the match). Hysteresis, so it never
    // flickers on the threshold; same stamina rules as the human, no cheats.
    if (me.stamina <= 0.15) this._holdSprint = true;
    else if (me.stamina >= 0.55) this._holdSprint = false;
    me.want.sprint = sprint && !this._holdSprint;
  },

  // Pull `target` away from teammates (and a free ball) so the side keeps
  // spacing instead of collapsing. Only a shape target — never snaps the ball
  // chase: the designated chaser is exempt from the ball repulsion.
  // PHASE 4.3 — wider bubbles, same gentle push: five players used to drift
  // into one scrum around the carrier. (Wider radii tune cleanly; hardening
  // the push strength on top of it overshot and killed the shot count.)
  separate: function (target, haveBall) {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var ax = target.x, az = target.z;
    var mates = M.teamPlayers(me.team);
    var i, m, dx, dz, d, f;
    var mateR = (LG.Config.ai.spacingRadius || 2.2);
    for (i = 0; i < mates.length; i++) {
      m = mates[i];
      if (m === me) continue;
      dx = ax - m.x; dz = az - m.z;
      d = Math.sqrt(dx * dx + dz * dz);
      if (d < mateR && d > 0.001) {
        f = ((mateR - d) / mateR) * 1.7;
        ax += (dx / d) * f;
        az += (dz / d) * f;
      }
    }
    if (!haveBall && !this.isClosestChaser()) {
      var b = M.ball;
      var ballR = (LG.Config.ai.spacingBall || 2.6);
      dx = ax - b.x; dz = az - b.z;
      d = Math.sqrt(dx * dx + dz * dz);
      if (d < ballR && d > 0.001) {
        f = ((ballR - d) / ballR) * 2.2;
        ax += (dx / d) * f;
        az += (dz / d) * f;
      }
    }
    this.moveTarget.x = LG.Pitch.cx(ax, 0.4);
    this.moveTarget.z = LG.Pitch.cz(az, 0.4);
  },

  // The designated chaser is decided per TEAM by the match, on a cadence set
  // by the difficulty's playerSwitchSpeed: a passive side is slow to hand the
  // chase to the teammate who is actually closest, a sharp side switches at
  // once. Sharing one answer per team also stops two defenders both deciding
  // they are "the" chaser and piling into the same carry.
  isClosestChaser: function () {
    return LG.Match.chaserOf(this.p.team) === this.p;
  },

  // Commit to a challenge. A mistake-prone side mistimes it — an early lunge
  // that costs them the recovery time — and the challenge itself is scaled by
  // the difficulty's tackle accuracy.
  attemptTackle: function (distToCarrier) {
    var D = this.difficulty();
    this.actionCd = Math.max(0.4, 0.9 - distToCarrier * 0.08) * (D.decisionDelay || 1);
    if (Math.random() < (D.mistakeRate || 0) * 1.4) {
      this.actionCd *= 2.2;                     // lunged too early, out of the play
      return;
    }
    LG.Match.tryTackle(this.p, { accuracy: D.tackleAccuracy || 1 });
  },

  // is any opponent standing on the shot line?
  aimClear: function (goal) {
    var M = LG.Match;
    var me = this.p;
    var opps = M.opponents(me);
    var ax = me.x, az = me.z, bx = goal.x, bz = goal.z;
    var len2 = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
    if (len2 < 4) return true;
    for (var i = 0; i < opps.length; i++) {
      var o = opps[i];
      if (o.isGoalkeeper) continue;   // the keeper is the target, not a blocker
      var t = ((o.x - ax) * (bx - ax) + (o.z - az) * (bz - az)) / len2;
      t = LG.Util.clamp(t, 0, 1);
      var cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
      var d = o.distTo(cx, cz);
      if (d < 1.5) return false;
    }
    return true;
  },

  think: function () {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var ball = M.ball;
    if (!ball) return;

    var possession = M.possessionTeam; // -1 loose
    if (me.hasBall && possession === me.team) { this.offenseCarry(); return; }
    if (possession === me.team) { this.offenseSupport(); return; }
    if (possession === 1 - me.team) { this.defense(); return; }
    this.looseBall();
  },

  // ---------- HAVE THE BALL ----------
  // Build 8: the carrier reads the chance before he picks an action. Every
  // think he rates his own SHOT (angle, distance, the gap the keeper leaves,
  // bodies on the line) and every PASS (space, lane, and how good a chance
  // the receiver would have), then shoots, passes or carries the ball to a
  // better spot. Difficulty still owns appetite (attackingAggression),
  // accuracy (shotAccuracy / passAccuracy), timing (decisionDelay) and bad
  // calls (mistakeRate) — nothing here makes a shot faster or truer.
  offenseCarry: function () {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var goal = M.enemyGoal(me.team);
    var D = this.difficulty();
    var agg = D.attackingAggression || 1;

    this.dribbleT = Math.max(0, this.dribbleT - 0.05);
    var dGoal = M.distToGoal(me);
    var inRange = dGoal < M.shootRange(me);
    var shot = inRange ? this.shotQuality(me.x, me.z) : null;
    var pressure = this.pressure(3.0);
    // shot appetite: a keen side pulls the trigger on a half-chance
    var thresh = U.clamp(0.5 / Math.pow(agg, 0.8) - this.desire * 0.25, 0.28, 0.95);

    // a side that has not read the turnover yet does not snatch at a shot
    if (this.reactT > 0) shot = null;
    if (this.actionCd <= 0) {
      // 1) a CLEAR chance — take it
      if (shot && shot.q > thresh + 0.18 && Math.random() < 0.85) { this.takeShot(shot); return; }

      // 2) PASS — to a better chance, out of pressure, or to keep it moving
      var pass = this.bestPassTarget();
      if (pass) {
        var myQ = shot ? shot.q : 0;
        var better = pass.chance > myQ + 0.18 && pass.score > 0.45;   // square it to a better finish
        var strong = pass.score > 0.85 && myQ < thresh;               // clear, forward, open target
        var underHeat = pressure > 0.65 && pass.score > 0.4;          // pressed + any decent outlet
        var fedUp = this.dribbleT <= 0.05 && pass.score > 0.5 && myQ < thresh;
        var notTooDeep = dGoal > 10 || better;
        if ((better || strong || underHeat || fedUp) && (notTooDeep || pass.score > 0.95)) {
          // mistakeRate turns an acceptable decision into a poor one: the
          // ball still goes to a teammate, just the wrong one
          var target = pass.player;
          if (Math.random() < (D.mistakeRate || 0)) {
            var sloppy = this.randomMate();
            if (sloppy) target = sloppy;
          }
          M.passTo(me, target, { lead: true, error: this.passError(pressure) });
          this.actionCd = 0.7 * (D.decisionDelay || 1);
          this.dribbleT = 0.15;
          return;
        }
      }

      // 3) a GOOD-ENOUGH chance — shoot (sometimes the AI hesitates)
      if (shot && shot.q > thresh && Math.random() < (0.55 + this.desire) * agg) { this.takeShot(shot); return; }
      // a blocked lane while being closed down: recycle instead of forcing it
      if (shot && shot.blocked && pressure > 0.5) {
        var rec = this.bestPassTarget();
        if (rec && rec.score > 0.45) {
          M.passTo(me, rec.player, { lead: true, error: this.passError(0.35) });
          this.actionCd = 0.7 * (D.decisionDelay || 1);
          this.dribbleT = 0.15;
          return;
        }
      }
      // deep in the box with a poor angle and no pass: a mistake-prone side
      // still has a go (that is how chances are wasted)
      if (shot && dGoal < 7 && shot.q > 0.15 && Math.random() < (D.mistakeRate || 0) * 2) { this.takeShot(shot); return; }
    }

    // 4) CARRY it toward a better shooting spot, dodging the nearest opponent.
    // From wide areas he cuts inside; centrally he attacks the box.
    var sl = LG.Pitch.sl();
    var dir = this.attDir();
    var lineZ = goal.z - dir * 0.6;                  // the goal line itself
    var spotZ = lineZ - dir * U.clamp(dGoal * 0.45, 6.5, 11);
    var spotX = U.clamp(me.x * 0.35, -4, 4);
    var gx = spotX, gz = spotZ;
    // keep moving forward: the spot is at least a few metres ahead of him
    if ((gz - me.z) * dir < 2.5) gz = me.z + dir * 2.5;
    var opp = M.nearestOpponent(me, 4.5);
    if (opp) {
      var oppD = opp.distTo(me.x, me.z);
      if (oppD < 3.4) {
        var ox = me.x - opp.x, oz = me.z - opp.z;
        var od = Math.sqrt(ox * ox + oz * oz) || 1;
        gx += (ox / od) * 4.8;
        gz += (oz / od) * 4.8;
        // pressure + no outlet -> burn the dribble timer so the next
        // evaluation strongly prefers a pass
        if (this.actionCd <= 0) this.dribbleT = Math.min(this.dribbleT, 0.02);
      }
    }
    gx += (Math.random() - 0.5) * 1.4;
    gz += (Math.random() - 0.5) * 1.4;
    this.moveTarget = { x: LG.Pitch.cx(gx, 1), z: LG.Pitch.cz(gz, 1.2 * sl) };
  },

  takeShot: function (shot) {
    var me = this.p, M = LG.Match, U = LG.Util, D = this.difficulty();
    var power = U.lerp(0.7, 1, me.stats.shoot / 10);
    M.shootDirect(me, power, M.enemyGoal(me.team), { accuracy: D.shotAccuracy || 1, target: shot.target });
    M.aiShootPulse();
    this.actionCd = 1.2 * (D.decisionDelay || 1);
    this.dribbleT = 0;
  },

  // How good a shot is from (x, z) for my team, 0..1, and where to put it.
  // Angle of the mouth, distance, the gap the keeper leaves to each spot
  // (his reach, from where he actually stands) and any outfield body on the
  // line. A wide, low-angle or blocked shot scores low; a shot across a
  // keeper who is out of position scores high.
  shotQuality: function (x, z) {
    var me = this.p, M = LG.Match, U = LG.Util, C = LG.Config.court;
    var goal = M.enemyGoal(me.team);
    var lineZ = goal.z > 0 ? C.length / 2 : -C.length / 2;
    var gw = C.goalWidth / 2;
    var dx = -x, dz = lineZ - z;
    var dist = Math.sqrt(dx * dx + dz * dz) || 0.1;
    var range = M.shootRange(me);
    if (dist > range + 1) return { q: 0, target: null, blocked: false };
    // angle the mouth subtends from here
    var a1 = Math.atan2(-gw - x, Math.abs(dz)), a2 = Math.atan2(gw - x, Math.abs(dz));
    var ang = Math.abs(a2 - a1);
    var angleK = U.clamp(ang / 0.55, 0, 1);
    var distK = U.clamp(1 - (dist - 5) / Math.max(4, range - 3), 0.05, 1);
    var opps = M.opponents(me), gk = null, i;
    for (i = 0; i < opps.length; i++) if (opps[i].isGoalkeeper) gk = opps[i];
    var K = LG.Config.keeper;
    var reach = (K.reach || 0.95) + (K.diveReach || 1.55) * 0.55;
    var spots = [-(gw - 0.5), -gw * 0.45, 0, gw * 0.45, gw - 0.5];
    var best = null, anyBlocked = false;
    for (i = 0; i < spots.length; i++) {
      var tx = spots[i];
      var sx = tx - x, sz = lineZ - z, sl2 = sx * sx + sz * sz;
      var blocked = 0;
      for (var j = 0; j < opps.length; j++) {
        var o = opps[j];
        if (o.isGoalkeeper) continue;
        var t = ((o.x - x) * sx + (o.z - z) * sz) / sl2;
        if (t < 0.05 || t > 1) continue;
        var cx = x + sx * t, cz = z + sz * t;
        var od = o.distTo(cx, cz);
        if (od < 1.1) blocked = Math.max(blocked, 1 - od / 1.1 + 0.3);
      }
      var gap = 1;
      if (gk) {
        // how far the keeper is from the ball's path where it passes him
        var tg = U.clamp(((gk.x - x) * sx + (gk.z - z) * sz) / sl2, 0, 1);
        var px = x + sx * tg, pz = z + sz * tg;
        var kd = gk.distTo(px, pz);
        // the closer the keeper is to the shooter, the less time he has to
        // stretch — a far shot gives him the whole dive
        var timeK = U.clamp(Math.sqrt(sl2) * tg / 10, 0.35, 1.2);
        gap = U.clamp((kd - reach * timeK * 0.7) / 1.3, 0, 1);
      }
      var sc = gap * 0.75 - Math.min(1, blocked) * 0.9 + (tx === 0 ? -0.05 : 0);
      if (blocked > 0.6) anyBlocked = true;
      if (!best || sc > best.sc) best = { sc: sc, x: tx };
    }
    var q = angleK * 0.3 + distK * 0.35 + U.clamp(best.sc, -0.6, 0.75) * 0.6;
    return { q: U.clamp(q, 0, 1), target: { x: best.x, z: lineZ }, blocked: anyBlocked && best.sc < 0.2 };
  },

  // 0..1 how much the ball-carrier is being closed down
  pressure: function (radius) {
    var M = LG.Match;
    var opps = M.opponents(this.p);
    var min = 1e9;
    for (var i = 0; i < opps.length; i++) {
      var d = opps[i].distTo(this.p.x, this.p.z);
      if (d < min) min = d;
    }
    if (min > radius) return 0;
    return Math.min(1, (radius - min) / radius);
  },

  bestPassTarget: function () {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var goal = M.enemyGoal(me.team);
    var dir = this.attDir();
    var mates = M.teamPlayers(me.team);
    var best = null;
    for (var i = 0; i < mates.length; i++) {
      var t = mates[i];
      if (t === me || t.isGoalkeeper) continue;
      var d = t.distTo(me.x, me.z);
      if (d < 1.6) continue;                       // too close = no value to a pass
      if (!M.lineClear(me, t)) continue;           // defender on the lane
      var forward = (t.z - me.z) * dir;            // how far upfield the target is
      var open = M.openness(t, 1 - me.team, 2.6);
      var toGoal = M.distToGoal(t);
      var atMouth = toGoal < 3 ? 0.4 : 0;          // a mate parked on the goal line is a bad idea
      // open + forward is king; long passes are riskier than short ones
      var score = open * (0.6 + forward * 0.045) - d * 0.028 - atMouth;
      // Build 8: the chance the receiver would have — a square ball or a
      // cut-back to an open mate in front of goal beats a hopeful shot
      var chance = 0;
      if (toGoal < M.shootRange(t) && open > 0.4) {
        chance = this.shotQuality(t.x, t.z).q * open;
        score += chance * 0.55;
      }
      // the human is a legitimate, slightly-preferred target when they've
      // found space ahead (but not mandatory — AI still shares between mates)
      if (t.isHuman && forward > 1.5) score += 0.22;
      if (!best || score > best.score) best = { player: t, score: score, d: d, chance: chance };
    }
    return best;
  },

  // ---------- TEAMMATE HAS THE BALL ----------
  // Build 8: role spots scale with the cage, and in the final third the
  // shape turns into a real attack: the runner attacks the far post, the
  // link man arrives at the edge of the box for the cut-back, the holder
  // stays back as the safety valve. Each spot is then nudged to the best of
  // a few nearby points — away from markers, with a clear lane from the ball.
  offenseSupport: function () {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var carrier = M.ownerPlayer();
    var D = this.difficulty();
    var agg = D.attackingAggression || 1;
    var dir = this.attDir();
    var sl = LG.Pitch.sl(), sw = LG.Pitch.sw();
    var GL = LG.Config.court.length / 2;

    // "s" = progress toward the enemy goal (−GL own goal line .. +GL theirs)
    var ballS = dir * M.ball.z;
    var cs = carrier ? dir * carrier.z : ballS;
    var cx = carrier ? carrier.x : M.ball.x;
    var push = U.lerp(3, 9, me.stats.speed / 10) * (0.72 + 0.28 * agg) * sl;
    var finalThird = cs > GL - 14 * sl && !(carrier && carrier.isGoalkeeper);
    var s, x;

    switch (me.idx) {
      case 0:
        // holding man: sits behind the ball, the release valve / shield
        s = U.clamp(ballS - Math.max(8 * sl, push), -16 * sl, 3 * sl);
        x = U.lerp(0, cx, 0.4);
        break;
      case 1:
        if (finalThird) {
          // arrive at the edge of the box for the cut-back / second ball
          s = U.clamp(GL - 9.5, cs - 6, GL - 7);
          x = U.clamp(-cx * 0.35, -4 * sw, 4 * sw);
        } else {
          // link man: just behind the ball, drifting to the carrier's side
          s = U.clamp(cs - push * 0.55, -12 * sl, 10 * sl);
          x = U.lerp(-3.5 * sw, cx, 0.55);
        }
        break;
      case 2:
      default:
        if (finalThird) {
          // attack the far post — the cross / square ball lands there
          s = GL - U.lerp(3.5, 5.5, 1 - agg / 1.3);
          x = (cx >= 0 ? -1 : 1) * U.lerp(1.6, 3.2, U.clamp(Math.abs(cx) / 8, 0, 1));
        } else {
          // forward runner: highest line, hugs the far side to stretch the box
          s = U.clamp(cs + push, 7 * sl, 18.5 * sl);
          x = (cx >= 0 ? -1 : 1) * U.lerp(3.5, 7.5, me.stats.speed / 12) * sw;
        }
        break;
    }

    var tx = x + (U.rand() - 0.5) * 1.6, tz = dir * s + (U.rand() - 0.5) * 1.1;
    var best = this.findSpace(tx, tz, carrier);
    this.moveTarget = { x: LG.Pitch.cx(best.x, 1.5), z: LG.Pitch.cz(best.z, 1.5) };
    // call for a pass sometimes
    this.actionCd = Math.max(this.actionCd, 0);
  },

  // pick the most useful of a few points around a role spot: far from the
  // nearest opponent, with an open lane from the ball carrier. Pure scoring —
  // no gameplay randomness (keeps the sim's RNG stream untouched).
  findSpace: function (tx, tz, carrier) {
    var M = LG.Match, me = this.p;
    var opps = M.opponents(me);
    var off = [[0, 0], [1.8, 0], [-1.8, 0], [0, 1.6], [0, -1.6]];
    var best = { x: tx, z: tz }, bestS = -1e9;
    for (var i = 0; i < off.length; i++) {
      var px = LG.Pitch.cx(tx + off[i][0], 1.5), pz = LG.Pitch.cz(tz + off[i][1], 1.5);
      var near = 1e9;
      for (var j = 0; j < opps.length; j++) {
        if (opps[j].isGoalkeeper) continue;
        var d = opps[j].distTo(px, pz);
        if (d < near) near = d;
      }
      var sc = Math.min(near, 6) - (i === 0 ? 0 : 0.6);
      if (carrier && carrier !== me) {
        var lane = 1e9;
        for (var k = 0; k < opps.length; k++) {
          if (opps[k].isGoalkeeper) continue;
          var ld = M.segToPoint(carrier.x, carrier.z, px, pz, opps[k].x, opps[k].z);
          if (ld < lane) lane = ld;
        }
        if (lane < 1.3) sc -= (1.3 - lane) * 2.2;
      }
      if (sc > bestS) { bestS = sc; best = { x: px, z: pz }; }
    }
    return best;
  },

  // ---------- OPPONENT HAS THE BALL ----------
  defense: function () {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var ball = M.ball;
    var myGoal = M.myGoal(me.team);
    var carrier = M.ownerPlayer();
    var D = this.difficulty();
    // pressing: how much room the challenge is given, and how soon the side
    // commits. A passive side stands off and gives the carrier time on the ball.
    var press = D.pressingIntensity || 1;

    if (this.isClosestChaser()) {
      // containment & tackle: approach goalside/shoulder instead of brainless rear-sprinting
      var tx, tz;
      if (carrier) {
        var d = me.distTo(carrier.x, carrier.z);
        // anticipation: meet the attacker where they are GOING, so a quick
        // carrier cannot simply out-run the challenge every time
        var lead = Math.min(0.5, d / Math.max(me.maxSpeed, 1) * 0.55);
        var cx = carrier.x + carrier.vx * lead;
        var cz = carrier.z + carrier.vz * lead;
        // containment point: sit goalside of the carrier, on the ball side
        var gDx = myGoal.x - cx, gDz = myGoal.z - cz;
        var gLen = Math.sqrt(gDx * gDx + gDz * gDz) || 1;
        var stand = Math.min(1.6, 0.45 + d * 0.28) * (1.9 - 0.9 * press);
        tx = cx + (gDx / gLen) * stand;
        tz = cz + (gDz / gLen) * stand;
        this.moveTarget = { x: LG.Pitch.cx(tx, 1), z: LG.Pitch.cz(tz, 1) };

        // only challenge when actually in range AND awake to the play — and
        // tryTackle refuses to hand over the ball for a challenge from behind
        var challengeAt = 2.1 * press;
        // the keeper is not an outfield target: when he holds the ball the
        // chaser keeps a stand-off and does not lunge into the six-yard box
        if (carrier && carrier.isGoalkeeper) {
          challengeAt = Math.min(challengeAt, (LG.Config.ai.keeperStandoff || 1.7) * 0.9);
        }
        if (this.reactT > 0) challengeAt = 0;
        if (this.actionCd <= 0 && d < challengeAt) {
          this.attemptTackle(d);
        }
      } else {
        tx = ball.x; tz = ball.z;
        this.moveTarget = { x: tx, z: tz };
        var db = me.distTo(tx, tz);
        if (this.actionCd <= 0 && this.reactT <= 0 && db < 2.25) {
          this.attemptTackle(db);
        }
      }
    } else {
      // cover passing lanes & dangerous attackers. With an AI DEF man the slot
      // order owns the marks (DEF takes the top threat, MID the second, the
      // FWD guards the deep zone); when the human is on DEF the two AI men
      // pick up the top-two threats instead. defensiveAggression decides how
      // high the covering men hold: a passive side drops off toward its own
      // goal and concedes space.
      var sink = U.clamp((1 - (D.defensiveAggression || 1)) * 0.55, -0.3, 0.6);

      // rank the opponent's forward options by threat: close to the carrier
      // AND close to our goal is the pass that kills us
      var marks = [];
      var opps = M.teamPlayers(1 - me.team);
      for (var mi = 0; mi < opps.length; mi++) {
        var mo = opps[mi];
        if (mo === carrier || mo.isGoalkeeper) continue;   // never mark the keeper
        var danger = M.distToGoal(mo) * 0.6 + (carrier ? mo.distTo(carrier.x, carrier.z) : 0);
        marks.push({ o: mo, danger: danger });
      }
      marks.sort(function (a, b) { return a.danger - b.danger; });

      var mine = null;
      if (marks.length) {
        // is OUR DEF slot an AI or the human? When the human is on DEF they
        // never run this module, so the two AI outfielders must take over the
        // top-two marks. When DEF is AI, the slot order (DEF then MID) owns
        // the marks exactly as before and the FWD guards the deep zone.
        var defP = null;
        var matesD = M.teamPlayers(me.team);
        for (var dij = 0; dij < matesD.length; dij++) {
          if (matesD[dij].idx === 0) { defP = matesD[dij]; break; }
        }
        var defIsAi = !!(defP && defP.ai && !defP.isHuman);
        if (defIsAi) {
          if (me.idx === 0) mine = marks[0].o;                    // DEF man: top threat
          else if (me.idx === 1 && marks.length > 1) mine = marks[1].o;  // MID: second
        } else {
          if (me.idx === 1) mine = marks[0].o;                    // MID covers the top threat
          else if (me.idx === 2 && marks.length > 1) mine = marks[1].o;  // FWD: second
        }
      }

      if (mine && carrier) {
        // cut the passing lane between carrier & receiver, leaning goalside
        var lx = (carrier.x + mine.x * 1.3) / 2.3;
        var lz = (carrier.z + mine.z * 1.3) / 2.3;
        lz += (myGoal.z - lz) * 0.3;
        // never let the mark get goal side of me
        if (me.team === 0) lz = Math.max(lz, mine.z + 0.7);
        else lz = Math.min(lz, mine.z - 0.7);
        this.moveTarget = this.sinkTo({
          x: LG.Pitch.cx(lx, 1.5),
          z: LG.Pitch.cz(lz, 1.5),
        }, myGoal, sink);
      } else {
        // zonal cover: hold the line between the ball and our goal, shielding
        // the mouth from cutters — the back four when there is no man to mark
        var lz2 = myGoal.z - this.attDir() * 2.6;
        var lx2 = U.clamp(M.ball.x * 0.7, -7 * LG.Pitch.sw(), 7 * LG.Pitch.sw());
        this.moveTarget = this.sinkTo({
          x: LG.Pitch.cx(lx2 + (U.rand() - 0.5) * 1.8, 1.5),
          z: LG.Pitch.cz(lz2, 1.5),
        }, myGoal, sink);
      }
    }
    // whoever we are marking or covering, never crowd or trap the opponent
    // goalkeeper — the zone applies to chasers, markers and zonal cover alike
    this.respectKeeperZone(this.moveTarget);
    me.want.tackle = false;
  },

  // Keeper exclusion zone: outfield AI never crowds or traps the opponent
  // goalkeeper. Applies when we are already in his neighbourhood (or he is the
  // carrier we are chasing) — a global goal-side clamp would misfire whenever a
  // keeper is parked off his line (rebounds, tests, distribution runs).
  // Rules: at least keeperZoneR clear (keeperStandoff when he holds the ball),
  // and never stand between him and his own goal.
  respectKeeperZone: function (target) {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var K = LG.Config.ai;
    var opps = M.opponents(me);
    var gk = null, i;
    for (i = 0; i < opps.length; i++) {
      if (opps[i].isGoalkeeper) { gk = opps[i]; break; }
    }
    if (!gk || !target) return target;

    var zone = K.keeperZoneR || 2.6;
    var standoff = K.keeperStandoff || 1.7;
    var gSign = gk.team === 0 ? 1 : -1;          // +z = home keeper's net
    var carrier = M.ownerPlayer();
    var dx0 = target.x - gk.x, dz0 = target.z - gk.z;
    var near = Math.sqrt(dx0 * dx0 + dz0 * dz0) < zone + 3;
    if (carrier !== gk && !near) return target;  // not in the keeper's office

    // general exclusion is the full zone; the chaser may close to stand-off
    // when the keeper is the one holding the ball. During the protection
    // window (hold after a save / before distribution) EVERY opponent backs
    // off to the protect radius so he is never mobbed or tackled on the spot.
    var minR;
    if (carrier === gk) {
      var protecting = gk.distributeT > 0 || gk._saveProtectT > 0;
      if (protecting) minR = K.keeperProtectR || 3.4;
      else minR = this.isClosestChaser() ? standoff : zone;
    } else {
      minR = zone;
    }

    // never stand goal-side of the keeper (between him and his own net)
    if ((target.z - gk.z) * gSign > 0) target.z = gk.z;

    var dx = target.x - gk.x, dz = target.z - gk.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d < minR) {
      if (d > 0.001) {
        target.x = gk.x + (dx / d) * minR;
        target.z = gk.z + (dz / d) * minR;
      } else {
        target.x = gk.x;
        target.z = gk.z - gSign * minR;
      }
      // radial push can slip goal-side again on a diagonal — re-clamp
      if ((target.z - gk.z) * gSign > 0) target.z = gk.z;
    }

    target.x = LG.Pitch.cx(target.x, 0.4);
    target.z = LG.Pitch.cz(target.z, 0.4);
    return target;
  },

  // Blend a defensive position toward (sink > 0) or away from (sink < 0) our
  // own goal. Identity at sink === 0, so the balanced level is untouched.
  sinkTo: function (pt, goal, sink) {
    if (!sink) return pt;
    return {
      x: LG.Pitch.cx(pt.x + (goal.x - pt.x) * sink, 1.5),
      z: LG.Pitch.cz(pt.z + (goal.z - pt.z) * sink, 1.5),
    };
  },

  // ---------- LOOSE BALL ----------
  looseBall: function () {
    var me = this.p;
    var M = LG.Match;
    var U = LG.Util;
    var ball = M.ball;
    var dir = this.attDir();
    var ballS = dir * ball.z;

    // a side that has not read the turnover yet does not pounce on the loose
    // ball — it drops into shape and lets the alert side win it
    if (this.isClosestChaser() && this.reactT <= 0) {
      this.moveTarget = { x: ball.x, z: ball.z };
      return;
    }

    // role-appropriate recovery spot: the DEF holds deep, the MID drops to the
    // ball side for the second ball, the FWD keeps a high outlet so the team
    // can counter from the shape
    var s, x;
    var sl = LG.Pitch.sl(), sw = LG.Pitch.sw();
    switch (me.idx) {
      case 0:
        s = U.clamp(ballS - 7 * sl, -18 * sl, -4 * sl);
        x = U.clamp(ball.x * 0.5, -7 * sw, 7 * sw);
        break;
      case 1:
        s = U.clamp(ballS - 2 * sl, -12 * sl, 9 * sl);
        x = LG.Pitch.cx(ball.x + 3.5 * sw, 1.5);
        break;
      case 2:
      default:
        s = U.clamp(ballS + 8 * sl, 3 * sl, 18 * sl);
        x = (ball.x >= 0 ? -1 : 1) * 5 * sw;
        break;
    }
    this.moveTarget = {
      x: LG.Pitch.cx(x + (U.rand() - 0.5) * 1.6, 1.5),
      z: LG.Pitch.cz(dir * s + (U.rand() - 0.5) * 1.2, 1.5),
    };
  },
};