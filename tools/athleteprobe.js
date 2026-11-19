// ============================================================
// tools/athleteprobe.js — headless checks for the Phase 11 athlete body
// Loads the REAL three.js + GLTFLoader + 3d/athlete.glb under Node and
// drives js/athlete.js: load, dress every roster star, and walk the
// controller through locomotion, kick, slide tackle, emotes and failure
// paths. No browser, no WebGL — geometry, skinning and the mixer are pure JS.
// Run: node tools/athleteprobe.js
// ============================================================
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..');
var PASS = 0, FAIL = 0;
function check(c, label, detail) {
  if (c) { PASS++; console.log('  ok   ' + label); }
  else { FAIL++; console.log('  FAIL ' + label + (detail !== undefined ? '  ->  ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

global.window = global; global.self = global;
global.location = { protocol: 'http:', search: '' };
global.document = {
  createElement: function () {
    return { width: 0, height: 0, getContext: function () {
      return { clearRect: function () {}, fillText: function () {}, strokeText: function () {}, set font(v) {}, set textAlign(v) {},
        set textBaseline(v) {}, set lineWidth(v) {}, set strokeStyle(v) {}, set fillStyle(v) {} };
    } };
  },
};
global.fetch = function (url) {
  return new Promise(function (res, rej) {
    fs.readFile(path.join(ROOT, url), function (err, buf) {
      if (err) { rej(err); return; }
      res({ ok: true, arrayBuffer: function () { return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); } });
    });
  });
};
function load(rel) { vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel }); }
load('lib/three.min.js');
load('lib/GLTFLoader.js');
load('js/config.js');
load('js/athlete.js');
var LG = window.LG;

function until(fn, ms) {
  return new Promise(function (res, rej) {
    var t0 = Date.now();
    (function poll() { if (fn()) res(); else if (Date.now() - t0 > ms) rej(new Error('timeout')); else setTimeout(poll, 20); })();
  });
}

function fakePlayer(m, o) {
  var p = { vx: 0, vz: 0, facing: 0, kickAnim: 0, tackleAnim: 0, stamina: 1, sprinting: false, isGoalkeeper: false, model: m };
  for (var k in o || {}) p[k] = o[k];
  return p;
}
function run(m, p, seconds) {
  var dt = 1 / 60, s = null;
  for (var t = 0; t < seconds; t += dt) {
    p.kickAnim = Math.max(0, p.kickAnim - dt * 5);
    p.tackleAnim = Math.max(0, p.tackleAnim - dt * 2.2);
    m.anim.step(dt, p);
  }
  return m.anim.state();
}

(async function () {
  section('1. asset loads');
  await until(function () { return LG.Athlete.status().phase !== 'loading'; }, 20000);
  var st = LG.Athlete.status();
  check(st.phase === 'ready', 'athlete.glb loads and parses', JSON.stringify(st));
  if (st.phase !== 'ready') { finish(); return; }
  check(st.clips >= 30, 'the asset carries the authored clip set', st.clips);
  var M = LG.Athlete.meta();
  check(M.height > 1.6 && M.height < 1.95, 'the body has real human height (~1.8m)', M.height.toFixed(3));
  check(M.eyeZ > M.J.Head.z, 'the eye line is on the FRONT of the head', M.eyeZ.toFixed(3));
  check(M.kickStrike > 0.1 && M.kickStrike < 1.0, 'the kick clip has a measured strike frame', M.kickStrike.toFixed(2));

  section('2. every star dresses on the real body');
  var built = {};
  LG.Roster.forEach(function (def) {
    var d = JSON.parse(JSON.stringify(def));
    var m = LG.Athlete.build(d, { idx: 0 });
    built[def.id] = m;
    var ok = !!(m && m.athlete && m.clipDriven && m.anim);
    var colours = {};
    if (m) m.scene.traverse(function (o) {
      if (o.isSkinnedMesh) {
        var c = o.geometry.attributes.color;
        for (var i = 0; i < c.count; i += 3) colours[[c.getX(i).toFixed(2), c.getY(i).toFixed(2), c.getZ(i).toFixed(2)].join()] = 1;
      }
    });
    check(ok && Object.keys(colours).length >= 12, def.id + ' builds with a dressed kit', Object.keys(colours).length + ' tones');
  });
  var gk = LG.Athlete.build({ id: 'guard', name: 'GUARD', palette: { skin: 0x9c7048, hair: 0x111111, shirt: 0x22aa55, pants: 0x22aa55, shoe: 0x111111, trim: 0xffffff }, body: { gloves: 0xffffff, tall: 1.06, wide: 1.15 } }, { idx: 3 });
  check(!!gk && gk.athlete, 'a goalkeeper builds (gloves + build variety)');
  var m0 = built.blaze;
  m0.group.scale.set(1.35, 1.35, 1.35);          // player.js applies LG.Player.visualScale()
  check(m0.limbs === null && m0.body === null, 'legacy limb helpers see no limbs (they no-op on this body)');

  section('3. locomotion follows speed and direction');
  var p = fakePlayer(m0);
  var s = run(m0, p, 0.5);
  check(s.cur === 'idle', 'standing still idles', s.cur);
  p.vz = 2.0; s = run(m0, p, 0.5); check(s.cur === 'walk', 'a slow drift walks', s.cur);
  p.vz = 5.5; s = run(m0, p, 0.5); check(s.cur === 'jog', 'match pace jogs', s.cur);
  p.vz = 9.5; s = run(m0, p, 0.5); check(s.cur === 'sprint', 'top speed sprints', s.cur);
  p.vz = -5.5; s = run(m0, p, 0.5); check(s.cur === 'jog_back', 'moving away from the facing back-pedals', s.cur);
  p.vz = 0; p.vx = 4; s = run(m0, p, 0.5); check(s.cur === 'jog_left' || s.cur === 'jog_right', 'moving sideways strafes', s.cur);
  p.vx = 0; p.stamina = 0.1; s = run(m0, p, 0.5); check(s.cur === 'tired', 'an exhausted player stands tired', s.cur);
  p.stamina = 1;

  section('4. kick + slide tackle one-shots');
  p.vz = 5; run(m0, p, 0.3);
  p.kickAnim = 1; s = run(m0, p, 0.05);
  check(s.shot === 'kick', 'a kick plays the authored kick', s.shot);
  s = run(m0, p, 1.2); check(s.shot === null, 'the kick hands back to locomotion', s.shot);
  p.tackleAnim = 1; s = run(m0, p, 0.08);
  check(s.shot === 'slide_start', 'a tackle drops into a slide', s.shot);
  s = run(m0, p, 0.5); check(s.shot === 'slide_exit' || s.shot === null, 'the slide rises again', s.shot);
  s = run(m0, p, 1.0); check(s.shot === null && s.fails === 0, 'the tackle finishes cleanly', s.shot + ' fails=' + s.fails);

  section('5. emotes (celebrations / reactions)');
  p.vz = 0; run(m0, p, 0.3);
  check(m0.anim.emote('celebrate', { hold: true, dur: 2 }) === true, 'celebrate starts');
  s = run(m0, p, 0.5); check(s.emote === 'celebrate', 'the emote plays', s.emote);
  check(m0.anim.emote('celebrate', { hold: true, dur: 2 }) === true && run(m0, p, 0.02).emote === 'celebrate', 'calling it again every frame is idempotent');
  s = run(m0, p, 3); check(s.emote === null, 'an emote ends after its duration', s.emote);
  m0.anim.emote('no', { dur: 3 });
  p.vz = 6; s = run(m0, p, 1.2); check(s.emote === null, 'live movement cancels a casual emote', s.emote);
  check(m0.anim.emote('nope_not_a_clip') === false, 'an unknown clip is refused');

  section('6. cinematic pose contract');
  check(m0.anim.pose('run', 0.3) === true && m0.anim.state().cur === 'jog', "pose('run') pins the run cycle");
  check(m0.anim.state().durs.run > 0.3, 'state().durs.run reports the run clip length');
  check(m0.anim.has('tackle') && m0.anim.has('run') && !m0.anim.has('zzz'), 'has() answers for the layers');
  var bad = fakePlayer(m0); bad.vx = NaN;
  check(m0.anim.update(0.016, bad) === true, 'update never hands the body to the limb maths');

  finish();
})().catch(function (e) { console.log('PROBE CRASH ' + (e && e.stack)); FAIL++; finish(); });

function finish() {
  console.log('\n' + (FAIL ? 'ATHLETEPROBE FAIL ' : 'ATHLETEPROBE PASS ') + PASS + '/' + (PASS + FAIL));
  process.exit(FAIL ? 1 : 0);
}
