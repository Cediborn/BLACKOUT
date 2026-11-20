// ============================================================
// MODE CONTROLLERS (Build 6) — Penalty Shootout, The Yard, Rumble.
// A controller rides on a normal MatchManager (same players, ball,
// court, keepers, camera, HUD) and takes over only what its mode
// changes. Hooks the match calls when match.ctrl is set:
//   start(m)         after Match.start
//   update(m, dt)    every frame; return true to own the frame (the
//                    normal KICKOFF/PLAY/GOAL switch is skipped)
//   goalLine(m)      before the goal check; return true to swallow it
//   cam()            optional {p:[x,y,z], l:[x,y,z]} camera override
//   summary(m)       extra lines for the full-time screen
//   noProgress       true: the match result is not a league result
// All DOM for the modes lives in #mode-hud (index.html).
// ============================================================
var LG = window.LG = window.LG || {};

LG.ModeCtrl = (function () {
  function $(id) { return document.getElementById(id); }
  function txt(id, v) { var e = $(id); if (e) e.textContent = v; }
  function show(id, on) { var e = $(id); if (e) e.classList.toggle('hidden', !on); }
  function U() { return LG.Util; }
  function C() { return LG.Config.court; }
  function hud(on, kind) {
    show('mode-hud', on);
    var b = document.body;
    if (b && b.classList) {
      b.classList.toggle('mode-shootout', on && kind === 'shootout');
      b.classList.toggle('mode-yard', on && kind === 'yard');
      b.classList.toggle('mode-rumble', on && kind === 'rumble');
    }
  }
  function banner(t, cls, ms) { if (LG.HUD && LG.HUD.banner) LG.HUD.banner(t, cls || '', ms || 1100); }
  function toast(t, ms) { if (LG.HUD && LG.HUD.toast) LG.HUD.toast(t, ms || 1200); }
  function park(p, x, z, face) {
    p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.want.x = 0; p.want.z = 0; p.want.sprint = false;
    if (face != null) p.facing = face;
    if (p.model && p.model.group) p.model.group.position.set(x, 0, z);
  }
  function freezeAll(m) {
    for (var i = 0; i < m.all.length; i++) {
      var p = m.all[i];
      p.isHuman = false; p.ai = null; p.hasBall = false;
      p.want.x = 0; p.want.z = 0; p.want.sprint = false;
    }
    m.ball.owner = null;
  }
  function steer(p, tx, tz, speed) {
    var dx = tx - p.x, dz = tz - p.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.08) { p.want.x = 0; p.want.z = 0; return d; }
    var k = Math.min(1, d / 0.6) * (speed || 0.6);
    p.want.x = dx / d * k; p.want.z = dz / d * k;
    return d;
  }
  var _rs = 9001;
  function rnd() { _rs = (_rs * 16807) % 2147483647; return (_rs - 1) / 2147483646; }
  function lvl() { return (LG.Difficulty && LG.Difficulty.get()) || 'medium'; }

  // ==========================================================
  // PENALTY SHOOTOUT — five kicks each, then sudden death.
  // ==========================================================
  function Shootout() {
    this.kind = 'shootout';
    this.kicks = [[], []];       // per team: 'goal' | 'miss' | 'save'
    this.turn = 0;               // 0 = you kick, 1 = CPU kicks
    this.n = 0;                  // kicks taken in total
    this.phase = 'setup';
    this.t = 0;
    this.aim = { x: 0, y: 0.8 };
    this.power = 0;
    this.dive = 0;               // human keeper dive side, -1 / 0 / +1 (world x)
    this.flight = null;
    this.over = false;
  }
  Shootout.prototype = {
    goalZ: function (team) { return team === 0 ? -C().length / 2 : C().length / 2; },
    spotZ: function (team) { var g = this.goalZ(team); return g + (team === 0 ? 8.5 : -8.5); },
    order: function (m, team) {
      var list = (team === 0 ? m.home : m.away).filter(function (p) { return !p.isGoalkeeper; });
      if (team === 0 && m.active) { list.splice(list.indexOf(m.active), 1); list.unshift(m.active); }
      return list;
    },
    keeper: function (m, team) {
      var t = team === 0 ? m.away : m.home;   // the keeper facing this team's kick
      for (var i = 0; i < t.length; i++) if (t[i].isGoalkeeper) return t[i];
      return null;
    },
    start: function (m) {
      this.star = m.active;
      freezeAll(m);
      m.state = 'PLAY';
      m.clock = 0;
      hud(true, 'shootout');
      show('so-hud', true); show('yard-hud', false); show('rumble-hud', false);
      this.marker = this.makeMarker(m);
      this.renderDots();
      this.setup(m);
    },
    makeMarker: function (m) {
      if (!window.THREE || !m.ball || !m.ball.mesh || !m.ball.mesh.parent) return null;
      var g = new THREE.RingGeometry(0.22, 0.3, 28);
      var mk = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf04f9b, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }));
      mk.renderOrder = 20; mk.visible = false; mk.name = 'shootoutAim';
      m.ball.mesh.parent.add(mk);
      return mk;
    },
    setup: function (m) {
      var team = this.turn, U_ = U();
      this.kicker = this.order(m, team)[Math.floor(this.kicksBy(team) % 3)];
      this.gk = this.keeper(m, team);
      var gz = this.goalZ(team), sz = this.spotZ(team), dir = team === 0 ? -1 : 1;
      // everyone else waits on the halfway line, keepers in their nets
      var waiting = 0;
      for (var i = 0; i < m.all.length; i++) {
        var p = m.all[i];
        if (p === this.kicker || p === this.gk) continue;
        if (p.isGoalkeeper) { park(p, 0, p.team === 0 ? C().length / 2 - 0.4 : -C().length / 2 + 0.4); continue; }
        park(p, -6 + (waiting++) * 2.4, -dir * 2, dir > 0 ? Math.PI : 0);
      }
      park(this.kicker, 0, sz - dir * 1.6, dir > 0 ? 0 : Math.PI);
      park(this.gk, 0, gz - dir * 0.35, dir > 0 ? Math.PI : 0);
      m.ball.reset(0, sz);
      m.ball.owner = null;
      if (LG.KeeperMotion) LG.KeeperMotion.reset(m);
      this.aim = { x: 0, y: 0.9 };
      this.power = 0; this.dive = 0; this.flight = null; this.cpuAim = null;
      this.phase = 'setup'; this.t = 0;
      m.active = team === 0 ? this.kicker : this.star;
      this.round = Math.floor(this.n / 2) + 1;
      var who = team === 0 ? 'YOU' : (m.opts.awayName || 'ROGUE');
      banner(this.round > 5 ? 'SUDDEN DEATH' : 'KICK ' + this.round, team === 0 ? 'team1' : 'team2', 900);
      txt('so-prompt', team === 0 ? this.kicker.name + ' STEPS UP · AIM WITH THE STICK · HOLD SHOOT' :
        who + ' TO KICK · HOLD THE STICK LEFT OR RIGHT TO DIVE');
      show('so-power', team === 0);
      this.setPower(0);
    },
    kicksBy: function (team) { return this.kicks[team].length; },
    goals: function (team) { return this.kicks[team].filter(function (k) { return k === 'goal'; }).length; },
    setPower: function (v) { var f = $('so-power-fill'); if (f && f.style) f.style.width = Math.round(Math.min(1, v) * 100) + '%'; },
    renderDots: function () {
      for (var t = 0; t < 2; t++) {
        var box = $('so-dots-' + t);
        if (!box) continue;
        var html = '', n = Math.max(5, this.kicks[t].length);
        for (var i = 0; i < n; i++) {
          var k = this.kicks[t][i];
          html += '<i class="' + (k ? (k === 'goal' ? 'g' : 'x') : '') + '"></i>';
        }
        box.innerHTML = html;
      }
      txt('so-score', this.goals(0) + ' – ' + this.goals(1));
    },
    // screen stick -> world x for the current camera (behind the kicker)
    stickX: function () {
      var mv = LG.Input.moveVec ? LG.Input.moveVec() : { x: 0, y: 0 };
      return { sx: mv.x || 0, sy: mv.y || 0 };
    },
    update: function (m, dt) {
      this.t += dt;
      var team = this.turn, dir = team === 0 ? -1 : 1;
      var gw = C().goalWidth / 2, gh = C().goalHeight, gz = this.goalZ(team), sz = this.spotZ(team);
      if (this.phase === 'setup') {
        if (this.t > 0.9) { this.phase = team === 0 ? 'aim' : 'cpu'; this.t = 0; }
      } else if (this.phase === 'aim') {
        var st = this.stickX();
        // camera looks toward -z from behind: screen right = world +x
        this.aim.x = U().clamp(this.aim.x + st.sx * 3.2 * dt, -gw - 0.6, gw + 0.6);
        this.aim.y = U().clamp(this.aim.y + st.sy * 2.2 * dt, 0.15, gh + 0.5);
        var down = LG.Input.down('shoot') || LG.Input.pressed('shoot');
        if (down) { this.power = Math.min(1.2, this.power + dt * 0.95); this.charging = true; }
        this.setPower(this.power);
        if ((this.charging && !down) || this.power >= 1.2 || this.t > 9) {
          this.charging = false;
          this.shoot(m, Math.max(0.25, this.power), this.aim.x, this.aim.y);
        }
      } else if (this.phase === 'cpu') {
        var stc = this.stickX();
        // behind the CPU kicker the camera looks toward +z: screen right = world -x
        this.dive = Math.abs(stc.sx) > 0.35 ? (stc.sx > 0 ? -1 : 1) : 0;
        txt('so-dive', this.dive === 0 ? 'STAY' : (stc.sx > 0 ? 'DIVE RIGHT' : 'DIVE LEFT'));
        if (this.t > 1.9) {
          var L = lvl(), miss = { easy: 0.24, medium: 0.14, hard: 0.07 }[L] || 0.14;
          var side = rnd() < 0.42 ? -1 : rnd() < 0.72 ? 1 : 0;
          var ax = side * (0.9 + rnd() * (gw - 0.9)), ay = 0.2 + rnd() * (gh - 0.35);
          if (rnd() < miss) { if (rnd() < 0.5) ay = gh + 0.4 + rnd() * 0.6; else ax = (side || 1) * (gw + 0.3 + rnd() * 0.6); }
          this.shoot(m, 0.6 + rnd() * 0.3, ax, ay);
        }
      } else if (this.phase === 'runup') {
        var bd = steer(this.kicker, m.ball.x, m.ball.z - dir * 0.45, 0.75);
        if (bd < 0.15 || this.t > 0.7) this.strike(m);
      } else if (this.phase === 'flight') {
        var f = this.flight;
        f.t += dt;
        var u = Math.min(1, f.t / f.T);
        m.ball.x = f.x0 + (f.x1 - f.x0) * u;
        m.ball.z = f.z0 + (f.z1 - f.z0) * u;
        m.ball.y = f.y0 + (f.y1 - f.y0) * u + Math.sin(Math.PI * u) * f.arc;
        if (m.ball.mesh) m.ball.mesh.position.set(m.ball.x, m.ball.y, m.ball.z);
        if (u >= 1) this.resolve(m);
      } else if (this.phase === 'after') {
        m.ball.step(dt, m.arena);
        if (this.t > 1.7) this.next(m);
      }
      if (this.phase !== 'runup') { this.kicker.want.x = 0; this.kicker.want.z = 0; }
      if (this.marker) {
        this.marker.visible = this.phase === 'aim';
        this.marker.position.set(this.aim.x, Math.max(0.1, this.aim.y), gz + dir * 0.05);
      }
      m.updatePlayers(dt);
      return true;
    },
    shoot: function (m, power, ax, ay) {
      // overhit flies over; a weak one dribbles
      if (power > 0.97) ay += (power - 0.97) * 7;
      this.shot = { power: power, x: ax, y: ay };
      this.phase = 'runup'; this.t = 0;
      show('so-power', false);
    },
    strike: function (m) {
      var team = this.turn, dir = team === 0 ? -1 : 1;
      var gw = C().goalWidth / 2, gh = C().goalHeight, gz = this.goalZ(team);
      var s = this.shot, speed = 12 + s.power * 15;
      this.kicker.kickAnim = 1;
      this.kicker.want.x = 0; this.kicker.want.z = 0;
      var dx = s.x - m.ball.x, dz = gz - m.ball.z, dist = Math.sqrt(dx * dx + dz * dz);
      this.flight = { t: 0, T: dist / speed, x0: m.ball.x, z0: m.ball.z, y0: m.ball.r, x1: s.x, z1: gz, y1: Math.max(m.ball.r, s.y), arc: 0.25 + s.power * 0.15, speed: speed };
      m.ball.lastKicker = this.kicker;
      m.ball._kickSeq = (m.ball._kickSeq || 0) + 1;
      if (LG.Audio && LG.Audio.sfx && LG.Audio.sfx.kick) LG.Audio.sfx.kick(0.6 + s.power * 0.4);
      m.statSide(team).shots++;
      // the keeper commits as the ball is struck
      var region = function (x) { return x < -0.85 ? -1 : x > 0.85 ? 1 : 0; };
      var shotSide = region(s.x);
      var guess;
      if (team === 0) {                        // CPU keeper reads it
        var read = { easy: 0.25, medium: 0.4, hard: 0.55 }[lvl()] || 0.4;
        guess = rnd() < read ? shotSide : [-1, 0, 1][Math.floor(rnd() * 3)];
      } else {
        guess = this.dive;                     // you, in goal
      }
      this.guess = guess;
      var onTarget = Math.abs(s.x) < gw - 0.12 && s.y < gh - 0.08;
      var corner = Math.abs(s.x) > gw - 0.75 && s.y > gh - 0.6;    // top bins: unstoppable
      var slow = s.power < 0.42;
      this.outcome = !onTarget ? 'miss' : (corner ? 'goal' : ((guess === shotSide || slow) ? 'save' : 'goal'));
      // show the dive in world terms: guess is a world-x side; keeper's left differs per end
      if (this.gk && LG.KeeperMotion) {
        if (guess !== 0) {
          var sideL = LG.KeeperMotion.sideOf(this.gk, this.gk.x + guess, this.gk.z).side;
          LG.KeeperMotion.start(this.gk, 'dive', { side: sideL, reach: 0.9, high: s.y > 1.2 });
          this.gk.x = U().clamp(this.gk.x + guess * 0.9, -gw, gw);
        } else if (s.y > 1.3) LG.KeeperMotion.start(this.gk, 'jump', { high: true });
      }
      this.phase = 'flight'; this.t = 0;
    },
    resolve: function (m) {
      var team = this.turn, dir = team === 0 ? -1 : 1, f = this.flight, out = this.outcome;
      var sp = f.speed;
      if (out === 'save') {
        m.ball.vx = (rnd() - 0.5) * 6; m.ball.vy = 3; m.ball.vz = -dir * sp * 0.3;
        m.statSide(1 - team).saves++;
        m.bus.emit('keeperSave', { gk: this.gk, parry: true });
        banner('SAVED!', team === 0 ? 'team2' : 'team1', 1200);
      } else if (out === 'goal') {
        m.ball.vx = (f.x1 - f.x0) / f.T * 0.4; m.ball.vy = 0; m.ball.vz = dir * sp * 0.35;
        m.statSide(team).goals++;
        banner('GOAL!', team === 0 ? 'team1' : 'team2', 1200);
        if (LG.Audio && LG.Audio.sfx && LG.Audio.sfx.goal) LG.Audio.sfx.goal();
        m.bus.emit('shootoutGoal', { team: team });
      } else {
        m.ball.vx = (f.x1 - f.x0) / f.T; m.ball.vy = 1; m.ball.vz = dir * sp;
        banner(f.y1 > C().goalHeight ? 'OVER THE BAR' : 'WIDE!', '', 1100);
      }
      this.kicks[team].push(out);
      this.n++;
      m.score = [this.goals(0), this.goals(1)];
      this.renderDots();
      this.phase = 'after'; this.t = 0;
    },
    decided: function () {
      var a = this.kicks[0].length, b = this.kicks[1].length, ga = this.goals(0), gb = this.goals(1);
      if (a <= 5 && b <= 5) {
        var leftA = 5 - a, leftB = 5 - b;
        if (ga > gb + leftB) return true;
        if (gb > ga + leftA) return true;
        return a === 5 && b === 5 && ga !== gb;
      }
      return a === b && ga !== gb;                // sudden death: after each pair
    },
    next: function (m) {
      if (this.decided()) { this.finish(m); return; }
      this.turn = 1 - this.turn;
      this.setup(m);
    },
    finish: function (m) {
      if (this.over) return;
      this.over = true;
      if (this.marker) this.marker.visible = false;
      m.score = [this.goals(0), this.goals(1)];
      m.endMatch();
    },
    cam: function () {
      if (!this.kicker) return null;
      var team = this.turn, dir = team === 0 ? -1 : 1, sz = this.spotZ(team), gz = this.goalZ(team);
      return { p: [0, 2.3, sz - dir * 6.2], l: [0, 0.9, gz] };
    },
    goalLine: function () { return true; },     // the shootout judges its own kicks
    summary: function () {
      var f = function (a) { return a.map(function (k) { return k === 'goal' ? 'GOAL' : k === 'save' ? 'SAVED' : 'MISS'; }).join(' · '); };
      return ['YOU: ' + f(this.kicks[0]), 'CPU: ' + f(this.kicks[1])];
    },
    stop: function () { if (this.marker && this.marker.parent) this.marker.parent.remove(this.marker); hud(false); },
  };

  // ==========================================================
  // THE YARD — three timed drills, 3 stars each.
  // ==========================================================
  var YARD_KEY = 'blackout.yard.v1';
  var DRILLS = [
    { id: 'targets', name: 'TARGET PRACTICE', how: 'Shoot at the glowing target in the goal.', stars: [3, 6, 9], secs: 40 },
    { id: 'gates', name: 'SPEED GATES', how: 'Dribble the ball through each pair of cones.', stars: [4, 8, 12], secs: 40 },
    { id: 'passing', name: 'PASS & MOVE', how: 'Pass to the mate standing in the glowing ring.', stars: [4, 8, 12], secs: 40 },
  ];
  function yardLoad() { try { return JSON.parse(localStorage.getItem(YARD_KEY)) || {}; } catch (e) { return {}; } }
  function yardSave(d) { try { localStorage.setItem(YARD_KEY, JSON.stringify(d)); } catch (e) { /* private mode */ } }

  function Yard() {
    this.kind = 'yard';
    this.noProgress = true;
    this.d = 0; this.points = 0; this.results = [];
    this.meshes = [];
  }
  Yard.prototype = {
    start: function (m) {
      this.star = m.active;
      hud(true, 'yard');
      show('so-hud', false); show('yard-hud', true); show('rumble-hud', false);
      m.state = 'PLAY';
      m.clock = DRILLS.reduce(function (a, d) { return a + d.secs; }, 0);
      this.drillT = 0;
      this.begin(m, 0);
    },
    clear: function () {
      for (var i = 0; i < this.meshes.length; i++) if (this.meshes[i].parent) this.meshes[i].parent.remove(this.meshes[i]);
      this.meshes = [];
    },
    add: function (m, mesh) { if (m.ball.mesh && m.ball.mesh.parent) m.ball.mesh.parent.add(mesh); this.meshes.push(mesh); return mesh; },
    begin: function (m, d) {
      this.clear();
      this.d = d; this.points = 0; this.drillT = 0;
      var D = DRILLS[d], hl = C().length / 2;
      txt('yard-k', 'THE YARD · DRILL ' + (d + 1) + ' OF 3');
      txt('yard-name', D.name); txt('yard-how', D.how);
      this.renderStars();
      // only the star (and for passing, two mates) are on the court
      for (var i = 0; i < m.all.length; i++) {
        var p = m.all[i];
        p.ai = null; p.isHuman = false; p.hasBall = false;
        var keep = p === this.star || (D.id === 'passing' && p.team === 0 && !p.isGoalkeeper);
        if (p.model && p.model.group) p.model.group.visible = keep;
        if (p.ring) p.ring.visible = keep && p === this.star;
        if (!keep) park(p, 40 + i * 2, 60);
      }
      this.star.isHuman = true;
      m.active = this.star;
      park(this.star, 0, -hl + 13, Math.PI);
      this.giveBall(m);
      banner(D.name, 'team1', 1300);
      if (D.id === 'targets') this.newTarget(m);
      if (D.id === 'gates') this.newGate(m);
      if (D.id === 'passing') { this.mates = m.home.filter(function (p) { return !p.isGoalkeeper && p !== this.star; }, this); this.newRing(m); }
    },
    giveBall: function (m) {
      m.all.forEach(function (p) { p.hasBall = false; });
      m.ball.reset(this.star.x, this.star.z - 0.5);
      this.star.hasBall = true; m.ball.owner = this.star; m.possessionTeam = 0;
      this.idleT = 0;
    },
    glow: function (color, geo) {
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    },
    newTarget: function (m) {
      var gw = C().goalWidth / 2, gh = C().goalHeight, hl = C().length / 2;
      var spots = [[-gw + 0.7, 0.5], [gw - 0.7, 0.5], [-gw + 0.7, gh - 0.5], [gw - 0.7, gh - 0.5], [0, gh - 0.5]];
      var s = spots[Math.floor(rnd() * spots.length)];
      if (this.target && s[0] === this.target.x && s[1] === this.target.y) s = spots[(spots.indexOf(s) + 1) % spots.length];
      this.target = { x: s[0], y: s[1], r: 0.62 };
      if (!this.tMesh) { this.tMesh = this.add(m, this.glow(0xffc14d, new THREE.RingGeometry(0.5, 0.62, 32))); }
      this.tMesh.position.set(s[0], s[1], -hl + 0.02);
    },
    newGate: function (m) {
      var hl = C().length / 2;
      var x = (rnd() * 2 - 1) * 8, z = -hl + 4 + rnd() * (hl - 2);
      if (this.gate && Math.abs(this.gate.z - z) < 4) z = this.gate.z > 0 ? z - 8 : z + 8;
      z = U().clamp(z, -hl + 3, hl - 3);
      this.gate = { x: x, z: z, w: 1.7 };
      if (!this.cones) {
        var cg = new THREE.ConeGeometry(0.22, 0.6, 12);
        cg.translate(0, 0.3, 0);
        var mat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6, emissive: 0x552200 });
        this.cones = [this.add(m, new THREE.Mesh(cg, mat)), this.add(m, new THREE.Mesh(cg, mat))];
        this.gateLine = this.add(m, this.glow(0x14c8db, new THREE.PlaneGeometry(1.7, 0.18)));
        this.gateLine.rotation.x = -Math.PI / 2;
      }
      this.cones[0].position.set(x - this.gate.w / 2, 0, z);
      this.cones[1].position.set(x + this.gate.w / 2, 0, z);
      this.gateLine.position.set(x, 0.03, z);
      this.gate.side = this.star.z > z ? 1 : -1;   // which side the star comes from
    },
    newRing: function (m) {
      var hl = C().length / 2, mates = this.mates;
      for (var i = 0; i < mates.length; i++) {
        var mt = mates[i];
        park(mt, (i ? 1 : -1) * (4 + rnd() * 6), -hl + 6 + rnd() * 18, 0);
        mt.facing = Math.atan2(this.star.x - mt.x, this.star.z - mt.z);
      }
      this.lit = mates[Math.floor(rnd() * mates.length)];
      if (!this.rMesh) {
        this.rMesh = this.add(m, this.glow(0xffc14d, new THREE.RingGeometry(0.9, 1.15, 36)));
        this.rMesh.rotation.x = -Math.PI / 2;
      }
      this.rMesh.position.set(this.lit.x, 0.04, this.lit.z);
    },
    score: function (m) {
      this.points++;
      txt('yard-score', 'SCORE ' + this.points);
      this.renderStars();
      if (LG.Audio && LG.Audio.sfx && LG.Audio.sfx.coin) LG.Audio.sfx.coin();
      if (LG.Particles && this.star) LG.Particles.ring(this.star.x, this.star.z, 0xffc14d, 3, 0.5);
    },
    stars: function () { var s = DRILLS[this.d].stars, n = 0; for (var i = 0; i < 3; i++) if (this.points >= s[i]) n++; return n; },
    renderStars: function () {
      var n = this.stars(), html = '';
      for (var i = 0; i < 3; i++) html += '<i class="' + (i < n ? 'on' : '') + '"></i>';
      var e = $('yard-stars'); if (e) e.innerHTML = html;
      txt('yard-score', 'SCORE ' + this.points);
      var s = DRILLS[this.d].stars;
      txt('yard-next', 'STARS AT ' + s.join(' · '));
    },
    update: function (m, dt) {
      var D = DRILLS[this.d];
      // nobody but the star has a brain in the yard
      for (var z = 0; z < m.all.length; z++) if (m.all[z] !== this.star) { m.all[z].ai = null; m.all[z].isHuman = false; }
      this.star.isHuman = true;
      this.drillT += dt;
      m.tickTimer(dt);
      txt('yard-clock', LG.Util.fmtTime ? LG.Util.fmtTime(Math.max(0, D.secs - this.drillT)) : Math.ceil(D.secs - this.drillT));
      m.updatePlayers(dt);
      m.resolvePossession();
      m._ballPrevX = m.ball.x; m._ballPrevZ = m.ball.z; m._ballPrevY = m.ball.y;
      m.ball.step(dt, m.arena);
      // a goal-line crossing is judged by goalLine below
      m.checkGoal();
      var star = this.star;
      if (D.id === 'gates' && this.gate && star.hasBall) {
        var g = this.gate, side = star.z > g.z ? 1 : -1;
        if (side !== g.side && Math.abs(star.x - g.x) < g.w / 2) { this.score(m); this.newGate(m); }
        else if (side !== g.side) g.side = side;      // went round it: try again from this side
      }
      if (D.id === 'passing' && this.lit) {
        if (this.lit.hasBall) {
          this.score(m);
          var back = this.lit;
          m.passTo(back, star, { lead: false });
          if (m.active !== star) m.activatePlayer(star, false);
          this.newRingLater = 0.8;
        }
        if (this.newRingLater > 0) { this.newRingLater -= dt; if (this.newRingLater <= 0) this.newRing(m); }
        // mates never wander: no brains
        for (var k = 0; k < this.mates.length; k++) { this.mates[k].ai = null; this.mates[k].isHuman = false; this.mates[k].want.x = 0; this.mates[k].want.z = 0; }
        if (m.active !== star) m.activatePlayer(star, false);
      }
      // a dead ball comes back to your feet
      if (!star.hasBall && m.ball.speed() < 0.4 && !m.ball.owner) {
        this.idleT += dt;
        if (this.idleT > 1.2) this.giveBall(m);
      } else this.idleT = 0;
      if (Math.abs(m.ball.x) > C().width / 2 + 2 || Math.abs(m.ball.z) > C().length / 2 + 3) this.giveBall(m);
      if (this.drillT >= D.secs) this.endDrill(m);
      return true;
    },
    goalLine: function (m) {
      var D = DRILLS[this.d], b = m.ball, hl = C().length / 2;
      if (D.id !== 'targets') { if (Math.abs(b.z) > hl) this.giveBall(m); return true; }
      if (b.z > -hl) return true;
      var t = this.target, dx = b.x - t.x, dy = b.y - t.y;
      if (Math.abs(b.x) < C().goalWidth / 2 && b.y < C().goalHeight && dx * dx + dy * dy < (t.r + 0.25) * (t.r + 0.25)) { this.score(m); this.newTarget(m); }
      else toast('MISSED THE TARGET', 700);
      this.giveBall(m);
      return true;
    },
    endDrill: function (m) {
      var D = DRILLS[this.d];
      var stars = this.stars(), best = yardLoad(), prev = best[D.id] || { best: 0, stars: 0 };
      var newStars = Math.max(0, stars - prev.stars);
      var coins = newStars * 25;
      best[D.id] = { best: Math.max(prev.best, this.points), stars: Math.max(prev.stars, stars) };
      yardSave(best);
      if (coins && LG.Progression && LG.Progression.addCoins) LG.Progression.addCoins(coins);
      this.results.push({ name: D.name, points: this.points, stars: stars, coins: coins, best: best[D.id].best });
      banner(this.points + ' PTS · ' + stars + '/3 STARS', 'team1', 1600);
      if (this.d < DRILLS.length - 1) this.begin(m, this.d + 1);
      else this.finish(m);
    },
    finish: function (m) {
      if (this.done) return;
      this.done = true;
      this.clear();
      var total = this.results.reduce(function (a, r) { return a + r.points; }, 0);
      m.score = [total, 0];
      m.endMatch();
    },
    summary: function () {
      return this.results.map(function (r) {
        return r.name + ' · ' + r.points + ' PTS · ' + r.stars + '/3 STARS' + (r.coins ? ' · +' + r.coins + ' COINS' : '') + ' · BEST ' + r.best;
      });
    },
    stop: function () { this.clear(); hud(false); },
  };

  // ==========================================================
  // RUMBLE — a normal match where specials only come from orbs.
  // ==========================================================
  var ORB_IDS = ['BURST', 'POWER_SHOT', 'DRIBBLE_RUSH', 'SUPER_TACKLE', 'PERFECT_PASS', 'FREEZE', 'SHOCKWAVE', 'WALL'];
  function Rumble() {
    this.kind = 'rumble';
    this.orbs = []; this.spawnT = 3; this.picked = 0;
  }
  Rumble.prototype = {
    start: function (m) {
      hud(true, 'rumble');
      show('so-hud', false); show('yard-hud', false); show('rumble-hud', true);
      m.opts.noMeterFill = true;
      for (var i = 0; i < m.all.length; i++) { m.all[i].meter = 0; m.all[i].meterFull = false; m.all[i]._rumbleAbility = null; }
      txt('rumble-last', 'ORBS DROP EVERY FEW SECONDS — RUN OVER ONE');
    },
    spawn: function (m) {
      var id = ORB_IDS[Math.floor(rnd() * ORB_IDS.length)], def = LG.Abilities[id];
      var x = (rnd() * 2 - 1) * (C().width / 2 - 3), z = (rnd() * 2 - 1) * (C().length / 2 - 6);
      var g = new THREE.Group();
      var core = new THREE.Mesh(new THREE.SphereGeometry(0.32, 18, 12), new THREE.MeshBasicMaterial({ color: def.color }));
      var halo = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 28), new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
      halo.rotation.x = -Math.PI / 2; halo.position.y = -0.55;
      g.add(core); g.add(halo);
      g.position.set(x, 0.75, z); g.name = 'rumbleOrb';
      if (m.ball.mesh && m.ball.mesh.parent) m.ball.mesh.parent.add(g);
      this.orbs.push({ id: id, x: x, z: z, g: g, t: 0 });
      if (LG.Particles) LG.Particles.ring(x, z, def.color, 3, 0.5);
    },
    update: function (m, dt) {
      if (m.state !== 'PLAY') return false;
      this.spawnT -= dt;
      if (this.spawnT <= 0 && this.orbs.length < 2) { this.spawn(m); this.spawnT = 6 + rnd() * 3; }
      for (var i = this.orbs.length - 1; i >= 0; i--) {
        var o = this.orbs[i];
        o.t += dt;
        o.g.position.y = 0.75 + Math.sin(o.t * 3) * 0.12;
        o.g.rotation.y += dt * 1.5;
        for (var j = 0; j < m.all.length; j++) {
          var p = m.all[j];
          if (p.isGoalkeeper || p._rumbleAbility || p.active) continue;
          if (p.distTo(o.x, o.z) < 0.95) { this.grant(m, p, o); this.orbs.splice(i, 1); break; }
        }
      }
      return false;   // the match plays on as normal
    },
    grant: function (m, p, o) {
      if (o.g.parent) o.g.parent.remove(o.g);
      p._rumbleAbility = o.id;
      p.meter = 1; p.meterFull = true;
      this.picked++;
      var def = LG.Abilities[o.id];
      if (LG.Particles) LG.Particles.burst(o.x, 0.8, o.z, def.color, 22, 5, 3);
      if (LG.Audio && LG.Audio.sfx && LG.Audio.sfx.specialReady) LG.Audio.sfx.specialReady();
      var who = p.team === 0 ? (p.isHuman ? 'YOU' : p.name) : (p.name || 'ROGUE');
      txt('rumble-last', who + ' GOT ' + def.label);
      if (p.isHuman) toast('YOU GOT ' + def.label + ' — PRESS SPECIAL', 1600);
      m.bus.emit('rumbleOrb', { player: p, ability: o.id });
    },
    summary: function () { return ['ORBS PICKED UP: ' + this.picked]; },
    stop: function () {
      for (var i = 0; i < this.orbs.length; i++) if (this.orbs[i].g.parent) this.orbs[i].g.parent.remove(this.orbs[i].g);
      this.orbs = []; hud(false);
    },
  };

  function create(modeId) {
    if (modeId === 'penalty_shootout') return new Shootout();
    if (modeId === 'the_yard') return new Yard();
    if (modeId === 'rumble') return new Rumble();
    return null;
  }

  return { create: create, DRILLS: DRILLS, yardBest: yardLoad, Shootout: Shootout, Yard: Yard, Rumble: Rumble, hud: hud };
})();
