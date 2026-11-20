// ============================================================
// AI SPECIALS (Build 6) — the CPU side fires its special moves.
// Every AI-controlled outfield player on the ROGUE side (team 1) with a
// full meter looks for the moment its ability is made for, then fires
// it through the SAME Player.activateAbility the human uses — so the
// effects, banners and cooldowns are identical. Difficulty decides how
// quickly a CPU player spots its moment (EASY hesitates, HARD pounces).
// Uses a private PRNG so the seed-pinned gameplay sim is not disturbed
// by the decision itself.
// ============================================================
var LG = window.LG = window.LG || {};

LG.AISpecials = (function () {
  var seed = 1337;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  // per-second chance of acting once the moment is right
  var EAGER = { easy: 0.35, medium: 0.9, hard: 2.2 };

  function eagerness() {
    var lvl = (LG.Difficulty && LG.Difficulty.get) ? LG.Difficulty.get() : 'medium';
    return EAGER[lvl] || EAGER.medium;
  }

  function abilityOf(p) { return p._rumbleAbility || (p.def && p.def.ability) || null; }

  // is THIS the moment for ability `id`? (pure read of the match state)
  function moment(m, p, id) {
    var carrier = m.ownerPlayer();
    var goal = m.enemyGoal(p.team), mine = m.myGoal(p.team);
    var dGoal = p.distTo(goal.x, goal.z);
    var opp = carrier && carrier.team !== p.team ? carrier : null;
    switch (id) {
      case 'BURST':        // a run with space ahead
        return p.hasBall && dGoal > 7 && m.pressure(p, 3) < 0.5;
      case 'POWER_SHOT':   // in range with the ball
        return p.hasBall && dGoal < m.shootRange(p) + 2;
      case 'DRIBBLE_RUSH': // closed down while carrying
        return p.hasBall && m.pressure(p, 3) > 0.45;
      case 'SUPER_TACKLE': // an opponent carrier right there
        return !!opp && p.distTo(opp.x, opp.z) < 2.6;
      case 'PERFECT_PASS': // carrying, with a mate further up
        if (!p.hasBall) return false;
        var mates = m.teamPlayers(p.team);
        for (var i = 0; i < mates.length; i++) {
          var q = mates[i];
          if (q === p || q.isGoalkeeper) continue;
          if (q.distTo(goal.x, goal.z) < dGoal - 3) return true;
        }
        return false;
      case 'FREEZE':       // they are bearing down on our goal
        return !!opp && opp.distTo(mine.x, mine.z) < 13;
      case 'SHOCKWAVE':    // crowded scramble near the ball
        return (!!opp && p.distTo(opp.x, opp.z) < 3) || (!carrier && p.distTo(m.ball.x, m.ball.z) < 2.5 && m.pressure(p, 3) > 0.4);
      case 'WALL':         // stand between the carrier and our goal
        if (!opp || opp.distTo(mine.x, mine.z) > 10) return false;
        var between = m.segToPoint(opp.x, opp.z, mine.x, mine.z, p.x, p.z) < 1.4;
        return between && p.distTo(opp.x, opp.z) < 5;
    }
    return false;
  }

  function update(m, dt) {
    if (!m || m.state !== 'PLAY' || (m.opts && m.opts.noAISpecials)) return 0;
    var fired = 0, eager = eagerness();
    for (var i = 0; i < m.away.length; i++) {
      var p = m.away[i];
      if (p.isHuman || p.isGoalkeeper || !p.ai || !p.meterFull || p.active || p.stun > 0) continue;
      var id = abilityOf(p);
      if (!id || !LG.Abilities[id]) continue;
      if (!moment(m, p, id)) { p._aiSpecialWait = 0; continue; }
      p._aiSpecialWait = (p._aiSpecialWait || 0) + dt;
      if (p._aiSpecialWait < 0.12) continue;            // a beat to "see" it
      if (rnd() < eager * dt) {
        p.activateAbility();
        p._aiSpecialWait = 0;
        fired++;
      }
    }
    return fired;
  }

  return { update: update, moment: moment, reseed: function (s) { seed = (s | 0) || 1337; } };
})();
