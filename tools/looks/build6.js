// ============================================================
// tools/looks/build6.js — Build 6 check on the REAL game in headless
// Chrome:  node tools/look.js tools/looks/build6.js --out <dir>
// Court + conditions screen, fog/wind/crowd/street life, Penalty
// Shootout to the end, The Yard's three drills, Rumble orbs, the CPU's
// special moves and a keeper dive. Matches are stepped directly (the
// headless renderer is slow), using the game's own update.
// ============================================================
module.exports = async function (page) {
  var fails = 0, n = 0;
  function check(ok, what) { n++; if (!ok) fails++; page.log((ok ? 'ok   ' : 'FAIL ') + what); }
  function click(id) { return page.eval("document.getElementById('" + id + "').click(); true"); }
  function sim(sec) { return page.eval("(function(){ var m=LGMain.getMatch(); for (var i=0;i<" + Math.round(sec * 30) + ";i++){ if (LGMain.getState()!=='match') break; LG.Input.update(performance.now()/1000); m.update(1/30); } return true; })()"); }
  function J(expr) { return page.eval('JSON.stringify(' + expr + ')').then(JSON.parse); }
  async function go(mode) {
    await click('btn-play'); await page.wait(300);
    await page.eval("document.querySelector('#mode-list .mode-" + mode + "').click(); true");
    for (var id of ['btn-mode-go', 'btn-diff-go', 'btn-select-go']) { await click(id); await page.wait(400); }
    await page.wait(700); await click('btn-style-go'); await page.wait(400); await click('btn-court-go'); await page.wait(300); await click('btn-start-match');
    await page.until("LGMain.getState() === 'match'", 15000);
  }
  await page.until("LG.Athlete && LG.Athlete.ready && LG.Athlete.ready()", 30000);

  // ---- court + conditions, one screen ----
  await click('btn-play'); await page.wait(300);
  for (var id of ['btn-mode-go', 'btn-diff-go', 'btn-select-go']) { await click(id); await page.wait(400); }
  await page.wait(700); await click('btn-style-go'); await page.wait(500);
  var ui = await J("{ grid: document.querySelectorAll('#court-overlay .court-btn').length, cond: ['time-blackout','weather-fog','weather-wind','crowd-empty','life-off'].every(function(i){ return !!document.querySelector('#court-overlay #' + i); }) }");
  check(ui.grid > 5 && ui.cond, 'courts and conditions share one screen ' + JSON.stringify(ui));
  await click('weather-fog'); await click('time-dusk');
  var fog = await J("{ far: LGMain.getMatch ? (window.LG.debug && LG.debug.scene && LG.debug.scene.fog ? LG.debug.scene.fog.far : -1) : -1, w: LG.Settings.weather() }");
  check(fog.w === 'fog' && fog.far > 0 && fog.far < 70, 'FOG pulls the fog in (' + fog.far + ')');
  await click('weather-wind');
  check(await page.eval("LG.Weather.kind() === 'wind' && LG.Weather.windAccel().x > 0"), 'WIND blows (and pushes airborne balls)');
  await click('crowd-locals'); await click('life-off');
  var cr = await J("{ c: LG.Settings.crowd(), l: LG.Settings.life() }");
  check(cr.c === 'locals' && cr.l === 'off', 'CROWD and STREET LIFE levels are set');
  check(/LOCALS|locals|few locals/i.test(await page.eval("document.getElementById('court-effect').textContent")), 'WHAT CHANGES explains the picks');
  await page.shot('b6_court');
  await click('crowd-packed'); await click('life-full'); await click('weather-dry'); await click('time-day');
  for (var b of ['btn-court-back', 'btn-style-back', 'btn-back', 'btn-diff-back', 'btn-mode-back']) await click(b);
  await page.wait(300);

  // ---- penalty shootout to the end ----
  await go('penalty_shootout');
  check(await page.eval("LGMain.getMatch().ctrl && LGMain.getMatch().ctrl.kind === 'shootout'"), 'PENALTY SHOOTOUT starts its controller');
  await sim(1.2);
  check(await page.eval("LGMain.getMatch().ctrl.phase === 'aim' && !document.getElementById('so-hud').classList.contains('hidden')"), 'your first kick: aim phase with the shootout HUD');
  await page.shot('b6_shootout');
  for (var k = 0; k < 150; k++) {
    var s = await J("{ p: LGMain.getMatch().ctrl.phase, st: LGMain.getState() }");
    if (s.st !== 'match') break;
    if (s.p === 'aim') { await page.eval("var c=LGMain.getMatch().ctrl; c.shoot(LGMain.getMatch(), 0.8, 2.0, 1.4); true"); await sim(1.5); }
    else await sim(1.0);
  }
  await page.until("LGMain.getState() === 'result'", 20000).catch(function () {});
  var so = await J("{ st: LGMain.getState(), t: document.getElementById('result-title').textContent, sum: document.querySelectorAll('#res-summary .rs-line').length }");
  check(so.st === 'result' && /SHOOTOUT/.test(so.t) && so.sum === 2, 'the shootout reaches a result with both kick records ' + JSON.stringify(so));
  await click('btn-result-menu'); await page.wait(300);

  // ---- the yard: three drills ----
  await go('the_yard');
  await sim(0.5);
  await page.eval(`(function(){ var m=LGMain.getMatch(), c=m.ctrl, b=m.ball, t=c.target, hl=LG.Config.court.length/2;
    m.all.forEach(function(p){p.hasBall=false}); b.owner=null; b.x=t.x; b.z=-hl+2; b.y=t.y; b.vx=0; b.vy=0; b.vz=-20; b.lastKicker=c.star; })(); true`);
  await sim(0.5);
  check(await page.eval("LGMain.getMatch().ctrl.points === 1"), 'TARGET PRACTICE: hitting the lit target scores');
  await sim(41);
  check(await page.eval("LGMain.getMatch().ctrl.d === 1 && !!LGMain.getMatch().ctrl.gate"), 'SPEED GATES follows with cones');
  await sim(41);
  check(await page.eval("LGMain.getMatch().ctrl.d === 2 && !!LGMain.getMatch().ctrl.lit"), 'PASS & MOVE follows with a lit mate');
  await sim(42);
  await page.until("LGMain.getState() === 'result'", 20000).catch(function () {});
  check(/TRAINING/.test(await page.eval("document.getElementById('result-title').textContent")) && (await page.eval("document.querySelectorAll('#res-summary .rs-line').length")) === 3, 'THE YARD lists all three drills at the end');
  check(await page.eval("!!LG.ModeCtrl.yardBest().targets"), 'drill bests are saved on the device');
  await click('btn-result-menu'); await page.wait(300);

  // ---- rumble ----
  await go('rumble');
  await page.eval("LGMain.getMatch().state = 'PLAY'; true");
  await sim(0.5);
  check(await page.eval("LGMain.getMatch().all.every(function(p){ return !p.meterFull; })"), 'RUMBLE: nobody starts with a special');
  await page.eval("LGMain.getMatch().ctrl.spawnT = 0; true"); await sim(0.1);
  check(await page.eval("LGMain.getMatch().ctrl.orbs.length >= 1"), 'orbs drop onto the court');
  await page.eval("(function(){ var m=LGMain.getMatch(), o=m.ctrl.orbs[0]; m.active.x=o.x; m.active.z=o.z; })(); true"); await sim(0.1);
  check(await page.eval("!!LGMain.getMatch().active._rumbleAbility && LGMain.getMatch().active.meterFull"), 'running over an orb grants its ability');
  await page.shot('b6_rumble');
  await click('pause-btn'); await page.wait(300); await click('btn-quit-menu'); await page.wait(300);

  // ---- CPU specials + keeper dive in a normal match ----
  await page.eval("LG.Modes.select('quick_match'); true");
  await click('btn-quick-play');
  await page.until("LGMain.getState() === 'match'", 15000);
  await page.eval("window.__cpuSp = 0; LG.eventBus.on('abilityActivated', function (p) { if (p.team === 1) window.__cpuSp++; }); LGMain.getMatch().state = 'PLAY'; true");
  for (var r = 0; r < 6; r++) { await page.eval("LGMain.getMatch().away.forEach(function(p){ if(!p.isGoalkeeper) p.fillMeter(1); }); true"); await sim(10); }
  check((await page.eval("window.__cpuSp")) >= 1, 'the CPU fires its special moves (' + (await page.eval("window.__cpuSp")) + ')');
  await page.eval("(function(){ var m=LGMain.getMatch(); var gk=m.away.filter(function(p){return p.isGoalkeeper})[0]; window.__gk=gk; LG.KeeperMotion.start(gk,'dive',{side:1,reach:0.8}); })(); true");
  await sim(0.3);
  var dv = await J("{ k: LG.KeeperMotion.state(__gk), roll: __gk.model.group.rotation.z }");
  check(dv.k && dv.k.kind === 'dive' && Math.abs(dv.roll) > 0.5, 'a keeper dive lays the body out sideways (roll ' + dv.roll.toFixed(2) + ')');
  await sim(1.5);
  check(await page.eval("LG.KeeperMotion.state(__gk) === null && Math.abs(__gk.model.group.rotation.z) < 0.01"), '…and the keeper gets back up');
  await click('pause-btn'); await page.wait(300); await click('btn-quit-menu');

  page.log('BUILD6 ' + (fails ? 'FAIL' : 'PASS') + ' ' + (n - fails) + '/' + n);
  if (fails) throw new Error(fails + ' build-6 checks failed');
};
