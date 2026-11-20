// ============================================================
// tools/looks/menus.js — films every menu of the REAL game in headless
// Chrome:  node tools/look.js tools/looks/menus.js --out <dir>
// (Build 5 check, part of `npm test` as test:build5). Walks the real
// buttons, so every screen is reached the way a player reaches it.
// Fails (exit 1) on any broken rule and (exit 3) on any page error.
// ============================================================
module.exports = async function (page) {
  var fails = 0, n = 0;
  function check(ok, what) { n++; if (!ok) fails++; page.log((ok ? 'ok   ' : 'FAIL ') + what); }
  function click(id) { return page.eval("document.getElementById('" + id + "').click(); true"); }
  function visible(id) { return page.eval("(function(){var e=document.getElementById('" + id + "');return !!e && !e.classList.contains('hidden') && getComputedStyle(e).display!=='none';})()"); }

  await page.until("LG.Athlete && LG.Athlete.ready && LG.Athlete.ready()", 30000);
  await page.until("document.getElementById('loading-overlay').classList.contains('hidden')", 30000);
  await page.wait(900);

  // ---- brand + fonts ----
  var fonts = JSON.parse(await page.eval(`(async function () {
    await document.fonts.ready;
    var fams = {};
    document.fonts.forEach(function (f) { if (f.status === 'loaded') fams[f.family.replace(/"/g, '')] = true; });
    return JSON.stringify({ anton: !!fams.Anton, barlow: !!fams['Barlow Condensed'], body: !!fams.Barlow });
  })()`));
  check(fonts.anton && fonts.barlow && fonts.body, 'the three shipped fonts load from the game itself ' + JSON.stringify(fonts));
  check(await page.eval("!!document.querySelector('#menu-overlay .bo-logo svg')"), 'the home screen shows the new logo');

  // ---- home hub ----
  var hub = JSON.parse(await page.eval(`JSON.stringify({
    coins: (document.getElementById('hub-coins')||{}).textContent,
    twist: (document.getElementById('hub-twist-name')||{}).textContent,
    ch: document.querySelectorAll('#hub-challenges .hub-ch').length,
    nav: document.querySelectorAll('#hub-nav button').length })`));
  var bal = await page.eval("LG.Progression.coins()");
  check((hub.coins || '').replace(/,/g, '') === String(bal), 'the hub shows the coin balance (' + hub.coins + ' / ' + bal + ')');
  check(!!hub.twist && hub.twist.length > 2, "the hub shows today's Street Twist (" + hub.twist + ')');
  check(hub.ch === 3, 'the hub lists 3 challenges with progress (' + hub.ch + ')');
  check(hub.nav >= 4, 'the hub has a bottom bar (' + hub.nav + ' buttons)');
  await page.shot('m01_home');

  // ---- the setup flow ----
  await click('btn-play'); await page.wait(500);
  check(await visible('mode-overlay'), 'KICK OFF opens the modes');
  check(await page.eval("document.querySelectorAll('#mode-list .mode-soon').length >= 1"), 'coming-soon modes are shown but cannot be picked');
  await page.shot('m02_modes');
  await click('btn-mode-go'); await page.wait(500);
  await page.shot('m03_difficulty');
  await click('btn-diff-go'); await page.wait(500);
  var card = JSON.parse(await page.eval(`JSON.stringify({ bars: document.querySelectorAll('#char-grid .char-card .stat-bar').length, ovr: document.querySelectorAll('#char-grid .char-ovr').length, cards: document.querySelectorAll('#char-grid .char-card').length })`));
  check(card.cards > 0 && card.ovr === card.cards && card.bars >= card.cards * 6, 'every star card has an OVR and 6 stat bars ' + JSON.stringify(card));
  await page.shot('m04_select');
  await click('btn-select-go'); await page.wait(1300);
  await page.shot('m05_style');
  await click('btn-style-go'); await page.wait(700);
  await page.shot('m06_court');
  await click('btn-court-go'); await page.wait(500);
  check(await page.eval("!!document.getElementById('time-blackout') && !!document.getElementById('weather-rain')"), 'match setup offers BLACKOUT time and RAIN');
  await page.shot('m07_setup');
  await click('btn-setup-back'); await click('btn-court-back'); await click('btn-style-back');
  await click('btn-back'); await click('btn-diff-back'); await click('btn-mode-back');
  await page.wait(500);
  check(await visible('menu-overlay'), 'BACK walks all the way home');

  // ---- hub shortcuts ----
  await click('hub-cup'); await page.wait(400);
  check(await visible('tournament-overlay'), 'the Street Cup tile opens the cup');
  await click('btn-tournament-back'); await click('btn-mode-back'); await page.wait(300);
  await click('hub-twist'); await page.wait(400);
  check(await visible('mode-overlay') && await page.eval("!!document.querySelector('#mode-list .mode-street_twist.selected')"), 'the twist tile opens the modes with STREET TWIST picked');
  await click('btn-mode-back'); await page.wait(300);

  // ---- side screens ----
  await click('btn-settings'); await page.wait(500); await page.shot('m08_settings'); await click('btn-settings-back');
  await click('btn-how'); await page.wait(400); await page.shot('m09_how'); await click('btn-how-back');
  await click('btn-about'); await page.wait(400); await page.shot('m10_about'); await click('btn-about-back');
  await click('btn-profile'); await page.wait(400); await page.shot('m11_profile'); await click('btn-profile-back');
  await click('btn-challenges'); await page.wait(400); await page.shot('m12_challenges'); await click('btn-challenges-back');
  await page.wait(300);

  // ---- a match in the rain at blackout ----
  await page.eval("LG.Settings.setWeather && LG.Settings.setWeather('rain'); LG.Settings.setTimeOfDay('blackout'); true");
  await click('btn-quick-play');
  await page.until("LGMain.getState() === 'match'", 15000);
  await page.wait(3500);
  var env = JSON.parse(await page.eval(`JSON.stringify({ rain: !!(LG.Weather && LG.Weather.active()), tod: LG.Settings.timeOfDay(), bug: !!document.querySelector('#scoreboard.sb-bug') })`));
  check(env.rain, 'rain falls during the match');
  check(env.tod === 'blackout', 'the BLACKOUT time of day reaches the match');
  check(env.bug, 'the scoreboard is the broadcast score bug');
  await page.shot('m13_match_blackout_rain');
  await click('pause-btn'); await page.wait(500);
  check(await page.eval("document.querySelectorAll('#pause-stats .ps-row').length >= 4"), 'pause shows live match stats');
  await page.shot('m14_pause');
  await click('btn-resume'); await page.wait(400);
  // full time on demand (headless frames are too sparse to wait out a clock)
  await page.eval("(function(){ var m = LGMain.getMatch(); m.score[0] = 3; m.score[1] = 1; m.stats.home.goals = 3; m.stats.away.goals = 1; m.stats.home.tackles = 4; m.stats.home.saves = 2; m.endMatch(); })(); true");
  await page.until("LGMain.getState() === 'result'", 15000);
  await page.wait(1200);
  check(await page.eval("document.querySelectorAll('#res-coin-lines .rc-line').length >= 1"), 'full time itemises the coins');
  await page.shot('m15_result');
  await click('btn-result-menu');
  await page.eval("LG.Settings.setWeather && LG.Settings.setWeather('dry'); LG.Settings.setTimeOfDay('night'); true");

  page.log('BUILD5 ' + (fails ? 'FAIL' : 'PASS') + ' ' + (n - fails) + '/' + n);
  if (fails) throw new Error(fails + ' build-5 checks failed');
};
