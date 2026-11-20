// ============================================================
// HUB (Build 5) — the data on the new home screen, the pause board
// and the itemised coins on the full-time screen. Reads the existing
// stores (Progression, Challenges, Modes, Tournament, match stats);
// writes nothing to them. Every hub button re-uses an existing event,
// so the menu flow and its tests stay exactly as they were.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Hub = (function () {
  function $(id) { return document.getElementById(id); }
  function txt(id, v) { var e = $(id); if (e) e.textContent = v; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n) { return (LG.Util && LG.Util.fmtMoney) ? LG.Util.fmtMoney(n) : String(n); }

  function targetLabel(def) {
    switch (def.objectiveType) {
      case 'cleanSheet': return 'Clean sheet';
      case 'win': return 'Win a match';
      case 'winBy': return 'Win by ' + def.target + '+';
      default: return 'Target ' + def.target;
    }
  }

  function refresh() {
    var P = LG.Progression;
    // coins
    if (P) txt('hub-coins', fmt(P.coins()));

    // today's twist
    var tw = LG.Modes && LG.Modes.twistInfo ? LG.Modes.twistInfo('daily') : null;
    if (tw) { txt('hub-twist-name', tw.label); txt('hub-twist-blurb', tw.blurb); }

    // street cup: status + two-step bar (semi-final, final)
    var T = LG.Tournament, r1 = $('hub-cup-r1'), r2 = $('hub-cup-r2');
    var st = T ? T.status() : 'idle';
    var round = T && T.currentRound ? T.currentRound() : 0;
    if (r1) r1.className = '';
    if (r2) r2.className = '';
    if (st === 'active') {
      txt('hub-cup-k', 'CONTINUE');
      txt('hub-cup-k2', round === 0 ? 'ROUND 1 OF 2' : 'ROUND 2 OF 2');
      txt('hub-cup-sub', (round === 0 ? 'SEMI-FINAL' : 'FINAL') + ' NEXT');
      if (r1) r1.className = round === 0 ? 'next' : 'done';
      if (r2) r2.className = round === 0 ? '' : 'next';
    } else if (st === 'won') {
      txt('hub-cup-k', 'CHAMPIONS'); txt('hub-cup-k2', 'CUP WON');
      txt('hub-cup-sub', 'START A NEW CUP');
      if (r1) r1.className = 'done'; if (r2) r2.className = 'done';
    } else if (st === 'eliminated') {
      txt('hub-cup-k', 'KNOCKED OUT'); txt('hub-cup-k2', 'TRY AGAIN');
      txt('hub-cup-sub', 'START A NEW CUP');
    } else {
      txt('hub-cup-k', 'STREET CUP'); txt('hub-cup-k2', '4 TEAMS');
      txt('hub-cup-sub', 'SEMI-FINAL + FINAL');
    }

    // the three active challenges
    var list = $('hub-ch-list');
    if (list && P && P.activeChallenges) {
      var act = P.activeChallenges(), html = '', shown = 0;
      for (var i = 0; i < act.length; i++) {
        var def = LG.Challenges && LG.Challenges.byId ? LG.Challenges.byId(act[i]) : null;
        if (!def) continue;
        shown++;
        html += '<div class="hub-ch ch-' + esc(def.difficulty) + '">' +
          '<span class="hc-t">' + esc(def.title) + '</span>' +
          '<span class="hc-r"><span class="coin"></span>+' + esc(def.reward) + '</span>' +
          '<span class="hc-d">' + esc(def.description) + '</span>' +
          '<span class="hc-g">' + esc(targetLabel(def)) + '</span>' +
          '</div>';
      }
      list.innerHTML = html || '<div class="hub-ch-empty">No active challenges</div>';
      txt('hub-ch-count', shown + ' ACTIVE');
    }
  }

  // live board on the pause screen
  function pauseBoard(match) {
    if (!match) return;
    var o = match.opts || {};
    var home = o.homeName || 'YOU', away = o.awayName || 'ROGUE';
    txt('pb-home', home); txt('pb-away', away);
    txt('pb-score', match.score[0] + ' – ' + match.score[1]);
    var modeName = 'QUICK MATCH';
    try {
      var d = LG.Modes.def(LG.Modes.id());
      if (d) modeName = LG.Modes.id() === 'tournament' && LG.Tournament ? 'STREET CUP · ' + LG.Tournament.roundLabel() : d.name;
    } catch (e) { /* keep default */ }
    var clk = match.clock != null && LG.Util && LG.Util.fmtTime ? ' · ' + LG.Util.fmtTime(Math.max(0, match.clock)) + ' LEFT' : '';
    txt('pause-k', modeName + clk);
    var h = (match.stats && match.stats.home) || {}, a = (match.stats && match.stats.away) || {};
    var rows = [['SHOTS', 'shots'], ['PASSES', 'passes'], ['TACKLES', 'tackles'], ['SAVES', 'saves']];
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var hv = h[rows[i][1]] || 0, av = a[rows[i][1]] || 0, sum = hv + av;
      var hp = sum ? Math.round(hv / sum * 100) : 50;
      html += '<div class="ps-row"><span class="ps-h">' + hv + '</span>' +
        '<span class="ps-mid"><span class="ps-l">' + rows[i][0] + '</span>' +
        '<span class="ps-bar"><i class="ps-hb" style="width:' + hp + '%"></i><i class="ps-ab" style="width:' + (100 - hp) + '%"></i></span></span>' +
        '<span class="ps-a">' + av + '</span></div>';
    }
    var pst = $('pause-stats');
    if (pst) pst.innerHTML = html;
    var tw = LG.Modes && LG.Modes.activeTwist ? LG.Modes.activeTwist() : null;
    var info = tw && LG.Modes.twistInfo ? LG.Modes.twistInfo(tw) : null;
    var tod = LG.Settings ? LG.Settings.timeOfDay().toUpperCase() : '';
    var wx = LG.Settings && LG.Settings.weather() === 'rain' ? ' · RAIN' : '';
    txt('pb-note', (info ? 'TWIST: ' + info.label + ' · ' : '') + tod + wx);
  }

  // the coin sum, line by line, on the full-time screen
  function resultCoins(r) {
    var box = $('res-coin-lines');
    if (!box || !LG.Progression || !LG.Progression.rewardBreakdown) return;
    var b = LG.Progression.rewardBreakdown(r.won, r.stats);
    var html = '';
    for (var i = 0; i < b.lines.length; i++) {
      var n = b.lines[i].n;
      html += '<div class="rc-line"><span>' + esc(b.lines[i].label) + '</span><b>' + (n >= 0 ? '+' : '−') + Math.abs(n) + '</b></div>';
    }
    box.innerHTML = html;
  }

  function bind() {
    var bus = LG.eventBus;
    var cup = $('hub-cup'), twist = $('hub-twist');
    if (cup) cup.addEventListener('click', function () {
      if (LG.Audio) { LG.Audio.unlock(); LG.Audio.sfx.click(); }
      bus.emit('playRequested');
      bus.emit('modeRequested', { id: 'tournament' });
      bus.emit('modeConfirmed');
    });
    if (twist) twist.addEventListener('click', function () {
      if (LG.Audio) { LG.Audio.unlock(); LG.Audio.sfx.click(); }
      bus.emit('playRequested');
      bus.emit('modeRequested', { id: 'street_twist' });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  return { refresh: refresh, pauseBoard: pauseBoard, resultCoins: resultCoins };
})();
