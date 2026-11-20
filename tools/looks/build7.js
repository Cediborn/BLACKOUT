// ============================================================
// tools/looks/build7.js — Build 7 check on the REAL game in headless
// Chrome:  node tools/look.js tools/looks/build7.js --out <dir>
// The five match cameras (distinct poses, ball in frame, portrait AND
// landscape, the in-match button), the postprocessing pipeline (live, not
// black, not blown out, tier per quality, safe fallback), static-mesh
// batching (draw calls), the dynamic-resolution governor, and skill moves
// from the real key/button path (SKILL button only while attacking).
// Matches are stepped directly where the headless renderer is too slow.
// ============================================================
var fs = require('fs'), zlib = require('zlib');

// tiny PNG reader (8-bit RGB/RGBA, non-interlaced) -> mean luminance
function meanLum(file) {
  var b = fs.readFileSync(file), off = 8, w = 0, h = 0, ct = 0, idat = [];
  while (off < b.length) {
    var len = b.readUInt32BE(off), type = b.toString('ascii', off + 4, off + 8), d = b.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    off += 12 + len;
  }
  var bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp;
  var prev = Buffer.alloc(stride), cur = Buffer.alloc(stride), sum = 0, n = 0, p = 0;
  for (var y = 0; y < h; y++) {
    var f = raw[p++];
    for (var x = 0; x < stride; x++) {
      var a = x >= bpp ? cur[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0, v = raw[p++];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { var pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c); }
      cur[x] = v & 255;
    }
    // the middle band only (HUD-free-ish)
    if (y > h * 0.25 && y < h * 0.75) for (var q = 0; q < stride; q += bpp * 7) { sum += 0.2126 * cur[q] + 0.7152 * cur[q + 1] + 0.0722 * cur[q + 2]; n++; }
    var t = prev; prev = cur; cur = t;
  }
  return sum / n;
}

module.exports = async function (page) {
  var fails = 0, n = 0;
  function check(ok, what) { n++; if (!ok) fails++; page.log((ok ? 'ok   ' : 'FAIL ') + what); }
  function click(id) { return page.eval("document.getElementById('" + id + "').click(); true"); }
  function J(expr) { return page.eval('JSON.stringify(' + expr + ')').then(JSON.parse); }
  function sim(sec) { return page.eval("(function(){ var m=LGMain.getMatch(); for (var i=0;i<" + Math.round(sec * 30) + ";i++){ if (LGMain.getState()!=='match') break; LG.Input.update(performance.now()/1000); m.update(1/30); } return true; })()"); }
  // run the REAL camera for a while (the loop is slow headless)

  await page.until("LG.Athlete && LG.Athlete.ready && LG.Athlete.ready()", 30000);

  // ---------- batching + perf governor ----------
  var bt = await J("(function(){ var b = LG.debug.arena && LG.debug.arena.userData.batch; return b ? { merged: b.merged, hidden: b.hidden, colour: b.colour } : null; })()");
  check(bt && bt.merged > 10, 'the arena is batched into merged meshes ' + JSON.stringify(bt));
  check(await page.eval("!!(LG.Perf && LG.Perf.scale() <= 1 && LG.Perf.scale() >= 0.6)"), 'the dynamic-resolution governor is live (scale ' + (await page.eval('LG.Perf.scale()')) + ')');

  // ---------- into a match ----------
  await page.eval("LG.eventBus.emit('quickPlayRequested'); true");
  await page.until("LGMain.getState() === 'match'", 20000);
  await page.until("LGMain.getMatch().state === 'PLAY'", 30000);
  // draw calls of the SCENE (the composer's passes reset the counter, so
  // measure one direct frame)
  await page.eval("LG.Post.setTier(0); true"); await page.wait(700);
  var calls = await page.eval("LG.debug.renderer.info.render.calls");
  await page.eval("LG.Post.setTier(LG.Settings.qualityProfile(false).post || 2); true"); await page.wait(500);
  check(calls > 0 && calls < 520, 'a match frame stays under 520 draw calls (' + calls + ')');

  // ---------- postprocessing ----------
  var pi = await J("LG.Post.info()");
  check(pi.lib, 'pmndrs/postprocessing is loaded');
  check(pi.built >= 1 && !pi.failed && pi.effects.indexOf('bloom') >= 0, 'the composer is built for this quality tier ' + JSON.stringify({ tier: pi.built, fx: pi.effects }));
  await page.eval("LG.Perf.reset && LG.Perf.reset(); true");
  await page.wait(1200);
  check(await page.eval("LG.Post.info().stats.frames > 0"), 'frames really go through the composer');
  var fOn = await page.shot('b7_post_on');
  await page.eval("LG.Post.setTier(0); true"); await page.wait(900);
  var fOff = await page.shot('b7_post_off');
  var lOn = meanLum(fOn), lOff = meanLum(fOff);
  page.log('       mean luminance post on ' + lOn.toFixed(1) + ' / off ' + lOff.toFixed(1));
  check(lOn > 12 && lOn < 235, 'the post image is neither black nor blown out (' + lOn.toFixed(1) + ')');
  check(Math.abs(lOn - lOff) < Math.max(28, lOff * 0.35), 'post keeps the scene\'s exposure (tone map carried over): ' + lOn.toFixed(1) + ' vs ' + lOff.toFixed(1));
  await page.eval("LG.Post.setTier(2); true"); await page.wait(600);
  check(await page.eval("LG.Post.info().built === 2 && LG.Post.info().effects.length >= 5"), 'HIGH adds the broadcast grade + SMAA');
  await page.eval("LG.Settings.setQuality && LG.Settings.setQuality('low'); LGMain.applyQuality ? LGMain.applyQuality() : 0; true");

  // ---------- the five cameras ----------
  async function poses(view) {
    await page.eval("LG.Settings.setView('" + view + "'); window.dispatchEvent(new Event('resize')); true");
    var out = [];
    for (var c = 1; c <= 5; c++) {
      await page.eval("(function(){ var m=LGMain.getMatch(); m.state='PLAY'; LG.Settings.setCamera(" + c + "); m.ball.vx=0; m.ball.vz=0; })(); true");
      await page.wait(2400);
      var r = await J("(function(){ var cam=LG.debug.camera, m=LGMain.getMatch(), b=m.ball; var v=new THREE.Vector3(b.x,b.y,b.z).project(cam); var pos=cam.position; return { x:+pos.x.toFixed(2), y:+pos.y.toFixed(2), z:+pos.z.toFixed(2), fov:+cam.fov.toFixed(1), d:+Math.hypot(pos.x-b.x,pos.y-b.y,pos.z-b.z).toFixed(2), ndc:[+v.x.toFixed(2),+v.y.toFixed(2)], btn: document.getElementById('cam-num').textContent }; })()");
      out.push(r);
      await page.shot('b7_cam' + c + '_' + view);
    }
    return out;
  }
  var P = await poses('portrait');
  page.log('       portrait ' + JSON.stringify(P.map(function (p) { return [p.y, p.d, p.fov]; })));
  var distinct = 0;
  for (var i = 0; i < 5; i++) for (var j = i + 1; j < 5; j++) if (Math.abs(P[i].d - P[j].d) > 1.2 || Math.abs(P[i].y - P[j].y) > 1.2 || Math.abs(P[i].fov - P[j].fov) > 6) distinct++;
  check(distinct === 10, 'portrait: five genuinely different camera poses (' + distinct + '/10 pairs differ)');
  check(P.every(function (p) { return Math.abs(p.ndc[0]) < 1 && Math.abs(p.ndc[1]) < 1; }), 'portrait: the ball is on screen in every camera ' + JSON.stringify(P.map(function (p) { return p.ndc; })));
  check(P[4].d < P[2].d && P[2].d < P[1].d, 'FOCUS is closest, DYNAMIC between, WIDE furthest');
  check(P.every(function (p, k) { return p.btn === String(k + 1); }), 'the in-match camera button shows the active camera');
  var L = await poses('landscape');
  page.log('       landscape ' + JSON.stringify(L.map(function (p) { return [p.y, p.d, p.fov]; })));
  check(L.every(function (p) { return Math.abs(p.ndc[0]) < 1 && Math.abs(p.ndc[1]) < 1; }), 'landscape: the ball is on screen in every camera');
  check(L[4].d < L[1].d - 10, 'landscape: the close cameras really are close (' + L[4].d + ' m vs ' + L[1].d + ' m)');
  // the button cycles and persists
  await page.eval("document.getElementById('cam-btn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true");
  check(await page.eval("LG.Settings.camera() === 1"), 'the camera button cycles 5 -> 1');
  check(await page.eval("JSON.parse(localStorage.getItem(Object.keys(localStorage).filter(function(k){ return /settings/i.test(k); })[0]) || '{}').camera === 1"), 'the choice is saved');
  var r = await J("(function(){ var b=document.getElementById('cam-btn').getBoundingClientRect(), p=document.getElementById('pause-btn').getBoundingClientRect(); return { top: b.top, h: b.height, ptop: p.top, overlap: !(b.right < p.left || b.left > p.right) }; })()");
  check(Math.abs(r.top - r.ptop) < 2 && !r.overlap && r.h >= 40, 'the camera button sits in the top bar beside PAUSE, thumb-sized, away from the sticks ' + JSON.stringify(r));
  await page.eval("LG.Settings.setView('landscape'); LG.Settings.setCamera(3); true");

  // ---------- skills through the real input path ----------
  var sk = await J("(function(){ var m=LGMain.getMatch(), h=m.active; m.state='PLAY'; m.all.forEach(function(o){ o.hasBall=false; }); h.hasBall=true; m.ball.owner=h; m.possessionTeam=h.team; h._skillCd=0; m.updateControlMode(); return { skillShown: !document.getElementById('btn-skill').classList.contains('hidden-control'), switchShown: !document.getElementById('btn-switch').classList.contains('hidden-control') }; })()");
  check(sk.skillShown && !sk.switchShown, 'attacking: SKILL takes SWITCH\'s slot');
  await page.eval("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' })); true");
  await page.eval("(function(){ var m=LGMain.getMatch(); LG.Input.update(performance.now()/1000); m.update(1/30); })(); true");
  await page.eval("window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF' })); true");
  var used = await J("LG.Skills.used()");
  check((used.feint || 0) + (used.dragback || 0) + (used.roulette || 0) + (used.rainbow || 0) >= 1, 'the F key performs a skill move ' + JSON.stringify(used));
  await page.wait(250);
  await page.shot('b7_skill');
  await sim(1.0);
  // touch button
  await page.eval("(function(){ var m=LGMain.getMatch(), h=m.active; m.all.forEach(function(o){ o.hasBall=false; }); h.hasBall=true; m.ball.owner=h; m.possessionTeam=h.team; h._skillCd=0; h._skill=null; m.updateControlMode(); })(); true");
  await page.eval("var b=document.getElementById('btn-skill'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3 })); true");
  await page.eval("(function(){ var m=LGMain.getMatch(); LG.Input.update(performance.now()/1000); m.update(1/30); })(); true");
  await page.eval("var b=document.getElementById('btn-skill'); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 })); true");
  var used2 = await J("LG.Skills.used()");
  var tot = function (u) { return (u.feint || 0) + (u.dragback || 0) + (u.roulette || 0) + (u.rainbow || 0); };
  check(tot(used2) > tot(used), 'the SKILL touch button performs one too');
  var def = await J("(function(){ var m=LGMain.getMatch(); var o=m.away.filter(function(p){return !p.isGoalkeeper;})[0]; m.all.forEach(function(p){ p.hasBall=false; p._skill=null; }); o.hasBall=true; m.ball.owner=o; m.possessionTeam=o.team; m.updateControlMode(); return !document.getElementById('btn-skill').classList.contains('hidden-control'); })()");
  check(!def, 'defending: SKILL is hidden (SWITCH is back)');

  // a minute of real play with every system on: no errors, CPU tricks happen
  await page.eval("window.__b7err = []; window.addEventListener('error', function (e) { __b7err.push(e.message); }); LG.Skills.resetStats(); true");
  await sim(40);
  var errs = await J("window.__b7err");
  check(errs.length === 0, 'forty seconds of play with cameras, post, skills and batching: no errors ' + JSON.stringify(errs.slice(0, 2)));
  page.log('       skills used in 40 s of play: ' + JSON.stringify(await J("LG.Skills.used()")));
  await page.shot('b7_play');

  page.log('BUILD7 ' + (fails ? 'FAIL' : 'PASS') + ' ' + (n - fails) + '/' + n);
  if (fails) throw new Error(fails + ' build-7 checks failed');
};
