// ============================================================
// tools/netprobe.js — FRIEND MATCH sync probe (Build 7). Runs the REAL
// js/net.js guest code in Node against a scripted host: players run
// curves at football speeds, snapshots go out at the real 20 Hz, and the
// link is made bad on purpose (latency, jitter, packet loss, a 0.5 s
// stall). The guest renders at 60 fps on a fake clock. Measured:
//   * teleports  — a drawn step far bigger than the real speed allows
//   * freezes    — a drawn body standing still while really moving
//   * error      — distance between drawn and true position (delayed)
//   * prediction — my own star reacts on the FIRST frame of input, and
//                  reconciliation pulls it onto the host's track
// Run: node tools/netprobe.js
// ============================================================
'use strict';
var PASS = 0, FAIL = 0;
function check(ok, what, extra) { if (ok) PASS++; else FAIL++; console.log((ok ? '  ok   ' : '  FAIL ') + what + (extra !== undefined ? '  ->  ' + extra : '')); }

var T = 0;                       // fake clock, seconds
global.performance = { now: function () { return T * 1000; } };
global.window = global;
global.document = { getElementById: function () { return null; } };
global.location = { search: '' };
global.setInterval = function () {};
global.LG = { Abilities: {}, HUD: { toast: function () {} } };
require('fs');
eval(require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'net.js'), 'utf8'));
var N = LG.Net;

// simple rng
var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

function body(i) {
  return { i: i, x: 0, z: 0, vx: 0, vz: 0, facing: 0, y: 0, want: { x: 0, z: 0 }, meter: 0, stamina: 1, kickAnim: 0, tackleAnim: 0,
    update: function () {}, model: null };
}
// truth: 8 players on curving runs at up to ~7 m/s
function truth(i, t) {
  var r = 6 + i, w = 0.55 + i * 0.07;
  return { x: Math.sin(t * w + i) * r * 0.8, z: Math.cos(t * w * 0.9 + i) * r };
}
function vel(i, t) { var a = truth(i, t), b = truth(i, t + 0.01); return { x: (b.x - a.x) / 0.01, z: (b.z - a.z) / 0.01 }; }

function run(name, link) {
  N._reset();
  var guest = [];
  for (var i = 0; i < 8; i++) guest.push(body(i));
  var m = { all: guest, away: [guest[4]], home: guest.slice(0, 4), state: 'PLAY', score: [0, 0], clock: 120,
    bus: { emit: function () {} }, ball: { x: 0, y: 0.27, z: 0, r: 0.27, owner: null, mesh: null },
    updatePlayers: function () {}, screenToWorldMove: function (v) { return { x: v.x, z: -v.y }; }, placeBallOnCarrier: function () {} };
  LG.Match = m;
  LG.Input = { pressed: function () { return false; }, down: function () { return false; }, moveVec: function () { return { x: 0, y: 0 }; } };
  var g = new N.GuestCtrl(m);
  g.start(m);
  m.ctrl = g;
  // my own star (index 4) is predicted locally — keep it out of the remote measurements
  var inflight = [], hostT = 0, seq = 0, sendAcc = 0;
  var stats = { tele: 0, freeze: 0, maxErr: 0, sumErr: 0, n: 0, maxStep: 0 };
  var prev = null;
  for (var f = 0; f < 60 * 12; f++) {
    var dt = 1 / 60;
    T += dt; hostT += dt; sendAcc += dt;
    if (sendAcc >= 1 / 20) {
      sendAcc -= 1 / 20; seq++;
      var stalled = link.stall && hostT > link.stall[0] && hostT < link.stall[1];
      var P = [];
      for (var k = 0; k < 8; k++) { var p = truth(k, hostT), v = vel(k, hostT); P.push([p.x, p.z, v.x, v.z, Math.atan2(v.x, v.z), 0, 0, 0, 1, 0, 0, 0, 0]); }
      var snap = { t: 's', k: seq, ts: hostT, a: 0, f: 1, c: 100, sc: [0, 0], st: 'PLAY', b: [0, 0.27, 0, 0, 0, 0, -1], p: P };
      if (!stalled && rnd() >= link.loss) inflight.push({ at: T + link.lag + rnd() * link.jitter, d: snap });
    }
    for (var q = inflight.length - 1; q >= 0; q--) if (inflight[q].at <= T) { N._ingest(inflight[q].d); inflight.splice(q, 1); }
    g.update(m, dt);
    if (f > 60) {
      for (var j = 0; j < 8; j++) {
        if (j === 4) continue;
        var pl = guest[j];
        if (prev) {
          var sx = pl.x - prev[j].x, sz = pl.z - prev[j].z, step = Math.sqrt(sx * sx + sz * sz);
          var vv = vel(j, hostT), sp = Math.sqrt(vv.x * vv.x + vv.z * vv.z);
          stats.maxStep = Math.max(stats.maxStep, step / Math.max(0.5, sp * dt));
          if (step > sp * dt * 2.5 + 0.05) stats.tele++;
          var inStall = link.stall && hostT > link.stall[0] && hostT < link.stall[1] + 0.35;
          if (step < 0.0005 && sp > 2 && !inStall) stats.freeze++;
          if (inStall && step < 0.0005 && sp > 2) stats.stallFreeze = (stats.stallFreeze || 0) + 1;
          // compare with the truth at the time being drawn
          var tr = truth(j, hostT - g.delay() - 0.05), e = Math.hypot(pl.x - tr.x, pl.z - tr.z);
          stats.maxErr = Math.max(stats.maxErr, e); stats.sumErr += e; stats.n++;
        }
      }
      prev = guest.map(function (p) { return { x: p.x, z: p.z }; });
    }
  }
  stats.avgErr = stats.sumErr / Math.max(1, stats.n);
  console.log('  · ' + name + ': teleport frames ' + stats.tele + ', freeze frames ' + stats.freeze + ', worst step ' + stats.maxStep.toFixed(2) + 'x speed, avg error ' + stats.avgErr.toFixed(2) + ' m, delay ' + (g.delay() * 1000).toFixed(0) + ' ms, extrapolated frames ' + g.stats.extrap);
  return stats;
}

console.log('== remote players move continuously ==');
var good = run('good link (40 ms)', { lag: 0.04, jitter: 0.01, loss: 0 });
check(good.tele === 0 && good.freeze === 0, 'good link: no teleports, no freezes');
var bad = run('bad link (80 ms ±80 ms jitter, 5% loss)', { lag: 0.08, jitter: 0.08, loss: 0.05 });
check(bad.tele === 0, 'jittery, lossy link: no teleports', bad.tele);
check(bad.freeze === 0, 'jittery, lossy link: no freeze frames', bad.freeze);
check(bad.avgErr < 0.6, 'jittery, lossy link: drawn bodies stay on the true path (avg ' + bad.avgErr.toFixed(2) + ' m)');
var stall = run('a 0.5 s stall mid-match', { lag: 0.06, jitter: 0.03, loss: 0, stall: [5, 5.5] });
check(stall.tele === 0, 'after a 0.5 s stall the bodies glide back (no teleport)', stall.tele);
check(stall.freeze === 0, 'outside the stall nobody freezes', stall.freeze);
check((stall.stallFreeze || 0) < 20, 'during the stall they keep moving on their last velocity, then ease to a stop (still frames: ' + (stall.stallFreeze || 0) + ')');

console.log('== my own star is predicted ==');
(function () {
  N._reset();
  var me = { x: 0, z: 0, vx: 0, vz: 0, facing: 0, y: 0, want: { x: 0, z: 0, sprint: false }, maxSpeed: 6,
    update: function (dt) { this.vx = this.want.x * this.maxSpeed; this.vz = this.want.z * this.maxSpeed; this.x += this.vx * dt; this.z += this.vz * dt; } };
  var others = []; for (var i = 0; i < 7; i++) others.push(body(i));
  var all = others.slice(0, 4).concat([me]).concat(others.slice(4));
  var m = { all: all, away: [me], home: all.slice(0, 4), state: 'PLAY', score: [0, 0], clock: 100, bus: { emit: function () {} },
    ball: { x: 0, y: 0.27, z: 0, r: 0.27, owner: null }, updatePlayers: function () {}, screenToWorldMove: function (v) { return { x: v.x, z: -v.y }; } };
  LG.Match = m;
  var sent = [];
  var origSend = N.send;
  var stick = { x: 0, y: 0 };
  LG.Input = { pressed: function () { return false; }, down: function () { return false; }, moveVec: function () { return stick; } };
  var g = new N.GuestCtrl(m); g.start(m); m.ctrl = g;
  m.state = 'PLAY';
  stick = { x: 1, y: 0 };
  g.update(m, 1 / 60);
  check(me.x > 0, 'the first frame of stick input already moves my star (no network wait)', me.x.toFixed(3));
  // the host saw my input 0.1 s late and is 0.4 m behind where I predicted
  for (var f = 0; f < 30; f++) { T += 1 / 60; g.update(m, 1 / 60); }
  var predicted = me.x;
  var P = all.map(function (p) { return [p === me ? g.hist[0].x - 0.4 : 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]; });
  N._ingest({ t: 's', k: 1, ts: 1, a: g.hist[0].q, f: 1, c: 100, sc: [0, 0], st: 'PLAY', b: [0, 0.27, 0, 0, 0, 0, -1], p: P });
  var jumpNext;
  T += 1 / 60; var before = me.x; g.update(m, 1 / 60); jumpNext = me.x - before;
  check(jumpNext > -0.1, 'a 0.4 m disagreement is NOT snapped in one frame', jumpNext.toFixed(3));
  for (var f2 = 0; f2 < 40; f2++) { T += 1 / 60; g.update(m, 1 / 60); }
  var expect = predicted - 0.4 + 6 * (41 / 60);
  check(Math.abs(me.x - expect) < 0.08, 'reconciliation bleeds the error out within ~0.7 s', (me.x - expect).toFixed(3));
})();

console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
