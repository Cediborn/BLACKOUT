// ============================================================
// tools/skillprobe.js — Build 7 SKILL MOVES + ball-play probe.
// Loads the real scripts (same stubs as feelprobe) and measures each
// move on a live match: the stick picks the right move, the body really
// does the move (turns 180 / spins 360 / side-steps), the ball stays on
// the feet or goes over a defender, cooldowns hold, no move is a free
// pass (a defender still wins balls), finesse shots bend, first-time
// strikes and volleys fire from an arriving ball, shielding is side-on.
// Run: node tools/skillprobe.js
// ============================================================
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var PASS = 0, FAIL = 0;

function check(cond, label, detail) { return assert(cond, label, detail); }
function assert(cond, label, detail) {
  if (cond) { PASS++; console.log('  ok   ' + label); }
  else { FAIL++; console.log('  FAIL ' + label + (detail !== undefined ? '  ->  ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
function info(t) { console.log('  ·    ' + t); }

// ---------------- deterministic RNG ----------------
var _seed = parseInt(process.env.SEED || '1234567', 10);
Math.random = function () {
  _seed = (_seed * 1664525 + 1013904223) % 4294967296;
  return _seed / 4294967296;
};

// ---------------- DOM / THREE stubs ----------------
global.window = global;
var keyHandlers = {};
global.addEventListener = function (ev, fn) { (keyHandlers[ev] = keyHandlers[ev] || []).push(fn); };
global.removeEventListener = function () {};

var ctx2d = new Proxy({}, {
  get: function (t, p) {
    if (p === 'createRadialGradient' || p === 'createLinearGradient' || p === 'createPattern') {
      return function () { return { addColorStop: function () {} }; };
    }
    if (p === 'getImageData') return function () { return { data: [] }; };
    return function () {};
  },
  set: function () { return true; }
});

function vec3() {
  var v = { x: 0, y: 0, z: 0 };
  v.set = function (x, y, z) { v.x = x; v.y = y; v.z = z; return v; };
  v.copy = function (o) { v.x = o.x; v.y = o.y; v.z = o.z; return v; };
  v.setScalar = function (s) { v.x = v.y = v.z = s; return v; };
  v.project = function () { return v; };
  v.normalize = function () { return v; };
  v.add = v.sub = v.multiplyScalar = function () { return v; };
  return v;
}

function fakeNode() {
  var n = {
    position: vec3(), rotation: vec3(), scale: vec3(),
    userData: {}, children: [], isMesh: false, visible: true,
    castShadow: false, receiveShadow: false, material: null, geometry: null,
    add: function (c) { n.children.push(c); return n; },
    remove: function () { return n; },
    traverse: function (cb) { cb(n); n.children.forEach(function (c) { if (c.traverse) c.traverse(cb); }); return n; },
    lookAt: function () {}, updateProjectionMatrix: function () {},
    color: { setHex: function () {}, getHexString: function () { return 'ffffff'; }, set: function () {}, getHex: function () { return 0; } },
    copy: function () { return n; }, clone: function () { return fakeNode(); },
    setFromPoints: function () { return n; }, setAttribute: function () { return n; },
    dispose: function () {}
  };
  return new Proxy(n, {
    get: function (o, p) {
      if (p in o) return o[p];
      var fn = function () { return o; };
      o[p] = fn;
      return fn;
    },
    set: function (o, p, val) { o[p] = val; return true; }
  });
}

var threeCache = {};
global.THREE = new Proxy({}, {
  get: function (t, prop) {
    if (prop in threeCache) return threeCache[prop];
    if (prop === 'DoubleSide' || prop === 'AdditiveBlending' || prop === 'FrontSide') return 2;
    if (prop === 'RepeatWrapping') return 1000;
    if (prop === 'sRGBEncoding') return 3001;
    if (prop === 'PCFSoftShadowMap') return 2;
    var Cls = function () {
      var node = fakeNode();
      if (arguments.length >= 2 && typeof arguments[1] === 'object') node.material = arguments[1];
      return node;
    };
    threeCache[prop] = Cls;
    return Cls;
  }
});

var elements = {};
function el(extra) {
  var e = {
    style: {}, dataset: {}, innerHTML: '', textContent: '', children: [],
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    _h: {},
    addEventListener: function (ev, fn) { (e._h[ev] = e._h[ev] || []).push(fn); },
    removeEventListener: function () {},
    appendChild: function () {}, removeChild: function () {}, remove: function () {},
    querySelector: function () { return el(); }, querySelectorAll: function () { return []; },
    getBoundingClientRect: function () {
      var box = e._box || { left: 0, top: 0, width: 190, height: 190 };
      box.right = box.left + box.width; box.bottom = box.top + box.height;
      return box;
    },
    setPointerCapture: function () {}, releasePointerCapture: function () {},
    fire: function (type, ev) {
      ev = ev || {};
      ev.preventDefault = ev.preventDefault || function () {};
      (e._h[type] || []).forEach(function (f) { f(ev); });
    }
  };
  if (extra) for (var k in extra) e[k] = extra[k];
  return e;
}

global.document = {
  createElement: function (tag) {
    if (tag === 'canvas') return { width: 2, height: 2, getContext: function () { return ctx2d; }, style: {} };
    return el();
  },
  getElementById: function (id) { return elements[id] || null; },
  querySelectorAll: function () { return []; },
  body: el(),
  documentElement: el()
};

['pass', 'shoot', 'tackle', 'sprint', 'switch'].forEach(function (n) { elements['btn-' + n] = el(); });
elements['special-btn'] = el();
elements['joystick-zone'] = el({ _box: { left: 0, top: 0, width: 190, height: 190 } });
elements['joy-knob'] = el();

function key(type, code) {
  var ev = { code: code, preventDefault: function () {}, isTyping: false };
  (keyHandlers[type] || []).forEach(function (f) { f(ev); });
}

// ---------------- load the real game code ----------------
function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}
['js/config.js', 'js/difficulty.js', 'js/settings.js', 'js/util.js', 'js/audio.js', 'js/challenges.js', 'js/modes.js', 'js/tournament.js', 'js/models.js', 'js/rig.js', 'js/ball.js',
  'js/player.js', 'js/skills.js', 'js/abilities.js', 'js/ai.js', 'js/keeper.js', 'js/match.js',
  'js/input.js'].forEach(load);

if (!window.LG || !window.LG.MatchManager) { console.log('SKILLPROBE FAIL scripts did not load'); process.exit(1); }
var LG = window.LG;

var pfx = { dust: function () {}, trail: function () {}, burst: function () {}, ring: function () {},
  confetti: function () {}, speedLines: function () {}, update: function () {}, clear: function () {}, init: function () {} };
LG.Particles = pfx;
LG.Progression = {
  addCoins: function () {}, coins: function () { return 0; },
  isUnlocked: function () { return true; }, costOf: function () { return 0; }, unlock: function () { return true; },
  finalizeMatch: function (r) { if (r && !r.finalized) { r.finalized = true; r.coins = 60; } return r; },
  career: function () { return { matches: 0 }; }, history: function () { return []; },
  winRate: function () { return 0; }, rewardFor: function () { return 0; }, reset: function () {},
  reload: function () {}, best: function () { return { goals: 0, wins: 0, streak: 0 }; },
  activeChallenges: function () { return []; }, challengeCompletions: function () { return {}; },
  ensureActiveChallenges: function () {}
};
LG.HUD = { toast: function () {}, banner: function () {}, reset: function () {} };

LG.Input.init();
LG.Settings.setView('portrait');


var DT = 1 / 60;
function newMatch(id) { return new LG.MatchManager({ playerId: id || 'blaze', homeName: 'YOU', awayName: 'ROGUE' }); }
function place(p, x, z, f) { p.x = x; p.z = z; p.vx = 0; p.vz = 0; if (f !== undefined) p.facing = f; p.model.group.position.set(x, 0, z); }
function giveBall(m, p) { m.all.forEach(function (o) { o.hasBall = false; }); p.hasBall = true; m.ball.owner = p; m.possessionTeam = p.team;
  m.ball.x = p.x + Math.sin(p.facing) * 0.72; m.ball.z = p.z + Math.cos(p.facing) * 0.72; m.ball.y = m.ball.r; }
function setup() {
  var m = newMatch(); m.start();
  var p = m.active;
  m.all.forEach(function (o) { o.ai = null; o.isHuman = false; if (o !== p) place(o, 60, 60); });
  m.state = 'PLAY';
  place(p, 0, 0, Math.PI); p.stamina = 1; p._skillCd = 0;
  giveBall(m, p);
  return { m: m, p: p };
}
function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
function run(m, p, secs, wx, wz) {
  for (var t = 0; t < secs; t += DT) { p.want.x = wx || 0; p.want.z = wz || 0; p.update(DT); if (!m.ball.owner) m.ball.step(DT, null); }
}
var S = LG.Skills;

section('picking the move from the stick');
(function () {
  var p = { facing: 0 };
  check(S.choose(p, { x: 0, z: 0 }, false).id === 1, 'no stick = BODY FEINT');
  check(S.choose(p, { x: 0, z: 1 }, false).id === 1, 'stick forward = BODY FEINT');
  check(S.choose(p, { x: 0, z: -1 }, false).id === 2, 'stick back = DRAG BACK');
  check(S.choose(p, { x: 1, z: 0 }, false).id === 3 && S.choose(p, { x: -1, z: 0 }, false).id === 3, 'stick left/right = ROULETTE');
  check(S.choose(p, { x: 0, z: 1 }, true).id === 4, 'stick forward + SPRINT = RAINBOW FLICK');
  check(S.choose({ facing: Math.PI / 2 }, { x: -1, z: 0 }, false).id === 2, 'relative to the BODY, not the screen');
})();

section('each move really moves the body');
(function () {
  var A = setup(), m = A.m, p = A.p;
  var f0 = p.facing;
  check(S.start(m, p, { x: 0, z: 1 }, false), 'drag back starts with the ball');      // facing PI -> stick +z is back
  check(p._skill.id === 2, 'it is a drag back', p._skill && p._skill.id);
  check(!S.start(m, p, { x: 0, z: 0 }, false), 'a second move cannot start mid-move');
  run(m, p, 0.6);
  var turned = Math.abs(wrap(p.facing - f0));
  check(turned > 2.6, 'DRAG BACK turns the body round (' + (turned * 57.3).toFixed(0) + ' deg)');
  check(p.hasBall && m.ball.owner === p, 'and keeps the ball');
  var bdx = m.ball.x - p.x, bdz = m.ball.z - p.z;
  check(bdx * Math.sin(p.facing) + bdz * Math.cos(p.facing) > 0.3, 'the ball ends up in front of the new direction');
  check(p._skillCd > 0 && !S.start(m, p, { x: 0, z: 0 }, false), 'cooldown: no instant repeat');

  A = setup(); m = A.m; p = A.p;
  var spun = 0, last = p.facing, x0 = p.x;
  S.start(m, p, { x: 1, z: 0 }, false);
  check(p._skill.id === 3, 'stick across = roulette');
  for (var t = 0; t < 0.62; t += DT) { p.update(DT); spun += wrap(p.facing - last); last = p.facing; }
  check(Math.abs(spun) > 5.6, 'ROULETTE spins the full 360 (' + (Math.abs(spun) * 57.3).toFixed(0) + ' deg)');
  check(Math.abs(p.x - x0) > 0.6, 'while carrying the ball across (' + Math.abs(p.x - x0).toFixed(2) + ' m)');
  check(p.hasBall, 'ball kept through the spin');

  A = setup(); m = A.m; p = A.p;
  p.vx = 0; p.vz = -5;
  var xs = p.x;
  S.start(m, p, { x: 0, z: 0 }, false);
  check(p._skill.id === 1, 'no stick = feint');
  run(m, p, 0.46, 0, -1);
  check(Math.abs(p.x - xs) > 0.35, 'BODY FEINT shifts the line of the run (' + Math.abs(p.x - xs).toFixed(2) + ' m)');
  check(p.hasBall, 'ball kept on the feint');
})();

section('rainbow flick goes over a defender, a mistimed one does not');
(function () {
  var A = setup(), m = A.m, p = A.p;
  var d = m.away.filter(function (o) { return !o.isGoalkeeper; })[0];
  place(d, 0, -2.4);
  p.vz = -6; p.sprinting = true;
  S.start(m, p, { x: 0, z: -1 }, true);
  check(p._skill.id === 4, 'stick forward + sprint = rainbow');
  var maxY = 0, overD = false;
  for (var t = 0; t < 1.4; t += DT) {
    p.want.x = 0; p.want.z = -1; p.update(DT);
    if (!m.ball.owner) m.ball.step(DT, null);
    maxY = Math.max(maxY, m.ball.y);
    if (Math.abs(m.ball.z - d.z) < 0.5 && m.ball.y > 1.55) overD = true;
    m.resolvePossession();
  }
  check(maxY > 1.8, 'the ball goes up and over (peak ' + maxY.toFixed(2) + ' m)');
  check(overD, 'above head height as it passes the defender');
  check(m.ball.lastKicker === p, 'the flicker is the last touch');

  A = setup(); m = A.m; p = A.p;
  d = m.away.filter(function (o) { return !o.isGoalkeeper; })[0];
  place(d, 0, -0.9);
  p.vz = -4;
  S.start(m, p, { x: 0, z: -1 }, true);
  maxY = 0;
  for (t = 0; t < 0.8; t += DT) { p.update(DT); if (!m.ball.owner) m.ball.step(DT, null); maxY = Math.max(maxY, m.ball.y); }
  check(maxY < 1.2, 'flicked straight into a tight marker it pops off him (peak ' + maxY.toFixed(2) + ' m)');
})();

section('no move is a free pass');
(function () {
  // roulette rides a tackle only in its middle third
  var A = setup(), m = A.m, p = A.p;
  S.start(m, p, { x: 1, z: 0 }, false);
  p._skill.t = 0.05; check(!S.evades(p), 'a roulette started late does not ride the challenge');
  p._skill.t = 0.25; check(S.evades(p), 'a roulette spun INTO the challenge rides it');
  p._skill.t = 0.5; check(!S.evades(p), '...and the window closes before the spin ends');
  // feint bite: a defender squared up sometimes bites, never always
  var bites = 0;
  for (var i = 0; i < 60; i++) {
    A = setup(); m = A.m; p = A.p;
    var d = m.away.filter(function (o) { return !o.isGoalkeeper; })[0];
    place(d, 0, -1.8); d._bitT = 0;
    S.start(m, p, { x: 0, z: 0 }, false);
    if (d._bitT > 0) bites++;
  }
  info('feint bite rate vs an equal defender: ' + bites + '/60');
  check(bites > 10 && bites < 50, 'a feint fools a defender sometimes, not always (' + bites + '/60)');
  // bitten = slower for a moment, then back to normal
  d._bitT = 0.4; var s1 = d.speedMul(); d._bitT = 0; var s2 = d.speedMul();
  check(s1 < s2 * 0.6, 'a bitten defender loses a step');
  // stamina cost
  A = setup(); m = A.m; p = A.p; p.stamina = 1;
  S.start(m, p, { x: 1, z: 0 }, false);
  check(p.stamina < 1, 'moves cost a sliver of stamina (' + (1 - p.stamina).toFixed(2) + ')');
  // keepers and non-carriers cannot
  A = setup(); m = A.m; p = A.p; p.hasBall = false; m.ball.owner = null;
  check(!S.start(m, p, { x: 0, z: 0 }, false), 'no skill move without the ball');
  m.state = 'KICKOFF'; giveBall(m, p);
  check(!S.start(m, p, { x: 0, z: 0 }, false), 'no skill move before play is live');
})();

section('finesse, first time, volley');
(function () {
  // finesse: same strike, bent into the far post
  var A = setup(), m = A.m, p = A.p;
  var goal = m.enemyGoal(p.team);
  place(p, 4, goal.z + (goal.z > 0 ? -9 : 9), goal.z > 0 ? 0 : Math.PI); giveBall(m, p);
  p.shotCharge = 0.6; p._finesse = true;
  m.fireHumanShotReal(p, 0.6);
  var b = m.ball, lat0 = b.vx;
  check(b.curveT > 0, 'a finesse shot carries curl');
  var minX = 1e9, hitZ = null, xAtLine = null;
  for (var t = 0; t < 2; t += DT) { b.step(DT, null); if (xAtLine === null && Math.abs(b.z - goal.z) < 0.4) xAtLine = b.x; }
  info('finesse launched with vx ' + lat0.toFixed(2) + ', crossed the line at x=' + (xAtLine === null ? 'n/a' : xAtLine.toFixed(2)));
  check(xAtLine !== null && xAtLine < 0 && Math.abs(xAtLine) < LG.Config.court.goalWidth / 2, 'it bends back inside the FAR post');
  check(Math.sign(b.vx - lat0) !== 0, 'the path really curves (vx changed in flight)');

  // first time: SHOOT held as a pass arrives on the ground
  A = setup(); m = A.m; p = A.p;
  p.hasBall = false; m.ball.owner = null;
  place(p, 0, 0, Math.PI);
  m.ball.x = 0.9; m.ball.z = 0; m.ball.y = m.ball.r; m.ball.vx = -8; m.ball.vz = 0; m.ball.vy = 0;
  m.ball.lastKicker = m.home[1]; m.ball.kickT = 0;
  p.wasShooting = true;
  var shots = 0; m.bus.on('shoot', function (e) { if (e.firstTime) shots++; });
  check(S.firstTime(m, p, 0.5), 'SHOOT held as the ball arrives strikes it first time');
  check(m.ball.lastKicker === p && Math.sqrt(m.ball.vx * m.ball.vx + m.ball.vz * m.ball.vz) > 10, 'a real strike, not a poke');
  check(p._ftLock, 'the hold is spent (no double shot on release)');
  // volley
  A = setup(); m = A.m; p = A.p;
  p.hasBall = false; m.ball.owner = null; place(p, 0, 0, Math.PI);
  m.ball.x = 0.8; m.ball.z = 0; m.ball.y = 1.1; m.ball.vx = -6; m.ball.vy = -2;
  m.ball.lastKicker = m.home[1]; m.ball.kickT = 0; p.wasShooting = true;
  var vol = 0; m.bus.on('shoot', function (e) { if (e.volley) vol++; });
  check(S.firstTime(m, p, 0.6) && vol === 1, 'a ball arriving at waist height is VOLLEYED');
  // a ball just lying there is NOT a first-time chance
  A = setup(); m = A.m; p = A.p;
  p.hasBall = false; m.ball.owner = null; place(p, 0, 0);
  m.ball.x = 0.8; m.ball.z = 0; m.ball.y = m.ball.r; m.ball.vx = 0; m.ball.vz = 0; p.wasShooting = true;
  check(!S.firstTime(m, p, 0.5), 'a still ball is collected, not hit first time');
})();

section('shielding and the over-the-head rule');
(function () {
  var A = setup(), m = A.m, p = A.p;
  var d = m.away.filter(function (o) { return !o.isGoalkeeper; })[0];
  place(p, 0, 0, Math.PI); giveBall(m, p);
  place(d, 0, -1.2);                                   // right in front
  p.isHuman = false;
  for (var t = 0; t < 0.8; t += DT) { p.want.x = 0; p.want.z = 0; p.update(DT); }
  var toD = Math.atan2(d.x - p.x, d.z - p.z);
  var rel = Math.abs(wrap(p.facing - toD)) * 57.3;
  check(rel > 70 && rel < 110, 'a pressed carrier turns SIDE-ON to the challenger (' + rel.toFixed(0) + ' deg)');
  // ball over head height is not collected by an outfielder
  A = setup(); m = A.m; p = A.p;
  p.hasBall = false; m.ball.owner = null; m.possessionTeam = -1; place(p, 8, 8);
  d = m.away.filter(function (o) { return !o.isGoalkeeper; })[0];
  place(d, 0, 0); m.ball.x = 0.1; m.ball.z = 0; m.ball.y = 2.0; m.ball.vx = 0; m.ball.vz = 0;
  m.resolvePossession();
  check(!d.hasBall, 'an outfielder cannot trap a ball at 2 m with his feet');
  m.ball.y = m.ball.r; m.resolvePossession();
  check(d.hasBall, 'the same ball on the ground is his');
})();

section('the CPU uses them (and only under pressure)');
(function () {
  var A = setup(), m = A.m;
  var c = m.away.filter(function (o) { return !o.isGoalkeeper; })[0];
  var me = m.active;
  place(c, 0, 4, 0); giveBall(m, c);
  place(me, 0, 30);
  var n0 = 0; for (var i = 0; i < 600; i++) { S.aiTick(m, DT); if (c._skill) { n0++; S.end(c); c._skillCd = 0; } }
  check(n0 === 0, 'no tricks with nobody near');
  place(me, 0, 5.6);
  var n1 = 0; for (i = 0; i < 600; i++) { S.aiTick(m, DT); if (c._skill) { n1++; S.end(c); c._skillCd = 0; } }
  info('CPU tries under pressure: ' + n1 + ' in 10 s');
  check(n1 >= 2 && n1 < 40, 'a pressed CPU carrier tries a few moves (' + n1 + ' in 10 s)');
})();

section('a real CPU-vs-CPU stretch of play');
(function () {
  var m = newMatch(); m.start();
  // Build 8: genuinely CPU-vs-CPU — the human slot gets a real brain too
  // (LG.AI.create never existed, so that player used to stand still holding
  // the ball, which is not open play) and auto-switch must not re-arm him
  m.activatePlayer = function () {};
  m.all.forEach(function (p) { p.isHuman = false; if (!p.ai) p.ai = p.isGoalkeeper ? new LG.KeeperBrain(p) : new LG.AIBrain(p); });
  var count = 0, pressed = 0;
  m.bus.on('skillMove', function () { count++; });
  for (var i = 0; i < 60 * 90; i++) {
    m.update(DT);
    var c = m.ownerPlayer && m.ownerPlayer();
    if (c && m.state === 'PLAY') { var o = m.opponents(c); for (var k = 0; k < o.length; k++) if (o[k].distTo(c.x, c.z) < 2.2) { pressed++; break; } }
    if (m.state === 'END') break;
  }
  info('CPU skill moves in 90 s of AI play: ' + count + ' (carrier pressed within 2.2 m for ' + (pressed / 60).toFixed(1) + ' s)');
  check(count >= 1, 'the CPU really uses skill moves in open play (' + count + ')');
})();

console.log('\n== skillprobe: ' + PASS + ' passed, ' + FAIL + ' failed ==');
process.exit(FAIL ? 1 : 0);
