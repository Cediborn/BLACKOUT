// ============================================================
// KITROOM — the PLAYER STYLE screen as a kit room (Build 4).
//
// The screen used to be two colour grids plus a GEAR box (outfit, hair,
// accessory, skin rows). Now it is two live 3D players: one from YOUR team
// and one from the ROGUE SQUAD.
//   * tap a player  -> that team's next kit colour (the teams never match)
//   * tap the orb   -> that team's next kit style (hoodie, jersey, baggy…)
// Kit style is a TEAM choice: all three outfield players wear it; keepers
// keep the keeper kit.
//
// Hair, accessory and skin are no longer chosen: looks() deals them fresh
// for every squad, and every squad of three has one black player, one
// white player and one mixed / in-between skin tone, in a shuffled order.
// It uses its own PRNG (never Math.random), so the seed-pinned simulation
// stream that the regression tests replay is untouched.
//
// The previews are two small WebGL canvases rendered only while the screen
// is open. Without WebGL or the athlete body the stage falls back to a
// colour badge, and every control still works.
// ============================================================
var LG = window.LG = window.LG || {};

LG.KitRoom = (function () {
  var DARK = ['tone5', 'tone6'], LIGHT = ['tone1', 'tone2'], MID = ['tone3', 'tone4'];
  var HAIR_IDS = ['buzz', 'short', 'spiky', 'afro', 'curly', 'ponytail', 'mohawk', 'natural'];
  var ACC_IDS = ['none', 'none', 'headband', 'cap', 'wristband', 'armband', 'glasses'];
  var DEFAULT_STYLE = { home: 'jersey', away: 'track' };

  var _s = (Date.now() ^ 0x9E3779B9) >>> 0;
  function rnd() { _s ^= _s << 13; _s >>>= 0; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0; return _s / 4294967296; }
  function pick(a) { return a[(rnd() * a.length) | 0]; }

  function styles() {
    var cat = LG.Cosmetics && LG.Cosmetics.catalog ? LG.Cosmetics.catalog().outfits : null;
    return cat && cat.length ? cat : [{ id: 'jersey', label: 'JERSEY' }];
  }
  function styleLabel(id) {
    var s = styles();
    for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i].label;
    return String(id || '').toUpperCase();
  }
  function validStyle(id, side) {
    var s = styles();
    for (var i = 0; i < s.length; i++) if (s[i].id === id) return id;
    return DEFAULT_STYLE[side] || s[0].id;
  }
  function nextStyle(id) {
    var s = styles(), i;
    for (i = 0; i < s.length; i++) if (s[i].id === id) break;
    return s[(i + 1) % s.length].id;
  }

  // ---- looks: one black, one white, one in-between, order shuffled ----
  function looks(n) {
    n = n || 3;
    var tones = [pick(DARK), pick(LIGHT), pick(MID)];
    for (var i = tones.length - 1; i > 0; i--) { var j = (rnd() * (i + 1)) | 0, t = tones[i]; tones[i] = tones[j]; tones[j] = t; }
    var out = [], usedHair = {};
    for (i = 0; i < n; i++) {
      var hair = pick(HAIR_IDS), guard = 0;
      while (usedHair[hair] && guard++ < 6) hair = pick(HAIR_IDS);
      usedHair[hair] = 1;
      out.push({ skin: tones[i % 3] || pick(MID), hair: hair, accessory: pick(ACC_IDS) });
    }
    return out;
  }
  function toneOf(id) {
    var cat = LG.Cosmetics && LG.Cosmetics.catalog ? LG.Cosmetics.catalog() : null;
    if (!cat) return null;
    for (var i = 0; i < cat.skins.length; i++) if (cat.skins[i].id === id) return cat.skins[i].color;
    return null;
  }
  function hairIdx(id) {
    var cat = LG.Cosmetics && LG.Cosmetics.catalog ? LG.Cosmetics.catalog() : null;
    if (!cat) return -1;
    for (var i = 0; i < cat.hairs.length; i++) if (cat.hairs[i].id === id) return cat.hairs[i].idx;
    return -1;
  }

  // dress(defs, colour, style): deep copies wearing the team kit and a
  // freshly dealt look each. The copies carry __cos, so LG.Cosmetics
  // leaves them alone and every body builder reads the same choices.
  function dress(defs, color, style, opts) {
    opts = opts || {};
    var L = opts.looks || looks(defs.length);
    return defs.map(function (d, i) {
      var c = JSON.parse(JSON.stringify(d));
      c.palette = JSON.parse(JSON.stringify(c.palette || {}));
      if (color != null) { c.palette.shirt = color; c.palette.pants = color; c.palette.shoe = color; }
      var lk = L[i % L.length];
      var tone = toneOf(lk.skin);
      if (tone != null) c.palette.skin = tone;
      var hi = hairIdx(lk.hair);
      if (hi >= 0) c.hairStyle = hi;
      c.__cos = { outfit: style || 'jersey', hair: lk.hair, accessory: lk.accessory, skin: lk.skin };
      return c;
    });
  }

  // ---------------- live previews ----------------
  var stages = {};
  var running = false, lastT = 0;

  function Stage(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.model = null;
    this.key = '';
    this.spin = 0;
    try {
      this.r = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
      this.r.setClearColor(0x000000, 0);
      if (THREE.sRGBEncoding !== undefined) this.r.outputEncoding = THREE.sRGBEncoding;
      this.scene = new THREE.Scene();
      this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x303040, 1.0));
      var key = new THREE.DirectionalLight(0xffffff, 1.3); key.position.set(2, 4, 3); this.scene.add(key);
      var rim = new THREE.DirectionalLight(0x9fd8ff, 0.55); rim.position.set(-3, 2, -2); this.scene.add(rim);
      this.cam = new THREE.PerspectiveCamera(26, 0.66, 0.1, 50);
      this.cam.position.set(0, 1.0, 4.3);
      this.cam.lookAt(0, 0.95, 0);
      this.ok = true;
    } catch (e) { this.ok = false; }
  }
  Stage.prototype.set = function (def, style, look) {
    if (!this.ok || !LG.Athlete || !LG.Athlete.ready || !LG.Athlete.ready()) return false;
    var k = def.id + ':' + def.palette.shirt + ':' + style + ':' + JSON.stringify(look);
    if (k === this.key && this.model) return true;
    this.key = k;
    if (this.model) this.scene.remove(this.model.group);
    var dressed = dress([def], def.palette.shirt, style, { looks: [look] })[0];
    var m = null;
    try { m = LG.Athlete.build(dressed, { design: style, idx: 0 }); } catch (e) { m = null; }
    this.model = m;
    if (m) { m.group.rotation.y = -0.35 + this.spin; this.scene.add(m.group); }
    return !!m;
  };
  Stage.prototype.render = function (dt) {
    if (!this.ok || !this.model) return;
    var c = this.canvas, w = c.clientWidth | 0, h = c.clientHeight | 0;
    if (w < 2 || h < 2) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      this.r.setPixelRatio(dpr); this.r.setSize(w, h, false);
      this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    }
    // a slow showroom sway, never a full spin (the kit front stays readable)
    this.spin += dt;
    this.model.group.rotation.y = -0.3 + Math.sin(this.spin * 0.45) * 0.35;
    try { this.model.anim.update(dt, { vx: 0, vz: 0, facing: 0, stamina: 1 }); } catch (e) { /* idle only */ }
    this.r.render(this.scene, this.cam);
  };

  function mount(side, canvas) {
    if (!canvas) return null;
    if (stages[side] && stages[side].canvas === canvas) return stages[side];
    stages[side] = new Stage(canvas);
    return stages[side];
  }
  function show(side, def, style, look) {
    var s = stages[side];
    return s ? s.set(def, style, look) : false;
  }
  function frame(t) {
    if (!running) return;
    requestAnimationFrame(frame);
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016;
    lastT = t;
    for (var k in stages) if (stages[k]) stages[k].render(dt);
  }
  function start() { if (running) return; running = true; lastT = 0; requestAnimationFrame(frame); }
  function stop() { running = false; }

  return {
    styles: styles, styleLabel: styleLabel, validStyle: validStyle, nextStyle: nextStyle,
    looks: looks, dress: dress, defaults: DEFAULT_STYLE,
    mount: mount, show: show, start: start, stop: stop,
    live: function (side) { var s = stages[side]; return !!(s && s.ok && s.model); },
    tones: { dark: DARK, light: LIGHT, mid: MID },
  };
})();
