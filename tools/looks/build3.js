// ============================================================
// tools/looks/build3.js — Build 3 check, run on the REAL game in headless
// Chrome:  node tools/look.js tools/looks/build3.js --out <dir>
// (part of `npm test` as test:build3). Fails (exit 1) on any broken rule
// and (exit 3) on any page error.
//
//   1. every player wears a real garment that matches their outfit
//      (keepers wear the keeper kit), every design builds a real shell
//   2. the crowd swapped its capsules for real bodies
//   3. bystanders are real skinned people in street clothes
//   4. street life: pigeons, festoon bulbs, steam vents, litter, vendor;
//      a scare sends a flock up
//   0. (Build 4) the kit room: two live players, the orb picks the team
//      style, and the style + the skin rule reach the match
// It also films a few frames for a human to look at.
// ============================================================
module.exports = async function (page) {
  var fails = 0, n = 0;
  function check(ok, what) { n++; if (!ok) fails++; page.log((ok ? 'ok   ' : 'FAIL ') + what); }

  await page.until("LG.Athlete && LG.Athlete.ready && LG.Athlete.ready()", 30000);
  // ---- 0. kit room (Build 4): two live players, orb = style, tap = colour ----
  await page.eval("LG.eventBus.emit('selectConfirmed'); true");
  await page.wait(1200);
  var kr = JSON.parse(await page.eval(`JSON.stringify({ home: LG.KitRoom.live('home'), away: LG.KitRoom.live('away'),
    grids: !!document.getElementById('color-grid') || !!document.getElementById('gear-outfit') })`));
  check(kr.home && kr.away, 'the kit room shows two live 3D players');
  check(!kr.grids, 'no colour grids or gear rows on PLAYER STYLE');
  var want = await page.eval(`(function () {
    var orb = document.getElementById('kit-home-orb'), guard = 0;
    while (LGMain.getSelections().homeStyle !== 'baggy' && guard++ < 12) orb.click();
    document.getElementById('kit-away-player').click();
    return JSON.stringify(LGMain.getSelections());
  })()`);
  want = JSON.parse(want);
  check(want.homeStyle === 'baggy', 'the orb reaches BAGGY KIT');
  await page.shot('b3_kitroom');
  // walk on through the real flow: court -> match setup -> kick off
  await page.eval("LG.eventBus.emit('styleConfirmed'); LG.eventBus.emit('courtConfirmed'); LG.eventBus.emit('startMatchRequested'); true");
  await page.wait(3500);
  var team = JSON.parse(await page.eval(`JSON.stringify(LG.Match.all.filter(function (p) { return !p.isGoalkeeper; }).map(function (p) {
    return { team: p.team, garment: p.model && p.model.garment, skin: p.def.__cos && p.def.__cos.skin }; }))`));
  var home = team.filter(function (p) { return p.team === 0; }), away = team.filter(function (p) { return p.team === 1; });
  check(home.length === 3 && home.every(function (p) { return p.garment === 'baggy'; }), 'your whole team wears the style picked on the orb', JSON.stringify(home));
  function rule(sq) {
    var d = sq.filter(function (p) { return /tone5|tone6/.test(p.skin); }).length;
    var w = sq.filter(function (p) { return /tone1|tone2/.test(p.skin); }).length;
    var m = sq.filter(function (p) { return /tone3|tone4/.test(p.skin); }).length;
    return d === 1 && w === 1 && m === 1;
  }
  check(rule(home) && rule(away), 'each squad has one black, one white and one mixed-skin player', JSON.stringify(team.map(function (p) { return p.skin; })));

  // ---- 1. garments ----
  var r = JSON.parse(await page.eval(`JSON.stringify(LG.Match.all.map(function (p) {
    var c = p.def && p.def.__cos;
    return { id: p.def && p.def.id, keeper: !!p.isGoalkeeper, garment: p.model && p.model.garment,
      outfit: c ? c.outfit : null };
  }))`));
  check(r.length >= 6, 'a match has ' + r.length + ' players');
  check(r.every(function (p) { return !!p.garment; }), 'every player wears a garment');
  check(r.filter(function (p) { return p.keeper; }).every(function (p) { return p.garment === 'keeper'; }), 'keepers wear the keeper kit');
  check(r.filter(function (p) { return !p.keeper && p.outfit; }).every(function (p) { return p.garment === p.outfit; }),
    'outfield garments match the chosen outfit');
  var shells = JSON.parse(await page.eval(`(function () {
    var out = {};
    LG.Garments.designs().forEach(function (d, i) {
      var m = LG.Athlete.build({ id: 'chk' + i, palette: { shirt: 0x3366cc, trim: 0xffffff } }, { design: d, lite: true });
      var tris = 0;
      if (m) m.group.traverse(function (o) { if (o.isSkinnedMesh && o.userData.garment === d) tris += o.geometry.attributes.position.count / 3; });
      out[d] = tris;
    });
    return JSON.stringify(out);
  })()`));
  Object.keys(shells).forEach(function (d) { check(shells[d] > 400, 'design ' + d + ' builds a shell (' + Math.round(shells[d]) + ' tris)'); });
  var spec = JSON.parse(await page.eval("JSON.stringify({ b: LG.Garments.spec('baggy'), j: LG.Garments.spec('jersey') })"));
  check(spec.b.t0 > spec.j.t0 * 1.8 && spec.b.legs === 'knee' && spec.b.sleeve === 'elbow', 'the baggy kit is really baggy (loose tee, elbow sleeves, knee-length shorts)');

  // ---- 2. crowd ----
  var cs = JSON.parse(await page.eval("JSON.stringify(LG.Crowd.stats)"));
  check(cs.bodies > 40 && cs.real === true, 'crowd: ' + cs.bodies + ' fans on real bodies');

  // ---- 3. bystanders ----
  var li = JSON.parse(await page.eval("JSON.stringify(LG.Living.info())"));
  check(li.folk >= 12, 'street folk: ' + li.folk + ' real people');

  // ---- 4. street life ----
  var sl = JSON.parse(await page.eval("JSON.stringify(LG.StreetLife.info())"));
  check(sl.pigeons >= 14 && sl.bulbs >= 30 && sl.vents >= 3 && sl.litter >= 10, 'street life built: ' + JSON.stringify(sl));
  check(sl.vendor === true, 'the food cart has a vendor');
  await page.eval("LG.StreetLife.scare(0); true");
  await page.wait(500);
  var sl2 = JSON.parse(await page.eval("JSON.stringify(LG.StreetLife.info())"));
  check(sl2.flocks[0] === 'air', 'a scare sends the flock up');

  // ---- frames to look at ----
  await page.cam([0, 1.6, 7.5], [0, 1.1, 0], 45); await page.shot('b3_court');
  await page.cam([0, 3.2, 14], [0, 3.6, 26], 60); await page.shot('b3_stand');
  await page.cam([-20.5, 2.4, 6.5], [-25.4, 1.4, 2], 50); await page.shot('b3_cart');

  page.log('BUILD3 ' + (fails ? 'FAIL' : 'PASS') + ' ' + (n - fails) + '/' + n);
  if (fails) throw new Error(fails + ' build-3 checks failed');
};
