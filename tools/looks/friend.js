// ============================================================
// tools/looks/friend.js — FRIEND MATCH check (Build 6). Two tabs of the
// REAL game in one headless Chrome, linked by the 'bc' transport (same
// code path as online play except the PeerJS broker):
//   node tools/look.js tools/looks/friend.js --query net=bc --out <dir>
// Tab A hosts and gets a code; tab B types it and joins; both start the
// same match; B's stick moves B's player on A's authoritative match; A's
// goal shows up on B; full time reaches both with mirrored results.
// ============================================================
module.exports = async function (A) {
  var fails = 0, n = 0;
  function check(ok, what) { n++; if (!ok) fails++; A.log((ok ? 'ok   ' : 'FAIL ') + what); }
  function click(p, id) { return p.eval("document.getElementById('" + id + "').click(); true"); }

  await A.until("LG.Athlete && LG.Athlete.ready && LG.Athlete.ready()", 30000);
  var B = await A.second('net=bc');
  await B.until("LG.Athlete && LG.Athlete.ready && LG.Athlete.ready()", 30000);
  // different stars on each side
  await B.eval("LGMain.startMatch && true");

  await click(A, 'btn-friend'); await A.wait(300);
  check(await A.eval("!document.getElementById('friend-overlay').classList.contains('hidden')"), 'FRIEND MATCH opens from the home bar');
  await click(A, 'btn-friend-host'); await A.wait(400);
  var code = await A.eval("LG.Net.code()");
  check(/^[A-Z2-9]{6}$/.test(code), 'the host gets a 6-character code (' + code + ')');
  check(await A.eval("document.querySelectorAll('#friend-code span').length === 6"), 'the code is shown on screen');
  await A.shot('f01_host_code');

  await click(B, 'btn-friend'); await B.wait(300);
  await B.eval("document.getElementById('friend-input').value = '" + code.toLowerCase() + "'; document.getElementById('friend-input').dispatchEvent(new Event('input')); true");
  check((await B.eval("document.getElementById('friend-input').value")) === code, 'the join box cleans the code (lower case -> upper)');
  await click(B, 'btn-friend-join');
  await A.until("LGMain.getState() === 'match'", 20000);
  await B.until("LGMain.getState() === 'match'", 20000);
  check(true, 'both phones start the match');
  var roles = JSON.parse(await A.eval("JSON.stringify([LGMain.getMatch().opts.online, LGMain.getMatch().ctrl.kind, LGMain.getMatch().away[0].isHuman, !!LGMain.getMatch().away[0].inputSrc])"));
  var rolesB = JSON.parse(await B.eval("JSON.stringify([LGMain.getMatch().opts.online, LGMain.getMatch().ctrl.kind, LGMain.getMatch().active === LGMain.getMatch().away[0]])"));
  check(roles[0] === 'host' && roles[1] === 'online-host' && roles[2] && roles[3], 'A hosts; the friend\'s star is human-driven by remote input ' + JSON.stringify(roles));
  check(rolesB[0] === 'guest' && rolesB[1] === 'online-guest' && rolesB[2], 'B is the guest and controls the away star ' + JSON.stringify(rolesB));
  var ids = JSON.parse(await A.eval("JSON.stringify(LGMain.getMatch().all.map(function(p){return p.id}))"));
  var idsB = JSON.parse(await B.eval("JSON.stringify(LGMain.getMatch().all.map(function(p){return p.id}))"));
  check(ids.join() === idsB.join(), 'both phones built the same two squads');

  // let A reach PLAY; snapshots flow to B
  // (two software-rendered games share one CPU here: frames are slow, so
  // waits are long; on phones this is instant)
  await A.until("LGMain.getMatch().state === 'PLAY'", 90000);
  await B.until("LG.Net.syncInfo().stats.snaps > 5", 60000);
  check(true, 'B receives the host\'s snapshots');

  // B pushes its stick: the friend's player moves on A
  var before = JSON.parse(await A.eval("JSON.stringify([LGMain.getMatch().away[0].x, LGMain.getMatch().away[0].z])"));
  await B.eval("LG.Input.moveVec = function () { return { x: 1, y: 0 }; }; true");
  await A.until("Math.hypot(LGMain.getMatch().away[0].x - (" + before[0] + "), LGMain.getMatch().away[0].z - (" + before[1] + ")) > 1.2", 60000).catch(function () {});
  var after = JSON.parse(await A.eval("JSON.stringify([LGMain.getMatch().away[0].x, LGMain.getMatch().away[0].z])"));
  var moved = Math.hypot(after[0] - before[0], after[1] - before[1]);
  check(moved > 1.0, "B's stick moves B's player on the host (" + moved.toFixed(2) + ' m)');
  // B shows the same place for that player (within the 100 ms delay)
  await B.eval("LG.Input.moveVec = function () { return { x: 0, y: 0 }; }; true");
  await A.wait(6000);
  var posA = JSON.parse(await A.eval("JSON.stringify([LGMain.getMatch().away[0].x, LGMain.getMatch().away[0].z])"));
  var posB = JSON.parse(await B.eval("JSON.stringify([LGMain.getMatch().away[0].x, LGMain.getMatch().away[0].z])"));
  check(Math.hypot(posA[0] - posB[0], posA[1] - posB[1]) < 2.5, 'B draws the player where the host has it');
  await B.eval("LG.Input.moveVec = function () { return { x: 0, y: 0 }; }; true");
  var si = JSON.parse(await B.eval("JSON.stringify(LG.Net.syncInfo())"));
  check(si.delay >= 0.08 && si.delay <= 0.4, 'B renders behind a measured buffer (' + Math.round(si.delay * 1000) + ' ms, jitter ' + Math.round(si.jitter * 1000) + ' ms)');
  check(si.stats.snapCorr <= 2, 'B\'s own star needed at most a couple of hard corrections (' + si.stats.snapCorr + ')');
  await B.shot('f02_guest_view');
  await A.shot('f03_host_view');

  // a goal on A shows up on B
  await A.eval(`(function(){ var m = LGMain.getMatch(), hl = LG.Config.court.length / 2;
    m.all.forEach(function (p) { p.hasBall = false; }); m.ball.owner = null;
    m.ball.x = 0; m.ball.z = -hl - 0.4; m.ball.y = 0.3; m.ball.vx = 0; m.ball.vy = 0; m.ball.vz = -2; m.ball.lastKicker = m.home[0]; })(); true`);
  await A.until("LGMain.getMatch().score[0] === 1", 60000).catch(function () {});
  await B.until("LGMain.getMatch().score[0] === 1", 60000).catch(function () {});
  var sc = JSON.parse(await B.eval("JSON.stringify(LGMain.getMatch().score)"));
  check(sc[0] === 1, 'the host\'s goal reaches the friend (' + sc.join('-') + ')');
  check((await B.eval("document.querySelector('#scoreboard .home .score') ? document.querySelector('#scoreboard .home .score').textContent : ''")) === '1', "B's scoreboard shows it");

  // full time on A ends it on both, mirrored
  await A.eval("LGMain.getMatch().endMatch(); true");
  await A.until("LGMain.getState() === 'result'", 60000);
  await B.until("LGMain.getState() === 'result'", 60000);
  // the results board fills in a beat after full time
  await A.until("!document.getElementById('result-overlay').classList.contains('hidden')", 30000);
  await B.until("!document.getElementById('result-overlay').classList.contains('hidden')", 30000);
  var rA = await A.eval("document.getElementById('result-title').textContent");
  var rB = await B.eval("document.getElementById('result-title').textContent");
  check(/BEAT/.test(rA) && /FRIEND WON/.test(rB), 'full time on both: ' + rA + ' / ' + rB);
  check(await B.eval("document.getElementById('btn-rematch').classList.contains('hidden')"), 'no REMATCH button online');
  await B.shot('f04_guest_result');
  await click(B, 'btn-result-menu'); await click(A, 'btn-result-menu');
  await A.wait(500);
  var ra = await A.eval("String(LG.Net.role()) + '/' + LGMain.getState()"), rb = await B.eval("String(LG.Net.role()) + '/' + LGMain.getState()");
  check(/^null\/menu$/.test(ra) && /^null\/menu$/.test(rb), 'MAIN MENU closes the link on both (' + ra + ', ' + rb + ')');

  A.log('FRIEND ' + (fails ? 'FAIL' : 'PASS') + ' ' + (n - fails) + '/' + n);
  if (fails) throw new Error(fails + ' friend-match checks failed');
};
