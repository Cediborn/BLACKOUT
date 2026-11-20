// ============================================================
// tools/looks/build8.js — Build 8 check on the REAL game in headless
// Chrome:  node tools/look.js tools/looks/build8.js --out <dir>
// The 30x50 cage and its fences (end panels + header over the bar), the
// reconstructed goal (frame, side/roof/back nets, rear frame), net ripple,
// goal detection through the real loop (legit goal, side netting, over the
// bar, post), the keeper's possession states and protection bubble, and
// the far cameras framing the bigger court. Matches are stepped directly
// where the headless renderer is too slow.
// ============================================================
module.exports = async function (page) {
  var fails = 0, n = 0;
  function check(ok, what) { n++; if (!ok) fails++; page.log((ok ? 'ok   ' : 'FAIL ') + what); }
  function J(expr) { return page.eval('JSON.stringify(' + expr + ')').then(JSON.parse); }

  await page.until("LG.Athlete && LG.Athlete.ready && LG.Athlete.ready()", 30000);
  await page.eval("LG.eventBus.emit('quickPlayRequested'); true");
  await page.until("LGMain.getState() === 'match'", 20000);
  await page.until("LGMain.getMatch().state === 'PLAY'", 30000);

  // ---------- the cage ----------
  var cage = await J("(function(){ var C = LG.Config.court; return { w: C.width, l: C.length }; })()");
  check(cage.w === 30 && cage.l === 50, 'the court is 30 x 50 in the real game ' + JSON.stringify(cage));
  // the goal meshes: four net panels on each goal, tied to the frame
  var nets = await J("(function(){ var r = LG.debug.arena; var out = []; r.traverse(function (o) { if (o.userData && o.userData.nets) out.push(Object.keys(o.userData.nets).length); }); return out; })()");
  check(nets.length === 2 && nets[0] === 4 && nets[1] === 4, 'both goals carry side, roof and back nets ' + JSON.stringify(nets));

  // freeze play: everyone parked, the ball where we want it
  await page.eval("(function(){ var m = LGMain.getMatch(); m.all.forEach(function (p) { p._ai = p.ai; p.ai = null; p.isHuman = false; p.want.x = p.want.z = 0; }); return true; })()");
  var GL = cage.l / 2;
  await page.cam([9, 4.2, -(GL - 9)], [0, 1.0, -(GL + 0.8)]);
  await page.wait(900);
  await page.shot('b8_goal_north');
  await page.cam([-6, 2.2, -(GL - 3.4)], [1.6, 0.9, -(GL + 1.2)]);
  await page.wait(700);
  await page.shot('b8_goal_side_net');
  await page.cam([0, 7, -(GL - 14)], [0, 1.2, -(GL)]);
  await page.wait(700);
  await page.shot('b8_end_fence');

  // ---------- goal detection through the real loop ----------
  function fire(label, x, y, z, vx, vy, vz, frames) {
    return J("(function(){ var m = LGMain.getMatch(); m.keeperSaveChance = function(){ return 0; }; m.updateKeepers = function(){};" +
      "var gk = m.away[3]; gk.x = 9; gk.z = -" + (GL - 2) + "; var goals = 0; var h = function(){ goals++; }; m.bus.on('goal', h);" +
      "var ripple = 0; var hr = function(){ ripple++; }; LG.eventBus.on('netHit', hr);" +
      "m.ball.reset(" + x + "," + z + "); m.ball.y = " + y + "; m.ball.vx = " + vx + "; m.ball.vy = " + vy + "; m.ball.vz = " + vz + "; m.ball.lastKicker = m.home[0]; m.ball._kickSeq++;" +
      "for (var i = 0; i < " + (frames || 90) + "; i++) { m.state = 'PLAY'; m.stateT = 5; m.update(1/30); }" +
      "m.bus.off && m.bus.off('goal', h); LG.eventBus.off && LG.eventBus.off('netHit', hr);" +
      "return { goals: goals, z: m.ball.z, x: m.ball.x, ripple: ripple }; })()");
  }
  var legit = await fire('legit', 0, 0.3, -(GL - 7), 0.3, 0.6, -22);
  check(legit.goals === 1 && legit.z < -(GL + 0.27), 'a shot into the net is one goal — and it stays in the net ' + JSON.stringify(legit));
  check(legit.ripple > 0, 'the net it hits ripples (netHit events: ' + legit.ripple + ')');
  await page.cam([5, 2.4, -(GL - 4)], [0, 0.9, -(GL + 1)]);
  await page.wait(250);
  await page.shot('b8_ball_in_net');
  var sideNet = await fire('side', 3.25, 0.3, -(GL - 5), 0.5, 0.3, -15);
  check(sideNet.goals === 0 && sideNet.z > -(GL), 'side netting from outside: no goal, ball stays on the pitch ' + JSON.stringify(sideNet));
  var overBar = await fire('bar', 0.4, 2.6, -(GL - 5), 0, 1.2, -18);
  check(overBar.goals === 0 && overBar.z > -(GL), 'over the bar: off the header panel, no goal ' + JSON.stringify(overBar));
  var postHit = await fire('post', 2.6, 0.3, -(GL - 6), 0, 0, -18);
  check(postHit.goals === 0, 'onto the post: no goal ' + JSON.stringify(postHit));

  // ---------- keeper possession + protection ----------
  var kp = await J("(function(){ var m = LGMain.getMatch(); m.state = 'PLAY'; var gk = m.away[3]; gk.ai = gk._ai; m.repositionGoalkeeper(gk);" +
    "m.all.forEach(function (q) { if (q.hasBall) m.release(q); }); gk.ai.poss = null; gk.ai.lastHadBall = false; m.ball.reset(0, -" + (GL - 1) + "); m.possess(m.ball, gk); var opp = m.home[0]; opp.x = gk.x + 0.6; opp.z = gk.z + 0.7; var seen = []; var minGap = 99; var tackles = 0;" +
    "for (var i = 0; i < 120 && gk.hasBall; i++) { var st = gk.ai.poss && gk.ai.poss.st; if (st && seen[seen.length-1] !== st) seen.push(st); opp.tackleCd = 0; m.tryTackle(opp, { accuracy: 2 }); if (!gk.hasBall && gk.ai.poss && gk.ai.poss.st !== 'gone') tackles++; if (i > 12) minGap = Math.min(minGap, opp.distTo(gk.x, gk.z)); m.update(1/30); }" +
    "return { seen: seen, held: gk.hasBall, minGap: minGap, tackles: tackles, ballY: m.ball.y, st: m.state, ai: !!gk.ai, poss: gk.ai && gk.ai.poss && gk.ai.poss.st, owner: m.ball.owner && m.ball.owner.name, gkname: gk.name }; })()");
  page.log('       ' + JSON.stringify(kp));
  check(kp.seen.join(',').indexOf('secure,decide,windup') === 0 && !kp.held, 'the ROGUE keeper secures, decides, then distributes ' + JSON.stringify(kp.seen));
  check(kp.tackles === 0 && kp.minGap > 2.1, 'an opponent leaning on him is eased out and cannot take it ' + JSON.stringify({ gap: kp.minGap, tackles: kp.tackles }));

  // keeper holding the ball in his hands (look)
  await page.eval("(function(){ var m = LGMain.getMatch(); var gk = m.away[3]; m.repositionGoalkeeper(gk); m.ball.reset(0, -" + (GL - 1) + "); m.possess(m.ball, gk); for (var i = 0; i < 8; i++) m.update(1/30); return true; })()");
  await page.cam([0, 2.4, -(GL - 6)], [0, 1.0, -(GL - 0.8)]);
  await page.wait(600);
  await page.shot('b8_keeper_holds');

  // ---------- cameras on the bigger court ----------
  await page.eval("(function(){ var m = LGMain.getMatch(); m.all.forEach(function (p) { if (p._ai) p.ai = p._ai; }); return true; })()");
  await page.free();
  await page.eval("LG.Settings.setCamera(2); LGMain.getMatch().camera && LGMain.getMatch().camera.reset(); true");
  await page.wait(1500);
  await page.shot('b8_cam_wide_portrait');
  var wide = await J("(function(){ var c = LGMain.getMatch().camera; var t = c.target(); var raw = c.cfg(); return { h: t.height, d: t.distance, zc: t.zClamp, rawD: raw.distance, rawZ: raw.zClamp }; })()");
  check(wide.d > wide.rawD * 1.05 && wide.zc > wide.rawZ * 1.1, 'the WIDE camera stands back and follows further for the bigger court ' + JSON.stringify(wide));

  page.log('BUILD8 ' + (fails ? 'FAIL' : 'PASS') + ' ' + (n - fails) + '/' + n);
  if (fails) process.exitCode = 1;
};
