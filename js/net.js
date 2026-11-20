// ============================================================
// NET (Build 6) — FRIEND MATCH: play a friend online with a code.
//
// How it works (no game server needed):
//   * The HOST taps CREATE CODE and gets 6 characters. The friend types
//     them in and taps JOIN. The code is only used to find each other:
//     PeerJS's free public broker swaps the connection details, then the
//     two phones talk directly (WebRTC data channel).
//   * The host's phone runs the real match (the authority). The friend's
//     player on the ROGUE side is driven by the friend's stick/buttons,
//     sent ~30 times a second. The host sends the whole court back ~20
//     times a second; the friend's phone draws it 100 ms behind, smoothly
//     blended between snapshots, and replays goals, saves and specials.
//   * Transports: 'peer' (online, the default) and 'bc' (two tabs on the
//     same device via BroadcastChannel — used by the automated test).
// ============================================================
var LG = window.LG = window.LG || {};

LG.Net = (function () {
  var PROTO = 1;
  var PREFIX = 'blackout-b6-';
  var ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
  var SNAP_HZ = 20, INPUT_HZ = 30, DELAY = 0.1;

  var role = null;          // 'host' | 'guest' | null
  var tr = null;            // transport
  var code = '';
  var listeners = {};
  var status = 'idle';

  function emit(ev, d) { (listeners[ev] || []).forEach(function (f) { try { f(d); } catch (e) { if (window.console) console.warn('[NET] ' + e.message); } }); }
  function on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); }
  function setStatus(s, msg) { status = s; emit('status', { status: s, msg: msg || '' }); }

  function makeCode() {
    var c = '', a = new Uint32Array(6);
    try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < 6; j++) a[j] = Math.floor(Math.random() * 1e9); }
    for (var i = 0; i < 6; i++) c += ALPHA[a[i] % ALPHA.length];
    return c;
  }
  function cleanCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
  function transportKind() {
    try { var q = new URLSearchParams(location.search); if (q.get('net') === 'bc') return 'bc'; } catch (e) { /* default */ }
    return 'peer';
  }

  // ---------------- transports ----------------
  // Each: open(cb), send(obj), close(); calls handlers.msg / handlers.open / handlers.close
  function BCTransport(isHost, c, h) {
    var ch = new BroadcastChannel('blackout-net-' + c), me = Math.random().toString(36).slice(2), peer = null, closed = false;
    ch.onmessage = function (e) {
      var m = e.data;
      if (!m || m.from === me || closed) return;
      if (m.kind === 'hello' && isHost && !peer) { peer = m.from; ch.postMessage({ from: me, to: peer, kind: 'welcome' }); h.open(); return; }
      if (m.kind === 'welcome' && !isHost && m.to === me) { peer = m.from; h.open(); return; }
      if (m.kind === 'bye' && m.from === peer) { h.close('left'); return; }
      if (m.kind === 'msg' && m.from === peer) h.msg(m.data);
    };
    if (!isHost) {
      var tries = 0;
      (function knock() { if (peer || closed || tries++ > 40) { if (!peer && !closed) h.error('No match with that code.'); return; } ch.postMessage({ from: me, kind: 'hello' }); setTimeout(knock, 250); })();
    }
    return {
      send: function (d) { if (peer && !closed) ch.postMessage({ from: me, kind: 'msg', data: d }); },
      close: function () { if (closed) return; closed = true; try { ch.postMessage({ from: me, kind: 'bye' }); ch.close(); } catch (e) { /* gone */ } },
    };
  }

  function PeerTransport(isHost, c, h) {
    var peer = null, conn = null, closed = false;
    function wire(cn) {
      conn = cn;
      cn.on('open', function () { h.open(); });
      cn.on('data', function (d) { if (!closed) h.msg(d); });
      cn.on('close', function () { if (!closed) h.close('left'); });
      cn.on('error', function (e) { if (!closed) h.error((e && e.message) || 'Connection error'); });
    }
    function start() {
      try {
        if (isHost) {
          peer = new window.Peer(PREFIX + c);
          peer.on('open', function () { h.ready(); });
          peer.on('connection', function (cn) { if (conn) { cn.close(); return; } wire(cn); });
        } else {
          peer = new window.Peer();
          peer.on('open', function () { wire(peer.connect(PREFIX + c, { reliable: true, serialization: 'json' })); });
        }
        peer.on('error', function (e) {
          var t = e && e.type;
          h.error(t === 'peer-unavailable' ? 'No match with that code.' : t === 'unavailable-id' ? 'Code clash — create a new code.' :
            t === 'network' || t === 'server-error' || t === 'socket-error' ? 'Can’t reach the online service. Check your internet.' : ((e && e.message) || 'Online error'));
        });
      } catch (e) { h.error('Online play is not available on this browser.'); }
    }
    if (window.Peer) start();
    else {
      var s = document.createElement('script');
      s.src = 'lib/peerjs.min.js';
      s.onload = start;
      s.onerror = function () { h.error('Could not load the online library.'); };
      document.head.appendChild(s);
    }
    return {
      send: function (d) { if (conn && conn.open && !closed) { try { conn.send(d); } catch (e) { /* dropped frame */ } } },
      close: function () { if (closed) return; closed = true; try { if (conn) conn.close(); if (peer) peer.destroy(); } catch (e) { /* gone */ } },
    };
  }

  function openTransport(isHost, c) {
    var handlers = {
      ready: function () { setStatus('waiting', 'Waiting for your friend…'); },
      open: function () { setStatus('connected', 'Connected'); emit('open', {}); if (!isHost) send({ t: 'hello', v: PROTO, star: myStar(), kit: myKit() }); },
      msg: function (d) { onMessage(d); },
      close: function (why) { setStatus('closed', 'Your friend left.'); emit('closed', { why: why }); },
      error: function (msg) { setStatus('error', msg); emit('error', { msg: msg }); },
    };
    return transportKind() === 'bc' ? BCTransport(isHost, c, handlers) : PeerTransport(isHost, c, handlers);
  }

  function send(d) { if (tr) tr.send(d); }

  // ---------------- session ----------------
  function myStar() { return (LGMain && LGMain.selections && LGMain.selections().star) || 'blaze'; }
  function myKit() { return (LGMain && LGMain.selections && LGMain.selections().kit) || null; }

  function host() {
    leave();
    role = 'host';
    code = makeCode();
    setStatus(transportKind() === 'bc' ? 'waiting' : 'opening', transportKind() === 'bc' ? 'Waiting for your friend…' : 'Opening a room…');
    tr = openTransport(true, code);
    return code;
  }
  function join(c) {
    c = cleanCode(c);
    if (c.length !== 6) { setStatus('error', 'Codes are 6 characters.'); return false; }
    leave();
    role = 'guest'; code = c;
    setStatus('joining', 'Looking for ' + c + '…');
    tr = openTransport(false, c);
    return true;
  }
  function leave() {
    if (tr) { try { send({ t: 'bye' }); tr.close(); } catch (e) { /* gone */ } }
    tr = null; role = null; code = '';
    remote = null; snaps = []; guestCtrl = null;
    setStatus('idle', '');
  }

  // ---------------- messages ----------------
  function onMessage(d) {
    if (!d || !d.t) return;
    if (d.t === 'hello' && role === 'host') {
      if (d.v !== PROTO) { send({ t: 'err', msg: 'Your friend has a different version. Both reload the game.' }); return; }
      var setup = LGMain.onlineSetup(d.star, d.kit);
      send({ t: 'setup', setup: setup });
      emit('start', { role: 'host', setup: setup });
    } else if (d.t === 'setup' && role === 'guest') {
      emit('start', { role: 'guest', setup: d.setup });
    } else if (d.t === 'err') {
      setStatus('error', d.msg);
    } else if (d.t === 'i' && role === 'host' && remote) {
      remote.take(d);
    } else if (d.t === 's' && role === 'guest') {
      snaps.push(d);
      if (snaps.length > 30) snaps.shift();
    } else if (d.t === 'e' && role === 'guest' && guestCtrl) {
      guestCtrl.event(d);
    } else if (d.t === 'bye') {
      setStatus('closed', 'Your friend left.'); emit('closed', { why: 'left' });
    }
  }

  // ---------------- HOST side ----------------
  // the friend's controls, as an input source for Match.resolveHuman
  var remote = null;
  function RemoteInput() {
    this.mx = 0; this.mz = 0; this.held = {}; this.pending = {}; this.edge = {};
  }
  RemoteInput.prototype = {
    take: function (d) {
      this.mx = +d.mx || 0; this.mz = +d.mz || 0;
      this.held = { sprint: !!d.sp, shoot: !!d.sh };
      var pr = d.pr || {};
      for (var k in pr) this.pending[k] = (this.pending[k] || 0) + (pr[k] | 0);
    },
    frame: function () {           // once per host frame: release one edge per button
      this.edge = {};
      for (var k in this.pending) if (this.pending[k] > 0) { this.edge[k] = true; this.pending[k]--; }
    },
    worldMove: function () { return { x: this.mx, z: this.mz }; },
    moveVec: function () { return { x: 0, y: 0 }; },
    down: function (n) { return !!this.held[n]; },
    pressed: function (n) { return !!this.edge[n]; },
  };

  // controller for the HOST's match: plays normally, streams it out
  function HostCtrl(m) {
    this.kind = 'online-host';
    this.t = 0; this.seq = 0;
    var guest = m.away[0];
    remote = new RemoteInput();
    guest.isHuman = true; guest.ai = null; guest.inputSrc = remote;
    guest.setSelected && guest.setSelected(true);
    var self = this;
    this.unsub = [];
    // forward the events the friend's screen needs to replay
    ['goal', 'keeperSave', 'abilityActivated', 'shoot', 'pass', 'tackleWin', 'goldenGoal', 'matchEnd', 'keeperDive', 'rumbleOrb'].forEach(function (ev) {
      var f = function (e) { self.forward(m, ev, e); };
      m.bus.on(ev, f);
      self.unsub.push([ev, f]);
    });
  }
  HostCtrl.prototype = {
    idx: function (m, p) { return p ? m.all.indexOf(p) : -1; },
    forward: function (m, ev, e) {
      if (role !== 'host') return;
      var d = { t: 'e', ev: ev };
      if (ev === 'goal') { d.team = e.team; d.scorer = this.idx(m, e.scorer); d.score = m.score.slice(); }
      else if (ev === 'keeperSave') { d.gk = this.idx(m, e.gk); d.parry = !!e.parry; }
      else if (ev === 'abilityActivated') { d.p = this.idx(m, e); d.id = e.active && e.active.id; }
      else if (ev === 'shoot') { d.p = this.idx(m, e.player); }
      else if (ev === 'pass') { d.p = this.idx(m, e.src); }
      else if (ev === 'tackleWin') { d.p = this.idx(m, e.src); }
      else if (ev === 'keeperDive') { d.gk = this.idx(m, e.gk); d.side = e.side; }
      else if (ev === 'rumbleOrb') { d.p = this.idx(m, e.player); d.id = e.ability; }
      else if (ev === 'matchEnd') { d.score = e.score; d.stats = e.stats; d.mode = e.mode; d.summary = e.summary || null; }
      send(d);
    },
    update: function (m, dt) {
      if (remote) remote.frame();
      this.t += dt;
      if (this.t >= 1 / SNAP_HZ) { this.t = 0; send(snapshot(m, ++this.seq)); }
      return false;              // the match runs as normal
    },
    stop: function () { remote = null; },
  };

  function q(v) { return Math.round(v * 100) / 100; }
  function snapshot(m, seq) {
    var P = [];
    for (var i = 0; i < m.all.length; i++) {
      var p = m.all[i];
      var fl = (p.hasBall ? 1 : 0) | (p.sprinting ? 2 : 0) | (p.meterFull ? 4 : 0) | (p.stun > 0 ? 8 : 0);
      P.push([q(p.x), q(p.z), q(p.vx), q(p.vz), q(p.facing), fl, q(p.meter), q(p.kickAnim), q(p.tackleAnim), q(p.stamina), p.active ? p.active.id : 0, q(p.y || 0)]);
    }
    var b = m.ball;
    return { t: 's', k: seq, c: q(m.clock), sc: m.score.slice(), st: m.state, gg: m.goldenGoal ? 1 : 0,
      b: [q(b.x), q(b.y), q(b.z), b.owner ? m.all.indexOf(b.owner) : -1], p: P };
  }

  // ---------------- GUEST side ----------------
  var snaps = [];
  var guestCtrl = null;
  function GuestCtrl(m) {
    this.kind = 'online-guest';
    this.noProgress = false;
    this.clock0 = 0; this.inT = 0;
    this.press = { pass: 0, shoot: 0, special: 0, tackle: 0, switch: 0 };
    this.lastScore = [0, 0];
    this.renderT = 0; this.baseLocal = null; this.baseSeq = 0;
    guestCtrl = this;
    snaps = [];
    this.me = m.away[0];
  }
  GuestCtrl.prototype = {
    start: function (m) {
      for (var i = 0; i < m.all.length; i++) { m.all[i].ai = null; m.all[i].isHuman = false; }
      m.active = this.me;
      for (var j = 0; j < m.all.length; j++) if (m.all[j].setSelected) m.all[j].setSelected(m.all[j] === this.me);
      m.state = 'KICKOFF';
    },
    // the frame to draw: DELAY seconds behind the newest snapshot
    pick: function () {
      if (!snaps.length) return null;
      var newest = snaps[snaps.length - 1];
      var target = newest.k - DELAY * SNAP_HZ;
      var a = snaps[0], b = snaps[0];
      for (var i = 0; i < snaps.length; i++) {
        if (snaps[i].k <= target) a = snaps[i];
        if (snaps[i].k >= target) { b = snaps[i]; break; }
        b = snaps[i];
      }
      var u = b.k === a.k ? 1 : Math.max(0, Math.min(1, (target - a.k) / (b.k - a.k)));
      return { a: a, b: b, u: u };
    },
    update: function (m, dt) {
      this.sendInput(m, dt);
      var f = this.pick();
      if (!f) { m.updatePlayers(0); return true; }
      // advance the target time smoothly (snapshot seq numbers are 1/20 s)
      var A = f.a, B = f.b, u = f.u, L = function (x, y) { return x + (y - x) * u; };
      for (var i = 0; i < m.all.length; i++) {
        var p = m.all[i], pa = A.p[i], pb = B.p[i];
        if (!pa || !pb) continue;
        var x = L(pa[0], pb[0]), z = L(pa[1], pb[1]);
        var df = pb[4] - pa[4]; df = Math.atan2(Math.sin(df), Math.cos(df));
        p.vx = L(pa[2], pb[2]); p.vz = L(pa[3], pb[3]);
        p.hasBall = !!(pb[5] & 1); p.sprinting = !!(pb[5] & 2);
        p.meter = pb[6]; p.meterFull = !!(pb[5] & 4); p.stun = (pb[5] & 8) ? 0.2 : 0;
        if (pb[7] > p.kickAnim + 0.3) p.kickAnim = pb[7];
        if (pb[8] > p.tackleAnim + 0.3) p.tackleAnim = pb[8];
        p.stamina = pb[9];
        if (pb[10] && !p.active) { var ad = LG.Abilities[pb[10]]; if (ad) { p.active = { type: pb[10], id: pb[10], t: 0.3 }; p.activeColor = ad.color; } }
        else if (!pb[10] && p.active) { p.active = null; if (p.auraMesh) p.auraMesh.visible = false; }
        if (p.active) p.active.t = 0.3;               // the host decides when it ends
        p.want.x = 0; p.want.z = 0;
        p.x = x; p.z = z; p.y = L(pa[11] || 0, pb[11] || 0);
        p.update(0.0001 + 0 * dt);                    // rig + ring + carried ball, no movement
        // the rig's own clock: advance the animation by the real frame time
        if (p.model && p.model.anim && p.model.anim.update) { try { p.model.anim.update(dt, p); } catch (e) { /* rig fallback */ } }
        p.facing = pa[4] + df * u;
        p.x = x; p.z = z;
        if (p.model && p.model.group) { p.model.group.position.set(x, p.y, z); p.model.group.rotation.y = p.facing; }
      }
      var ba = A.b, bb = B.b, ball = m.ball;
      ball.x = L(ba[0], bb[0]); ball.y = L(ba[1], bb[1]); ball.z = L(ba[2], bb[2]);
      ball.owner = bb[3] >= 0 ? m.all[bb[3]] : null;
      if (ball.mesh) ball.mesh.position.set(ball.x, ball.y, ball.z);
      // clock, score, state
      if (B.c !== this.clock0) { this.clock0 = B.c; m.clock = B.c; m.bus.emit('clock', { t: B.c }); }
      m.score = B.sc.slice();
      var prevState = m.state;
      m.state = B.st;
      if (prevState !== m.state) m.bus.emit('state', { state: m.state });
      if (m.state === 'GOAL' && LG.Celebration) LG.Celebration.update(m, dt);
      return true;
    },
    sendInput: function (m, dt) {
      var I = LG.Input;
      var pr = this.press;
      ['pass', 'shoot', 'special', 'tackle', 'switch'].forEach(function (k) { if (I.pressed(k)) pr[k]++; });
      this.inT += dt;
      if (this.inT < 1 / INPUT_HZ) return;
      this.inT = 0;
      var wv = m.screenToWorldMove(I.moveVec());
      send({ t: 'i', mx: q(wv.x), mz: q(wv.z), sp: I.down('sprint') ? 1 : 0, sh: (I.down('shoot') || I.pressed('shoot')) ? 1 : 0, pr: pr });
      this.press = { pass: 0, shoot: 0, special: 0, tackle: 0, switch: 0 };
    },
    // replay a host event on this screen
    event: function (d) {
      var m = LG.Match;
      if (!m || m.ctrl !== this) return;
      var P = function (i) { return i >= 0 ? m.all[i] : null; };
      switch (d.ev) {
        case 'goal':
          m.score = d.score;
          m.bus.emit('goal', { team: d.team, scorer: P(d.scorer), score: d.score });
          break;
        case 'keeperSave': m.bus.emit('keeperSave', { gk: P(d.gk), parry: d.parry }); break;
        case 'keeperDive': if (LG.KeeperMotion && P(d.gk)) LG.KeeperMotion.start(P(d.gk), 'dive', { side: d.side, reach: 0.8 }); break;
        case 'abilityActivated': {
          var p = P(d.p);
          if (p && d.id && LG.Abilities[d.id]) { p.active = { type: d.id, id: d.id, t: 0.3 }; p.activeColor = LG.Abilities[d.id].color; m.bus.emit('abilityActivated', p); }
          break;
        }
        case 'shoot': if (LG.Audio && LG.Audio.sfx && LG.Audio.sfx.kick) LG.Audio.sfx.kick(0.8); break;
        case 'tackleWin': m.bus.emit('tackleWin', { src: P(d.p) }); break;
        case 'goldenGoal': m.bus.emit('goldenGoal', {}); break;
        case 'rumbleOrb': if (LG.HUD) LG.HUD.toast((P(d.p) === this.me ? 'YOU' : (P(d.p) || {}).name) + ' GOT ' + (LG.Abilities[d.id] || {}).label, 1400); break;
        case 'matchEnd': this.finish(m, d); break;
      }
    },
    finish: function (m, d) {
      if (m._finalized) return;
      m._finalized = true;
      m.state = 'END';
      // the result from THIS side: the friend is the away team
      var s = d.score || m.score, st = d.stats || { home: {}, away: {} };
      var won = s[1] > s[0] ? 1 : s[1] < s[0] ? -1 : 0;
      var result = { score: [s[1], s[0]], won: won, coins: 0, activeName: this.me.name, homeName: 'YOU', awayName: 'FRIEND',
        difficulty: '', court: (LG.Courts && LG.Courts.selected()) || '', playTime: 0, ts: Date.now(),
        stats: { home: st.away, away: st.home }, mode: 'friend_match', online: true, summary: d.summary };
      if (LG.Progression && LG.Progression.finalizeMatch) result = LG.Progression.finalizeMatch(result) || result;
      result.online = true;
      m.bus.emit('matchEnd', result);
    },
    stop: function () { guestCtrl = null; },
  };

  return {
    host: host, join: join, leave: leave, on: on, send: send,
    role: function () { return role; }, code: function () { return code; }, status: function () { return status; },
    cleanCode: cleanCode, makeCode: makeCode, transport: transportKind,
    HostCtrl: HostCtrl, GuestCtrl: GuestCtrl, snapshot: snapshot, RemoteInput: RemoteInput,
    _snaps: function () { return snaps; },
  };
})();
