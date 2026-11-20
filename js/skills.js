// ============================================================
// SKILLS — Build 7 skill moves. A small set, each one finished:
//
//   SKILL + no stick / stick forward  BODY FEINT   drop a shoulder one way,
//                                     go the other. A defender in front
//                                     may bite (stats decide) and lose a
//                                     step. Cheap, short, the bread & butter.
//   SKILL + stick back                DRAG BACK    sole the ball back under
//                                     the body and turn away from pressure.
//   SKILL + stick left/right          ROULETTE     a full 360 spin moving to
//                                     that side, the body between ball and
//                                     tackler — a well-timed one rides a
//                                     challenge, a late one is just a spin.
//   SKILL + stick forward + SPRINT    RAINBOW FLICK  heel the ball up over
//                                     your own head and a defender's, then
//                                     run onto it. Mistimed next to a
//                                     defender, it pops up off him.
//   SKILL held while SHOOT releases   FINESSE SHOT  placed, curled at the far
//                                     post: slower than a laces strike, more
//                                     accurate, bends back in.
//   SHOOT held as a pass arrives      FIRST-TIME SHOT on the ground, VOLLEY
//                                     if it arrives in the air.
//
// Balance: every move has a cooldown and costs a sliver of stamina; no
// move makes the carrier untouchable — only a roulette spun AT the
// challenge (in its middle third) rides a tackle, and only the bite of a
// feint slows a defender (for 0.4 s, with a stat-weighted chance).
//
// Multiplayer: moves start inside the authoritative match (host), are sent
// as the skill id in every snapshot plus a 'skillMove' event, and are
// mirrored on the friend's phone. The friend's own star also starts the
// move locally the moment SKILL is pressed (prediction), so it does not
// wait for the round trip; the host's copy reconciles it.
// Motion runs inside Player.update (drive + pose), so the host, the
// friend's prediction and the AI all execute the exact same code.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Skills = (function () {
  var DEF = {
    1: { key: 'feint', label: 'BODY FEINT', dur: 0.46, cd: 0.9, cost: 0.05 },
    2: { key: 'dragback', label: 'DRAG BACK', dur: 0.5, cd: 1.0, cost: 0.05 },
    3: { key: 'roulette', label: 'ROULETTE', dur: 0.62, cd: 1.5, cost: 0.09 },
    4: { key: 'rainbow', label: 'RAINBOW FLICK', dur: 0.56, cd: 2.4, cost: 0.12 },
  };
  var used = {};          // per-match counters for the stats/test panel
  // decisions use a PRIVATE generator so the gameplay Math.random stream
  // (seed-pinned in the sim suite) is not shifted by who tried a skill
  var seed = 0x5eed1;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

  function ease(t) { return t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t); }
  function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

  // which move the stick asks for, relative to where the body faces
  function choose(p, wv, sprint) {
    var mag = Math.sqrt(wv.x * wv.x + wv.z * wv.z);
    var fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    if (mag < 0.3) return { id: 1, side: (p._feintSide = -(p._feintSide || 1)) };
    var nx = wv.x / mag, nz = wv.z / mag;
    var dot = nx * fx + nz * fz, cross = fz * nx - fx * nz;   // >0 = stick to the body's left
    if (dot < -0.5) return { id: 2, side: cross >= 0 ? 1 : -1 };
    if (dot < 0.5) return { id: 3, side: cross >= 0 ? 1 : -1, dir: { x: nx, z: nz } };
    if (sprint) return { id: 4, side: 1 };
    return { id: 1, side: cross >= 0 ? 1 : -1 };
  }

  function canStart(m, p) {
    return p && p.hasBall && !p._skill && !(p._skillCd > 0) && !(p.stun > 0) && !p.isGoalkeeper &&
      (!m || m.state === 'PLAY') && !(p.active && p.active.type === 'WALL');
  }

  // start a move. opts.local: friend-side prediction (body + animation only)
  function start(m, p, wv, sprint, opts) {
    opts = opts || {};
    if (!canStart(m, p)) return false;
    var c = choose(p, wv || { x: 0, z: 0 }, !!sprint);
    var D = DEF[c.id];
    var fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    p._skill = { id: c.id, t: 0, dur: D.dur, side: c.side, f0: p.facing, fx: fx, fz: fz,
      dir: c.dir || { x: fx, z: fz }, local: !!opts.local, flicked: false };
    p._skillCd = D.cd;
    p.stamina = Math.max(0, (p.stamina || 0) - D.cost);
    used[D.key] = (used[D.key] || 0) + 1;
    animate(p, c.id, c.side);
    if (!opts.local && m) {
      if (c.id === 1) bite(m, p);
      m.bus.emit('skillMove', { player: p, id: c.id, dir: c.side });
      if (p.isHuman && p.team === 0 && LG.HUD && LG.HUD.toast) LG.HUD.toast(D.label, 650);
    }
    return true;
  }

  // the authored clip that carries each move (the code moves the body)
  function animate(p, id, side) {
    var a = p.model && p.model.anim;
    if (!a || !a.emote) return;
    try {
      if (id === 1) a.emote(side > 0 ? 'dodge_l' : 'dodge_r', { dur: 0.46, ts: 2.6, hold: true, restart: true, from: 0.05 });
      else if (id === 2) a.emote(side > 0 ? 'turn_l' : 'turn_r', { dur: 0.5, ts: 2.4, hold: true, restart: true, from: 0.25 });
      else if (id === 3) a.emote(side > 0 ? 'turn_l' : 'turn_r', { dur: 0.62, ts: 2.2, hold: true, restart: true, from: 0.1 });
      else if (id === 4) a.emote('jump_start', { dur: 0.5, ts: 2.2, hold: true, restart: true, from: 0.1 });
    } catch (e) { /* rig busy: the motion still happens */ }
  }

  // BODY FEINT: a defender squared up in front may commit the wrong way
  function bite(m, p) {
    var opps = m.opponents ? m.opponents(p) : [];
    var fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    for (var i = 0; i < opps.length; i++) {
      var o = opps[i];
      if (o.isGoalkeeper) continue;
      var dx = o.x - p.x, dz = o.z - p.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d > 2.8 || d < 0.01) continue;
      if ((dx * fx + dz * fz) / d < 0.35) continue;          // not in front
      var drib = (p.stats && p.stats.dribble) || 6, def = (o.stats && o.stats.defense) || 6;
      var chance = Math.max(0.25, Math.min(0.75, 0.48 + (drib - def) * 0.05));
      if (rnd() < chance) { o._bitT = 0.4; if (LG.Particles && LG.Particles.dust) LG.Particles.dust(o.x, o.z, 2); }
    }
  }

  // ---- runs inside Player.update, BEFORE the velocity integration ----
  // Sets the body's wanted motion for this phase of the move.
  function drive(p, dt) {
    var s = p._skill;
    if (!s) return;
    s.t += dt;
    var u = s.t / s.dur;
    if (u >= 1) { end(p); return; }
    // lost the ball mid-move (tackled, a goal reset): the move is over
    if (!s.mirror && !p.hasBall && !(s.id === 4 && s.flicked)) { end(p); return; }
    var fx = s.fx, fz = s.fz, rx = fz, rz = -fx;              // body-right
    var wx = 0, wz = 0;
    if (s.id === 1) {
      // feint: a short dip AGAINST the side, then the push the other way
      var k = u < 0.32 ? -0.35 : 1.0;
      wx = fx * 0.55 + rx * -s.side * k * 0.75;
      wz = fz * 0.55 + rz * -s.side * k * 0.75;
      if (u < 0.32) { wx *= 0.5; wz *= 0.5; }
    } else if (s.id === 2) {
      // drag back: stop dead, then roll away the way we came
      if (u < 0.4) { wx = 0; wz = 0; p.vx *= Math.pow(0.02, dt); p.vz *= Math.pow(0.02, dt); }
      else { wx = -fx * 0.7; wz = -fz * 0.7; }
    } else if (s.id === 3) {
      // roulette: carry across, slowed by the spin
      wx = s.dir.x * 0.62; wz = s.dir.z * 0.62;
    } else if (s.id === 4) {
      // rainbow: keep running through
      wx = fx * 0.95; wz = fz * 0.95;
    }
    p.want.x = wx; p.want.z = wz;
  }

  // ---- runs inside Player.update, AFTER the facing logic ----
  // Owns the body's facing during the move and lifts the ball for the flick.
  function pose(p, dt) {
    var s = p._skill;
    if (!s) return;
    var u = Math.min(1, s.t / s.dur);
    if (s.id === 2) p.facing = s.f0 + s.side * Math.PI * ease((u - 0.15) / 0.7);
    else if (s.id === 3) p.facing = s.f0 + s.side * 2 * Math.PI * ease(u);
    else if (s.id === 1) p.facing = s.f0 - s.side * 0.35 * Math.sin(Math.PI * u);
    else p.facing = s.f0;
    if (s.id === 4 && !s.flicked && u > 0.3) flick(p, s);
  }

  // where the carried ball sits during a move (match.placeBallOnCarrier)
  function ballSpot(p) {
    var s = p._skill;
    if (!s) return null;
    var u = Math.min(1, s.t / s.dur);
    if (s.id === 2) return { ahead: 0.72 - 0.95 * Math.sin(Math.PI * Math.min(1, u / 0.55)) * (u < 0.55 ? 1 : 0) + (u >= 0.55 ? -0.23 + 0.95 * (u - 0.55) / 0.45 : 0), side: 0, lift: 0 };
    if (s.id === 3) return { ahead: 0.42, side: 0, lift: 0 };        // tucked, swept round with the body
    if (s.id === 1) return { ahead: 0.62, side: 0.14 * -s.side * Math.sin(Math.PI * u), lift: 0 };
    if (s.id === 4) return { ahead: 0.25 - 0.4 * Math.min(1, u / 0.3), side: 0, lift: 0.35 * Math.min(1, u / 0.3) };
    return null;
  }

  // RAINBOW: the ball goes up and over; the carrier runs onto it
  function flick(p, s) {
    s.flicked = true;
    var m = LG.Match;
    if (s.local || !m || !p.hasBall || m.ball.owner !== p) return;
    var ball = m.ball, fx = s.fx, fz = s.fz;
    // a defender right in the ball's path takes it off the shin
    var blocked = false, opps = m.opponents ? m.opponents(p) : [];
    for (var i = 0; i < opps.length; i++) {
      var dx = opps[i].x - p.x, dz = opps[i].z - p.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1.2 && (d < 0.45 || (dx * fx + dz * fz) / (d || 1) > 0.3)) blocked = true;
    }
    m.release(p);
    var sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    var fwd = blocked ? 2.5 : Math.max(5.2, sp * 1.05);
    ball.y = Math.max(ball.y, 0.75);
    ball.kick(fx * fwd, blocked ? 2.2 : 7.6, fz * fwd);
    ball.lastKicker = p; ball.kickT = 0.25;
    if (blocked) { ball.vx *= -0.4; ball.vz *= -0.4; }
  }

  function end(p) { if (!p._skill) return; p._skill = null; }

  // tackles: a roulette spun into the challenge rides it
  function evades(victim) {
    var s = victim && victim._skill;
    if (!s || s.id !== 3) return false;
    var u = s.t / s.dur;
    return u > 0.2 && u < 0.62;
  }

  // the friend's phone: show a move the host started
  function mirror(p, id, side) {
    if (!id) { end(p); return; }
    if (p._skill && p._skill.id === id) return;
    var D = DEF[id];
    if (!D) return;
    var fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    p._skill = { id: id, t: 0, dur: D.dur, side: side || 1, f0: p.facing, fx: fx, fz: fz, dir: { x: fx, z: fz }, local: true, flicked: true, mirror: true };
    animate(p, id, side || 1);
  }

  // ---- FINESSE: a curled, placed shot. Called by match after the kick ----
  function finesse(m, h, ball, goal) {
    var C = LG.Config.court;
    var sp = Math.sqrt(ball.vx * ball.vx + ball.vz * ball.vz) || 1;
    // re-aim: far post, launched outside it, bending back in
    var farSide = (h.x >= 0 ? -1 : 1);
    var tx = farSide * C.goalWidth / 2 * 0.72, tz = goal.z;
    var dx = tx - ball.x, dz = tz - ball.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
    var speed = sp * 0.82;
    var bend = 0.16 * -farSide * (goal.z > 0 ? 1 : -1);           // launch angle off the line
    var ang = Math.atan2(dx, dz) + bend + (rnd() - 0.5) * 0.04;
    ball.vx = Math.sin(ang) * speed; ball.vz = Math.cos(ang) * speed;
    ball.vy = Math.min(ball.vy, 2.2);
    // lateral acceleration that brings it back onto the target over the flight
    var t = d / speed;
    var off = d * Math.sin(bend);
    var nx = Math.cos(Math.atan2(dx, dz)), nz = -Math.sin(Math.atan2(dx, dz));   // perpendicular
    var a = 2 * off / Math.max(0.2, t * t);
    ball.curveX = -nx * a; ball.curveZ = -nz * a; ball.curveT = t * 1.1;
    ball.spin = 18 * farSide;
    used.finesse = (used.finesse || 0) + 1;
    if (h.isHuman && h.team === 0 && LG.HUD && LG.HUD.toast) LG.HUD.toast('FINESSE', 600);
  }

  // ---- FIRST TIME / VOLLEY: SHOOT held as the ball arrives ----
  // returns true when it struck the ball
  function firstTime(m, h, charge) {
    var ball = m.ball;
    if (ball.owner || !h.wasShooting) return false;
    var dx = ball.x - h.x, dz = ball.z - h.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1.35 || ball.y > 1.7) return false;
    if (ball.lastKicker === h && ball.kickT > 0) return false;
    var closing = -(dx * ball.vx + dz * ball.vz) / (d || 1);
    if (closing < 1.5 && ball.y < 0.55) return false;          // not an arriving ball: let possession happen
    var volley = ball.y >= 0.55;
    var goal = m.enemyGoal(h.team);
    var C = LG.Config.court, P = LG.Config.physics;
    var aim = h.aimDir ? h.aimDir() : { x: 0, z: goal.z > 0 ? 1 : -1 };
    var gx = goal.x;
    if (aim.z * (goal.z > 0 ? 1 : -1) > 0.12) {
      var tt = (goal.z - h.z) / aim.z;
      if (tt > 0) gx = Math.max(-C.goalWidth / 2 * 0.9, Math.min(C.goalWidth / 2 * 0.9, h.x + aim.x * tt));
    }
    var tx = gx - ball.x, tz = goal.z - ball.z, td = Math.sqrt(tx * tx + tz * tz) || 1;
    var shoot = (h.stats && h.stats.shoot) || 6;
    var power = 0.55 + Math.max(0, Math.min(1, charge)) * 0.4;
    var sp = P.shootPower * (volley ? 1.12 : 1.02) * power * (0.85 + shoot * 0.02);
    var err = (volley ? 0.12 : 0.07) * (1.2 - shoot / 12) + (m.pressure ? m.pressure(h, 3) * 0.06 : 0);
    var ang = Math.atan2(tx, tz) + (rnd() - 0.5) * 2 * err;
    ball.kick(Math.sin(ang) * sp, volley ? 1.4 + rnd() * 1.6 : 0.6, Math.cos(ang) * sp);
    ball.lastKicker = h; ball.kickT = 0.3;
    h.kickAnim = 1; h.shotCharge = 0; h.wasShooting = false; h._ftLock = true;
    if (m.statSide) m.statSide(h.team).shots++;
    used[volley ? 'volley' : 'firstTime'] = (used[volley ? 'volley' : 'firstTime'] || 0) + 1;
    m.bus.emit('shoot', { player: h, power: power, firstTime: true, volley: volley });
    if (h.isHuman && h.team === 0 && LG.HUD && LG.HUD.toast) LG.HUD.toast(volley ? 'VOLLEY' : 'FIRST TIME', 600);
    return true;
  }

  // ---- the CPU dribbles too: a feint, drag back or roulette under pressure ----
  function aiTick(m, dt) {
    var c = m.ownerPlayer ? m.ownerPlayer() : null;
    if (!c || c.isHuman || c.isGoalkeeper || c._skill || c._skillCd > 0 || m.state !== 'PLAY') return;
    var opps = m.opponents(c), fx = Math.sin(c.facing), fz = Math.cos(c.facing), best = null, bd = 9;
    for (var i = 0; i < opps.length; i++) {
      var dx = opps[i].x - c.x, dz = opps[i].z - c.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d < bd && (dx * fx + dz * fz) / (d || 1) > -0.1) { bd = d; best = opps[i]; }
    }
    if (!best || bd > 2.2) return;
    var drib = (c.stats && c.stats.dribble) || 6;
    // EASY CPUs rarely dribble with tricks, HARD ones look for them
    var lvl = (LG.Difficulty && LG.Difficulty.get && LG.Difficulty.get()) || 'medium';
    var lm = lvl === 'easy' ? 0.35 : lvl === 'hard' ? 1.6 : 1.0;
    var rate = (0.3 + drib * 0.05) * lm;        // tries per second while pressed
    if (rnd() > rate * dt) return;
    var r = rnd(), wv;
    if (bd < 1.2 && r < 0.35) wv = { x: -fx, z: -fz };                                   // drag back
    else if (r < 0.6) { var s = rnd() < 0.5 ? 1 : -1; wv = { x: fz * s, z: -fx * s }; } // roulette
    else wv = { x: 0, z: 0 };                                                             // feint
    start(m, c, wv, false);
  }

  return {
    DEF: DEF, choose: choose, canStart: canStart, start: start, drive: drive, pose: pose, ballSpot: ballSpot,
    evades: evades, mirror: mirror, finesse: finesse, firstTime: firstTime, aiTick: aiTick, end: end,
    used: function () { return used; }, resetStats: function () { used = {}; },
  };
})();
