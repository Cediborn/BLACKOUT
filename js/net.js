// ============================================================
// NET — FRIEND MATCH: play a friend online with a code.
// (Build 6 link, Build 7 smooth-sync rewrite)
//
// Link: the HOST taps CREATE CODE (6 characters); the friend types it and
// taps JOIN. PeerJS's free broker only swaps connection details; the match
// then runs phone to phone over WebRTC data channels:
//   'ev' reliable + ordered   hello / setup / goals / saves / full time
//   'rt' unreliable           snapshots and inputs (a late one is useless,
//                             so it is never re-sent and never blocks)
//
// Authority: the host's phone runs the real match. The friend's star (the
// away side's #1) is driven by a RemoteInput. Build 7 sync model:
//   * SNAPSHOTS carry the host clock (ts) and the last friend-input number
//     the host applied (ack). Full snapshots (meters, kicks, stamina) go
//     out at 5 Hz, light ones (position/velocity/facing/flags) at 20 Hz.
//   * The friend's phone keeps a RENDER CLOCK that runs at real time and
//     is nudged — never jumped — toward "host time minus a small buffer".
//     The buffer adapts to the measured jitter (80–250 ms). Bodies are
//     drawn at that time, blended between the two snapshots around it.
//     If snapshots stop (a hiccup), it EXTRAPOLATES along the last
//     velocity for up to 0.3 s, then eases to a stop: no freeze-then-jump.
//   * CLIENT-SIDE PREDICTION: the friend's OWN star moves on their phone
//     the instant the stick moves (the same Player physics the host runs).
//     Every input is numbered; when a snapshot says "applied up to #n",
//     the phone compares the host's position with what it predicted at
//     #n and bleeds the difference out over ~0.25 s (big gaps from a
//     tackle or a goal reset snap at once).
//   * Animations read the drawn velocities, so legs always match motion.
//   * Weak link: a WEAK SIGNAL chip after 0.6 s without data; the host
//     lets go of the friend's stick after 0.5 s without input (no runaway
//     player); after 8 s without anything the match ends cleanly.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Net = (function () {
  var PROTO = 2;
  var PREFIX = 'blackout-b6-';
  var ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var SNAP_HZ = 20, FULL_EVERY = 4, INPUT_HZ = 30, IDLE_INPUT_HZ = 8;

  var role = null, tr = null, code = '', status = 'idle', listeners = {};

  function emit(ev, d) { (listeners[ev] || []).forEach(function (f) { try { f(d); } catch (e) { if (window.console) console.warn('[NET] ' + e.message); } }); }
  function on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); }
  function setStatus(s, msg) { status = s; emit('status', { status: s, msg: msg || '' }); }
  function now() { return performance.now() / 1000; }

  function makeCode() {
    var c = '', a = new Uint32Array(6);
    try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < 6; j++) a[j] = Math.floor(Math.random() * 1e9); }
    for (var i = 0; i < 6; i++) c += ALPHA[a[i] % ALPHA.length];
    return c;
  }
  function cleanCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
  function query() { try { return new URLSearchParams(location.search); } catch (e) { return { get: function () { return null; } }; } }
  function transportKind() { return query().get('net') === 'bc' ? 'bc' : 'peer'; }

  // ---------------- transports ----------------
  // send(data, realtime): realtime messages may be dropped/reordered.
  // BC (same-device test link) can simulate a bad network with
  // ?lag=ms&jitter=ms&loss=percent — realtime messages only.
  function BCTransport(isHost, c, h) {
    var ch = new BroadcastChannel('blackout-net-' + c), me = Math.random().toString(36).slice(2), peer = null, closed = false;
    var Q = query(), lag = +(Q.get('lag') || 0) / 1000, jit = +(Q.get('jitter') || 0) / 1000, loss = +(Q.get('loss') || 0) / 100;
    ch.onmessage = function (e) {
      var m = e.data;
      if (!m || m.from === me || closed) return;
      if (m.kind === 'hello' && isHost && !peer) { peer = m.from; ch.postMessage({ from: me, to: peer, kind: 'welcome' }); h.open(); return; }
      if (m.kind === 'welcome' && !isHost && m.to === me) { peer = m.from; h.open(); return; }
      if (m.kind === 'bye' && m.from === peer) { h.close('left'); return; }
      if (m.kind === 'msg' && m.from === peer) {
        if (m.rt && (lag || jit || loss)) {
          if (Math.random() < loss) return;
          setTimeout(function () { if (!closed) h.msg(m.data); }, (lag + Math.random() * jit) * 1000);
        } else h.msg(m.data);
      }
    };
    if (!isHost) {
      var tries = 0;
      (function knock() { if (peer || closed || tries++ > 40) { if (!peer && !closed) h.error('No match with that code.'); return; } ch.postMessage({ from: me, kind: 'hello' }); setTimeout(knock, 250); })();
    }
    return {
      send: function (d, rt) { if (peer && !closed) ch.postMessage({ from: me, kind: 'msg', data: d, rt: !!rt }); },
      close: function () { if (closed) return; closed = true; try { ch.postMessage({ from: me, kind: 'bye' }); ch.close(); } catch (e) { /* gone */ } },
    };
  }

  function PeerTransport(isHost, c, h) {
    var peer = null, ev = null, rt = null, closed = false, opened = false;
    function wire(cn) {
      var isRt = cn.label === 'rt';
      if (isRt) rt = cn; else ev = cn;
      cn.on('open', function () { if (!isRt && !opened) { opened = true; h.open(); } });
      cn.on('data', function (d) { if (!closed) h.msg(d); });
      cn.on('close', function () { if (!closed && !isRt) h.close('left'); });
      cn.on('error', function (e) { if (!closed && !isRt) h.error((e && e.message) || 'Connection error'); });
    }
    function start() {
      try {
        if (isHost) {
          peer = new window.Peer(PREFIX + c);
          peer.on('open', function () { h.ready(); });
          peer.on('connection', function (cn) {
            if ((cn.label === 'rt' && rt) || (cn.label !== 'rt' && ev)) { cn.close(); return; }
            wire(cn);
          });
        } else {
          peer = new window.Peer();
          peer.on('open', function () {
            wire(peer.connect(PREFIX + c, { label: 'ev', reliable: true, serialization: 'json' }));
            wire(peer.connect(PREFIX + c, { label: 'rt', reliable: false, serialization: 'json' }));
          });
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
      send: function (d, realtime) {
        if (closed) return;
        var cn = realtime && rt && rt.open ? rt : ev;   // fall back to the reliable link
        if (cn && cn.open) { try { cn.send(d); } catch (e) { /* dropped frame */ } }
      },
      close: function () { if (closed) return; closed = true; try { if (ev) ev.close(); if (rt) rt.close(); if (peer) peer.destroy(); } catch (e) { /* gone */ } },
    };
  }

  function openTransport(isHost, c) {
    var handlers = {
      ready: function () { setStatus('waiting', 'Waiting for your friend…'); },
      open: function () { setStatus('connected', 'Connected'); emit('open', {}); if (!isHost) send({ t: 'hello', v: PROTO, star: myStar(), kit: myKit() }); },
      msg: function (d) { lastRecv = now(); onMessage(d); },
      close: function (why) { setStatus('closed', 'Your friend left.'); emit('closed', { why: why }); },
      error: function (msg) { setStatus('error', msg); emit('error', { msg: msg }); },
    };
    return transportKind() === 'bc' ? BCTransport(isHost, c, handlers) : PeerTransport(isHost, c, handlers);
  }

  var lastRecv = 0;
  function send(d, realtime) { if (tr) tr.send(d, realtime); }

  function myStar() { return (window.LGMain && LGMain.selections && LGMain.selections().star) || 'blaze'; }
  function myKit() { return (window.LGMain && LGMain.selections && LGMain.selections().kit) || null; }

  function host() {
    leave();
    role = 'host'; code = makeCode();
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
    remote = null; guestCtrl = null; buf = [];
    setStatus('idle', '');
  }

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
      ingest(d);
    } else if (d.t === 'e' && role === 'guest' && guestCtrl) {
      guestCtrl.event(d);
    } else if (d.t === 'bye') {
      setStatus('closed', 'Your friend left.'); emit('closed', { why: 'left' });
    }
  }

  // ================= HOST =================
  var remote = null;
  function RemoteInput() {
    this.mx = 0; this.mz = 0; this.held = {}; this.edge = {}; this.pending = {};
    this.seq = 0; this.last = now();
  }
  RemoteInput.prototype = {
    take: function (d) {
      if (d.q <= this.seq) return;                  // late / duplicate on the unreliable link
      this.seq = d.q; this.last = now();
      this.mx = +d.mx || 0; this.mz = +d.mz || 0;
      this.held = { sprint: !!d.sp, shoot: !!d.sh, skill: !!d.sk };
      // presses carry a running count, so a dropped packet loses none
      var pr = d.pr || {};
      for (var k in pr) {
        var tot = pr[k] | 0, seen = (this._seen && this._seen[k]) || 0;
        if (tot > seen) this.pending[k] = (this.pending[k] || 0) + (tot - seen);
        (this._seen = this._seen || {})[k] = Math.max(seen, tot);
      }
    },
    frame: function () {
      this.edge = {};
      for (var k in this.pending) if (this.pending[k] > 0) { this.edge[k] = true; this.pending[k]--; }
      if (now() - this.last > 0.5) { this.mx = 0; this.mz = 0; this.held = {}; }   // link stalled: let go
    },
    worldMove: function () { return { x: this.mx, z: this.mz }; },
    moveVec: function () { return { x: 0, y: 0 }; },
    down: function (n) { return !!this.held[n]; },
    pressed: function (n) { return !!this.edge[n]; },
  };

  function HostCtrl(m) {
    this.kind = 'online-host';
    this.t = 0; this.seq = 0; this.clock = 0;
    var guest = m.away[0];
    remote = new RemoteInput();
    guest.isHuman = true; guest.ai = null; guest.inputSrc = remote;
    if (guest.setSelected) guest.setSelected(true);
    var self = this;
    ['goal', 'keeperSave', 'abilityActivated', 'shoot', 'pass', 'tackleWin', 'goldenGoal', 'matchEnd', 'keeperDive', 'rumbleOrb', 'skillMove'].forEach(function (ev) {
      m.bus.on(ev, function (e) { if (LG.Match === m) self.forward(m, ev, e); });
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
      else if (ev === 'skillMove') { d.p = this.idx(m, e.player); d.id = e.id; d.dir = e.dir; }
      else if (ev === 'matchEnd') { d.score = e.score; d.stats = e.stats; d.mode = e.mode; d.summary = e.summary || null; }
      send(d, false);
    },
    update: function (m, dt) {
      if (remote) remote.frame();
      this.clock += dt;
      this.t += dt;
      if (this.t >= 1 / SNAP_HZ) {
        this.t -= 1 / SNAP_HZ;
        if (this.t > 1 / SNAP_HZ) this.t = 0;
        this.seq++;
        // stamped with the host's REAL clock: the friend renders in real
        // time, so a slow host frame must not bend the timeline
        if (this.t0 === undefined) this.t0 = now();
        send(snapshot(m, this.seq, now() - this.t0, this.seq % FULL_EVERY === 0, remote ? remote.seq : 0), true);
      }
      return false;
    },
    stop: function () { remote = null; },
  };

  function q2(v) { return Math.round(v * 100) / 100; }
  function q3(v) { return Math.round(v * 1000) / 1000; }
  function snapshot(m, seq, ts, full, ack) {
    var P = [];
    for (var i = 0; i < m.all.length; i++) {
      var p = m.all[i];
      var fl = (p.hasBall ? 1 : 0) | (p.sprinting ? 2 : 0) | (p.meterFull ? 4 : 0) | (p.stun > 0 ? 8 : 0);
      var row = [q2(p.x), q2(p.z), q2(p.vx), q2(p.vz), q2(p.facing), fl, q2(p.y || 0)];
      if (full) row.push(q2(p.meter), q2(p.stamina), p.active ? p.active.id : 0);
      row.push(p.kickAnim > 0.85 ? 1 : 0, p.tackleAnim > 0.9 ? 1 : 0, p._skill ? p._skill.id : 0);
      P.push(row);
    }
    var b = m.ball;
    return { t: 's', k: seq, ts: q3(ts), a: ack, f: full ? 1 : 0, c: q2(m.clock), sc: m.score, st: m.state,
      b: [q2(b.x), q2(b.y), q2(b.z), q2(b.vx), q2(b.vy), q2(b.vz), b.owner ? m.all.indexOf(b.owner) : -1], p: P };
  }

  // ================= GUEST =================
  var buf = [];                 // snapshots, sorted by host time
  var guestCtrl = null;
  var clockOff = null;          // host time - local time (best estimate)
  var jitter = 0.02, lastArr = 0, lastTs = 0, spacing = 1 / SNAP_HZ;

  function ingest(d) {
    var t = now();
    // host->local clock offset: track the FASTEST observed arrival (min
    // latency), drifting slowly so a long stall cannot drag it
    var off = d.ts - t;
    if (clockOff === null || off > clockOff) clockOff = off;
    else clockOff += (off - clockOff) * 0.02;
    // jitter = how irregular arrivals are versus the host spacing
    if (lastArr) {
      var dev = Math.abs((t - lastArr) - (d.ts - lastTs));
      jitter += (Math.min(dev, 0.3) - jitter) * 0.1;
      // the real snapshot spacing (a struggling host sends less often)
      var gap = d.ts - lastTs;
      if (gap > 0 && gap < 1) spacing += (gap - spacing) * 0.1;
    }
    lastArr = t; lastTs = d.ts;
    // keep the latest full fields on light snapshots (meters etc.)
    if (!d.f && buf.length) { var prev = buf[buf.length - 1]; d.fullRef = prev.f ? prev : prev.fullRef; }
    // unreliable link: insert in host-time order, drop exact repeats
    var i = buf.length;
    while (i > 0 && buf[i - 1].ts > d.ts) i--;
    if (i > 0 && buf[i - 1].k === d.k) return;
    buf.splice(i, 0, d);
    if (buf.length > 40) buf.shift();
    if (guestCtrl) guestCtrl.onSnapshot(d);
  }

  function GuestCtrl(m) {
    this.kind = 'online-guest';
    this.renderT = null; this.inT = 0; this.idleT = 0;
    this.press = { pass: 0, shoot: 0, special: 0, tackle: 0, switch: 0, skill: 0 };
    this.inSeq = 0; this.hist = [];      // predicted positions per input number
    this.err = { x: 0, z: 0 };           // reconciliation error still to bleed out
    this.lastMove = { x: 0, z: 0 }; this.lastSent = '';
    this.stats = { frames: 0, snaps: 0, extrap: 0, starve: 0, snapCorr: 0, maxCorr: 0 };
    guestCtrl = this;
    buf = []; clockOff = null; jitter = 0.02; lastArr = 0; lastTs = 0; spacing = 1 / SNAP_HZ;
    this.me = m.away[0];
  }
  GuestCtrl.prototype = {
    start: function (m) {
      for (var i = 0; i < m.all.length; i++) { m.all[i].ai = null; m.all[i].isHuman = false; }
      m.active = this.me;
      for (var j = 0; j < m.all.length; j++) if (m.all[j].setSelected) m.all[j].setSelected(m.all[j] === this.me);
      m.state = 'KICKOFF';
    },
    // buffer = a bit more than one snapshot gap + the jitter margin
    delay: function () { return Math.max(0.08, Math.min(0.4, spacing * 1.3 + jitter * 2.5)); },

    onSnapshot: function (d) {
      this.stats.snaps++;
      // reconcile MY star: host position at input #ack vs my prediction then
      var me = this.me, row = d.p[this.idxMe()];
      if (!row) return;
      var h = null;
      for (var i = this.hist.length - 1; i >= 0; i--) if (this.hist[i].q === d.a) { h = this.hist[i]; break; }
      if (!h && d.a === 0) h = { x: me.x, z: me.z };
      while (this.hist.length && this.hist[0].q < d.a) this.hist.shift();
      if (!h) return;
      var ex = row[0] - h.x, ez = row[1] - h.z, e = Math.sqrt(ex * ex + ez * ez);
      this.stats.maxCorr = Math.max(this.stats.maxCorr, e);
      if (e > 2.5) {          // a tackle, a reset, a goal: trust the host now
        me.x = row[0]; me.z = row[1]; this.err.x = 0; this.err.z = 0; this.hist = []; this.stats.snapCorr++;
      } else if (e > 0.03) {
        // fold the error into the bleed: move the history too, so the same
        // error is not applied twice by the next snapshot
        this.err.x += ex; this.err.z += ez;
        for (var k = 0; k < this.hist.length; k++) { this.hist[k].x += ex; this.hist[k].z += ez; }
      }
    },
    idxMe: function () { var m = LG.Match; return m ? m.all.indexOf(this.me) : 0; },

    // two snapshots around render time t (or the newest, to extrapolate)
    sample: function (t) {
      if (!buf.length) return null;
      if (t <= buf[0].ts) return { a: buf[0], b: buf[0], u: 0, ex: 0 };
      for (var i = 0; i < buf.length - 1; i++) {
        if (buf[i].ts <= t && buf[i + 1].ts >= t) {
          var span = buf[i + 1].ts - buf[i].ts;
          return { a: buf[i], b: buf[i + 1], u: span > 0 ? (t - buf[i].ts) / span : 1, ex: 0 };
        }
      }
      var last = buf[buf.length - 1];
      return { a: last, b: last, u: 1, ex: Math.min(0.5, t - last.ts) };
    },

    update: function (m, dt) {
      this.stats.frames++;
      this.predict(m, dt);
      if (!buf.length || clockOff === null) { m.updatePlayers(0); return true; }
      // RENDER CLOCK: real-time, nudged toward host time minus the buffer
      var target = now() + clockOff - this.delay();
      if (this.renderT === null || Math.abs(target - this.renderT) > 0.6) this.renderT = target;
      else this.renderT += dt + (target - this.renderT) * Math.min(1, dt * 1.5);
      while (buf.length > 3 && buf[1].ts < this.renderT - 1) buf.shift();   // keep ~1 s of history
      var S = this.sample(this.renderT);
      if (!S) return true;
      if (S.ex > 0) this.stats.extrap++;
      var weak = now() - lastRecv > 0.6;
      if (weak !== this._weak) { this._weak = weak; if (LG.HUD && LG.HUD.toast && weak) LG.HUD.toast('WEAK SIGNAL', 900); setWeak(weak); }
      this.apply(m, S, dt);
      return true;
    },

    apply: function (m, S, dt) {
      var A = S.a, B = S.b, u = S.u, ex = S.ex;
      // past the newest snapshot: run forward on velocity, easing off
      // velocity fades out over 0.5 s, so a long gap ends in a gentle stop
      var exk = ex > 0 ? Math.max(0, 1 - ex / 0.5) * 0.5 + 0.5 * Math.max(0, 1 - ex / 0.5) : 0;
      var meIdx = m.all.indexOf(this.me);
      var fullA = A.f ? A : A.fullRef;
      for (var i = 0; i < m.all.length; i++) {
        var p = m.all[i], pa = A.p[i], pb = B.p[i];
        if (!pa || !pb) continue;
        var vx = pa[2] + (pb[2] - pa[2]) * u, vz = pa[3] + (pb[3] - pa[3]) * u;
        if (i !== meIdx) {
          var x = pa[0] + (pb[0] - pa[0]) * u + vx * ex * exk;
          var z = pa[1] + (pb[1] - pa[1]) * u + vz * ex * exk;
          // VISUAL CONTINUITY: if the sampled spot jumps further than this
          // body could move in one frame (a late burst after a stall, a
          // reordered packet), keep drawing from where it was and glide the
          // difference away over ~0.2 s instead of popping
          var o = p._netOff || (p._netOff = { x: 0, z: 0, init: false });
          if (o.init) {
            var sp = Math.sqrt(vx * vx + vz * vz), lim = Math.max(sp * dt * 1.8, 0.03) + 0.03;
            var dx = x + o.x - p.x, dz = z + o.z - p.z, jump = Math.sqrt(dx * dx + dz * dz);
            if (jump > lim && jump < 8) { o.x = p.x - x; o.z = p.z - z; }
            else if (jump >= 8) { o.x = 0; o.z = 0; }       // a real reset (kickoff): snap
          }
          o.init = true;
          // glide: fast enough to close in ~0.2 s, but never faster than the
          // body itself plus a bit, so the catch-up never reads as a jump
          var om = Math.sqrt(o.x * o.x + o.z * o.z);
          if (om > 0) {
            var cut = Math.min(om, Math.max(om * (1 - Math.exp(-dt * 10)), 0) );
            cut = Math.min(cut, Math.sqrt(vx * vx + vz * vz) * dt * 0.9 + 0.012);
            var kk = (om - cut) / om;
            o.x *= kk; o.z *= kk;
          }
          x += o.x; z += o.z;
          var df = pb[4] - pa[4]; df = Math.atan2(Math.sin(df), Math.cos(df));
          p.vx = vx * (ex > 0 ? exk : 1); p.vz = vz * (ex > 0 ? exk : 1);
          p.x = x; p.z = z;
          p.facing = pa[4] + df * u;
        }
        var fl = pb[5];
        p.hasBall = !!(fl & 1); p.sprinting = !!(fl & 2); p.meterFull = !!(fl & 4); p.stun = (fl & 8) ? 0.2 : 0;
        p.y = pa[6] + (pb[6] - pa[6]) * u;
        var full = fullA && fullA.p[i];
        if (full && full.length > 10) {
          p.meter = full[7]; p.stamina = full[8];
          var act = full[9];
          if (act && !p.active && LG.Abilities[act]) { p.active = { type: act, id: act, t: 0.3 }; p.activeColor = LG.Abilities[act].color; }
          else if (!act && p.active) { p.active = null; if (p.auraMesh) p.auraMesh.visible = false; }
        }
        if (p.active) p.active.t = 0.3;
        var tail = pb.slice(-3);
        if (tail[0] && p.kickAnim < 0.5) p.kickAnim = 1;
        if (tail[1] && p.tackleAnim < 0.5) p.tackleAnim = 1;
        if (LG.Skills && i !== meIdx) {
          if (tail[2] && (!p._skill || p._skill.id !== tail[2])) LG.Skills.mirror(p, tail[2], 1);
          else if (!tail[2] && p._skill) LG.Skills.end(p);
        }
        // visual-only step: rig, ring, carried ball — no movement
        var keepX = p.x, keepZ = p.z, keepF = p.facing, keepVx = p.vx, keepVz = p.vz;
        p.want.x = 0; p.want.z = 0;
        if (i !== meIdx) {
          p.update(0);
          if (p.model && p.model.anim && p.model.anim.update) { try { p.model.anim.update(dt, p); } catch (e2) { /* rig fallback */ } }
        }
        p.x = keepX; p.z = keepZ; p.facing = keepF; p.vx = keepVx; p.vz = keepVz;
        if (p.model && p.model.group) { p.model.group.position.set(p.x, p.y || 0, p.z); p.model.group.rotation.y = p.facing; }
        if (p.ring) { p.ring.position.set(p.x, 0, p.z); p.ring.rotation.y = p.facing; }
      }
      // the ball: on MY feet it follows my predicted body; otherwise blend
      var ba = A.b, bb = B.b, ball = m.ball, own = bb[6];
      ball.owner = own >= 0 ? m.all[own] : null;
      if (ball.owner && m.placeBallOnCarrier) {
        // on someone's feet: glue it to the DRAWN body (mine is predicted)
        m.placeBallOnCarrier(ball.owner, dt);
      } else {
        ball.x = ba[0] + (bb[0] - ba[0]) * u + bb[3] * ex * exk;
        ball.y = Math.max(ball.r || 0.27, ba[1] + (bb[1] - ba[1]) * u + bb[4] * ex * exk);
        ball.z = ba[2] + (bb[2] - ba[2]) * u + bb[5] * ex * exk;
        ball.vx = bb[3]; ball.vz = bb[5];
        if (ball.mesh) ball.mesh.position.set(ball.x, ball.y, ball.z);
      }
      if (B.c !== this.clock0) { this.clock0 = B.c; m.clock = B.c; m.bus.emit('clock', { t: B.c }); }
      m.score = B.sc.slice();
      var prev = m.state;
      m.state = B.st;
      if (prev !== m.state) m.bus.emit('state', { state: m.state });
      if (m.state === 'GOAL' && LG.Celebration) LG.Celebration.update(m, dt);
    },

    // PREDICTION: move my own star now, from my own stick
    predict: function (m, dt) {
      var I = LG.Input, me = this.me;
      var pr = this.press, now1 = {};
      ['pass', 'shoot', 'special', 'tackle', 'switch', 'skill'].forEach(function (k) { if (I.pressed(k)) { pr[k]++; now1[k] = true; } });
      var wv = m.screenToWorldMove(I.moveVec());
      // SKILL: start the move on my own body now (prediction); the host runs
      // the real one from the same press and its snapshots reconcile us
      if (now1.skill && LG.Skills) LG.Skills.start(m, me, wv, I.down('sprint'), { local: true });
      var live = m.state === 'PLAY' || m.state === 'KICKOFF';
      if (m.state !== 'PLAY') { wv = { x: 0, z: 0 }; }
      me.want.x = wv.x; me.want.z = wv.z; me.want.sprint = I.down('sprint');
      // run the same physics the host runs for this body
      var bx = this.err.x, bz = this.err.z, bleed = Math.min(1, dt * 7);
      me.update(live ? dt : 0);
      me.x += bx * bleed; me.z += bz * bleed;
      this.err.x -= bx * bleed; this.err.z -= bz * bleed;
      if (me.model && me.model.group) me.model.group.position.set(me.x, me.y || 0, me.z);
      // send at 30 Hz while the stick moves, 8 Hz while it rests
      this.inT += dt;
      var moving = Math.abs(wv.x) + Math.abs(wv.z) > 0.01 || I.down('sprint') || I.down('shoot');
      var rate = moving ? INPUT_HZ : IDLE_INPUT_HZ;
      var anyPress = false; for (var k in pr) if (pr[k] !== (this._sentPr && this._sentPr[k])) anyPress = true;
      if (this.inT < 1 / rate && !anyPress) return;
      this.inT = 0;
      this.inSeq++;
      this.hist.push({ q: this.inSeq, x: me.x, z: me.z });
      if (this.hist.length > 90) this.hist.shift();
      // presses are RUNNING totals so a lost packet loses nothing
      send({ t: 'i', q: this.inSeq, mx: q2(wv.x), mz: q2(wv.z), sp: I.down('sprint') ? 1 : 0, sh: (I.down('shoot') || now1.shoot) ? 1 : 0, sk: I.down('skill') ? 1 : 0, pr: pr }, true);
      this._sentPr = Object.assign({}, pr);
    },

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
        case 'skillMove': if (LG.Skills && P(d.p) && P(d.p) !== this.me) { LG.Skills.end(P(d.p)); LG.Skills.mirror(P(d.p), d.id, d.dir); } break;
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
      setWeak(false);
      var s = d.score || m.score, st = d.stats || { home: {}, away: {} };
      var won = s[1] > s[0] ? 1 : s[1] < s[0] ? -1 : 0;
      var result = { score: [s[1], s[0]], won: won, coins: 0, activeName: this.me.name, homeName: 'YOU', awayName: 'FRIEND',
        difficulty: '', court: (LG.Courts && LG.Courts.selected()) || '', playTime: 0, ts: Date.now(),
        stats: { home: st.away, away: st.home }, mode: 'friend_match', online: true, summary: d.summary };
      if (LG.Progression && LG.Progression.finalizeMatch) result = LG.Progression.finalizeMatch(result) || result;
      result.online = true;
      m.bus.emit('matchEnd', result);
    },
    stop: function () { guestCtrl = null; setWeak(false); },
  };

  function setWeak(on) {
    var el = document.getElementById('net-chip');
    if (el && el.classList) el.classList.toggle('hidden', !on);
  }

  // host side: the guest went quiet for too long
  if (typeof setInterval === 'function') setInterval(function () {
    if (!role || !LG.Match || !LG.Match.opts || !LG.Match.opts.online || LG.Match._finalized) return;
    if (lastRecv && now() - lastRecv > 8) { emit('closed', { why: 'timeout' }); setStatus('closed', 'Connection lost.'); }
  }, 1000);

  return {
    host: host, join: join, leave: leave, on: on, send: send,
    role: function () { return role; }, code: function () { return code; }, status: function () { return status; },
    cleanCode: cleanCode, makeCode: makeCode, transport: transportKind,
    HostCtrl: HostCtrl, GuestCtrl: GuestCtrl, snapshot: snapshot, RemoteInput: RemoteInput,
    _snaps: function () { return buf; },
    _ingest: ingest,
    _reset: function () { buf = []; clockOff = null; jitter = 0.02; lastArr = 0; lastTs = 0; lastRecv = 0; spacing = 1 / SNAP_HZ; },
    syncInfo: function () { return { buf: buf.length, spacing: spacing, delay: guestCtrl ? guestCtrl.delay() : 0, jitter: jitter, stats: guestCtrl ? guestCtrl.stats : null }; },
  };
})();
