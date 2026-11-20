// ============================================================
// KEEPER MOTION (Build 6) — goalkeepers move like goalkeepers.
// The keeper brain and Match.updateKeepers still decide WHERE the
// keeper goes and whether a shot is stopped; this layer only makes the
// body show it:
//   DIVE    a shot wide of the keeper -> full-stretch sideways dive:
//           take-off, airborne and horizontal, land on the side, get up
//   JUMP    a high ball over the keeper -> spring up, arms high
//   SET     an attacker closing in -> a low, ready crouch
//   THROW   short distribution -> overarm throw instead of a kick
//   PUNCH   a parried save the keeper didn't dive for -> fist it away
// The model group is tilted/lifted AFTER Player.update placed it, so
// gameplay positions never change. One state per keeper, no allocation
// per frame. Works for both keepers (and for a mirrored online guest).
// ============================================================
var LG = window.LG = window.LG || {};

LG.KeeperMotion = (function () {
  var DIVE = 1.25, FLIGHT = 0.4, DOWN = 0.78;
  var JUMP = 0.7;
  var bound = false;

  function ease(t) { return t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t); }
  function anim(p) { return p && p.model && p.model.anim && p.model.anim.emote ? p.model.anim : null; }

  // side of a world point relative to the keeper: +1 = keeper's left
  function sideOf(p, x, z) {
    var f = p.facing || 0;
    var lat = (x - p.x) * Math.cos(f) + (z - p.z) * -Math.sin(f);
    return { side: lat >= 0 ? 1 : -1, lat: Math.abs(lat) };
  }

  function start(p, kind, o) {
    if (!p || !p.isGoalkeeper) return false;
    var cur = p._km;
    if (cur && cur.kind === 'dive' && cur.t < DIVE * 0.8) return false;   // a dive is a commitment
    o = o || {};
    p._km = { kind: kind, t: 0, side: o.side || 1, reach: o.reach || 0.5, high: !!o.high };
    var a = anim(p);
    if (a) {
      if (kind === 'dive') a.emote('jump_start', { dur: FLIGHT + 0.1, restart: true, ts: 1.5 });
      else if (kind === 'jump') a.emote('jump_start', { dur: JUMP * 0.6, restart: true, ts: 1.6 });
      else if (kind === 'throw' || kind === 'punch') a.emote('push', { dur: 0.6, restart: true, ts: 1.5 });
    }
    if (kind === 'dive' && LG.eventBus) LG.eventBus.emit('keeperDive', { gk: p, side: p._km.side });
    return true;
  }

  // brain hook: a shot is coming and the keeper has committed to (tx,tz)
  function onThreat(p, tx, tz, ball) {
    if (!p || !ball) return;
    var seq = ball._kickSeq || 0;
    if (p._kmSeq === seq) return;                 // one decision per kick
    var s = sideOf(p, tx, tz);
    var high = (ball.y || 0) > 1.55 && ball.vy > -1;
    if (s.lat > 0.65) {
      p._kmSeq = seq;
      start(p, 'dive', { side: s.side, reach: Math.min(1.1, s.lat * 0.5), high: high });
    } else if (high) {
      p._kmSeq = seq;
      start(p, 'jump', { high: true });
    }
  }

  function bind() {
    if (bound || !LG.eventBus) return;
    bound = true;
    var bus = LG.eventBus;
    bus.on('keeperSave', function (e) {
      var gk = e && e.gk, m = LG.Match;
      if (!gk || !m || !m.ball || (gk._km && gk._km.kind === 'dive')) return;
      var s = sideOf(gk, m.ball.x, m.ball.z);
      if (s.lat > 0.55) start(gk, 'dive', { side: s.side, reach: 0.4 });
      else if (m.ball.y > 1.5) start(gk, 'jump', { high: true });
      else if (e.parry) start(gk, 'punch');
    });
    // beaten: a late, full-stretch dive at a ball going in wide of the keeper
    bus.on('goal', function (e) {
      var m = LG.Match;
      if (!m || !m.ball || !e) return;
      var gk = null, team = e.team === 0 ? 1 : 0;
      for (var i = 0; i < m.all.length; i++) if (m.all[i].isGoalkeeper && m.all[i].team === team) gk = m.all[i];
      if (!gk || (gk._km && gk._km.kind === 'dive')) return;
      var s = sideOf(gk, m.ball.x, m.ball.z);
      if (s.lat > 0.5) start(gk, 'dive', { side: s.side, reach: 0.9 });
    });
    // Build 8: the brain says HOW it restarts — a roll or a throw is
    // delivered by hand (no kick swing), a long ball / clearance is kicked
    bus.on('keeperDistribute', function (e) {
      var gk = e && e.gk;
      if (!gk) return;
      var byHand = e.kind ? (e.kind === 'roll' || e.kind === 'throw') : (e.target && gk.distTo(e.target.x, e.target.z) < 12);
      if (byHand) { gk.kickAnim = 0; start(gk, 'throw'); }
    });
  }

  // after every Player.update: lay the body over the gameplay position
  function update(m, dt) {
    bind();
    if (!m || !m.all) return;
    for (var i = 0; i < m.all.length; i++) {
      var p = m.all[i];
      if (!p.isGoalkeeper || !p.model || !p.model.group) continue;
      var g = p.model.group, k = p._km;
      g.rotation.z = 0;
      // SET: crouch a touch when an attacker carries the ball close to goal
      var crouch = 0;
      var car = m.ownerPlayer ? m.ownerPlayer() : null;
      if (car && car.team !== p.team && !k) {
        var d = p.distTo(car.x, car.z);
        if (d < 11) crouch = (11 - Math.max(4, d)) / 7;
      }
      p._kmCrouch = (p._kmCrouch || 0) + (crouch - (p._kmCrouch || 0)) * Math.min(1, dt * 6);
      if (!k) {
        if (p._kmCrouch > 0.01) { g.scale.y = (p._kmBaseSY || (p._kmBaseSY = g.scale.y)) * (1 - 0.07 * p._kmCrouch); }
        else if (p._kmBaseSY) g.scale.y = p._kmBaseSY;
        p._kmDive = false;
        continue;
      }
      if (p._kmBaseSY) g.scale.y = p._kmBaseSY;
      k.t += dt;
      var f = p.facing || 0, lx = Math.cos(f), lz = -Math.sin(f);
      if (k.kind === 'dive') {
        p._kmDive = true;
        var roll, lift, shift;
        if (k.t < FLIGHT) {                        // take-off and flight
          var u = k.t / FLIGHT;
          roll = 1.3 * ease(u * 1.4);
          lift = (k.high ? 0.95 : 0.5) * Math.sin(Math.PI * u);
          shift = k.reach * ease(u);
        } else if (k.t < DOWN) {                   // landed on the side
          roll = 1.45; lift = 0.12; shift = k.reach;
        } else {                                   // push up and recover
          var r = ease((k.t - DOWN) / (DIVE - DOWN));
          roll = 1.45 * (1 - r); lift = 0.12 * (1 - r); shift = k.reach * (1 - r);
          if (!k.up) { k.up = true; var a = anim(p); if (a) a.emote('jump_land', { dur: 0.5, restart: true }); }
        }
        // +1 side = keeper's left = local +x; a +z roll tips the head toward -x
        g.rotation.z = -k.side * roll;
        g.position.x += lx * k.side * shift;
        g.position.z += lz * k.side * shift;
        g.position.y += lift;
        if (k.t >= DIVE) { p._km = null; p._kmDive = false; g.rotation.z = 0; }
      } else if (k.kind === 'jump') {
        var uj = Math.min(1, k.t / JUMP);
        g.position.y += 0.7 * Math.sin(Math.PI * uj);
        if (k.t >= JUMP) p._km = null;
      } else {                                     // throw / punch: the clip does it
        if (k.t >= 0.6) p._km = null;
      }
    }
  }

  function reset(m) {
    if (!m || !m.all) return;
    for (var i = 0; i < m.all.length; i++) {
      var p = m.all[i];
      if (!p.isGoalkeeper) continue;
      p._km = null; p._kmDive = false;
      if (p.model && p.model.group) { p.model.group.rotation.z = 0; if (p._kmBaseSY) p.model.group.scale.y = p._kmBaseSY; }
    }
  }

  return { update: update, onThreat: onThreat, start: start, reset: reset, sideOf: sideOf,
    state: function (p) { return p && p._km ? { kind: p._km.kind, t: p._km.t, side: p._km.side } : null; } };
})();
