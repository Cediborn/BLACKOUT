// ============================================================
// SETTINGS — player-facing options (display, audio, a11y).
// Persisted with localStorage alongside the progression save.
// This is the single settings store for the game; other systems
// read from here instead of keeping their copies.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Settings = (function () {
  var KEY = 'blockout.settings.v1';
  var data = {
    timeOfDay: 'day',     // 'day' | 'dusk' | 'night' | 'blackout'  (day is the baseline)
    weather: 'dry',       // 'dry' | 'rain'  (Build 5)
    view: 'landscape',    // 'portrait' | 'landscape' (existing mobile default was landscape)
    volMaster: 0.55,      // 0..1 — historical master gain default
    volSfx: 1,            // 0..1 — procedural blips / kicks / whistle
    volCrowd: 1,          // 0..1 — ambient crowd bed + cheers
    volMusic: 0.7,        // 0..1 — menu music only (match audio untouched)
    reducedMotion: false, // real: body class + camera shake/pulse off
    quality: 'auto',      // 'auto' | 'low' | 'medium' | 'high' (Phase 10 graphics quality)
  };

  var TIME = ['day', 'dusk', 'night', 'blackout'];
  var WEATHER = ['dry', 'rain'];
  var VIEW = ['portrait', 'landscape'];
  var QUALITY = ['auto', 'low', 'medium', 'high'];

  function num01(n, fallback) {
    n = Number(n);
    if (!isFinite(n)) return fallback;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (TIME.indexOf(p.timeOfDay) >= 0) data.timeOfDay = p.timeOfDay;
        if (VIEW.indexOf(p.view) >= 0) data.view = p.view;
        if (WEATHER.indexOf(p.weather) >= 0) data.weather = p.weather;
        if (p.volMaster !== undefined) data.volMaster = num01(p.volMaster, data.volMaster);
        if (p.volSfx !== undefined) data.volSfx = num01(p.volSfx, data.volSfx);
        if (p.volCrowd !== undefined) data.volCrowd = num01(p.volCrowd, data.volCrowd);
        if (p.volMusic !== undefined) data.volMusic = num01(p.volMusic, data.volMusic);
        if (p.reducedMotion !== undefined) data.reducedMotion = !!p.reducedMotion;
        if (QUALITY.indexOf(p.quality) >= 0) data.quality = p.quality;
      }
    } catch (e) { /* ignore */ }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  function pushAudio() {
    if (LG.Audio && LG.Audio.applyVolumes) LG.Audio.applyVolumes();
    if (LG.Music && LG.Music.applyVolume) LG.Music.applyVolume();
  }

  load();

  return {
    timeOfDay: function () { return data.timeOfDay; },
    setTimeOfDay: function (m) {
      if (TIME.indexOf(m) < 0) return data.timeOfDay;
      data.timeOfDay = m; save();
      return data.timeOfDay;
    },
    cycleTimeOfDay: function () {
      return this.setTimeOfDay(TIME[(TIME.indexOf(data.timeOfDay) + 1) % TIME.length]);
    },

    // any lit-by-lamps time (headlights, windows, festoons glow)
    isDark: function () { return data.timeOfDay !== 'day'; },
    times: function () { return TIME.slice(); },
    weather: function () { return data.weather; },
    setWeather: function (w) {
      if (WEATHER.indexOf(w) < 0) return data.weather;
      data.weather = w; save();
      return data.weather;
    },
    view: function () { return data.view; },
    setView: function (m) {
      if (VIEW.indexOf(m) < 0) return data.view;
      data.view = m; save();
      return data.view;
    },
    isPortrait: function () { return data.view === 'portrait'; },
    isLandscape: function () { return data.view === 'landscape'; },

    // ---- audio (real gains — applied through LG.Audio.applyVolumes) ----
    volMaster: function () { return data.volMaster; },
    setVolMaster: function (v) {
      data.volMaster = num01(v, data.volMaster); save(); pushAudio();
      return data.volMaster;
    },
    volSfx: function () { return data.volSfx; },
    setVolSfx: function (v) {
      data.volSfx = num01(v, data.volSfx); save(); pushAudio();
      return data.volSfx;
    },
    volCrowd: function () { return data.volCrowd; },
    setVolCrowd: function (v) {
      data.volCrowd = num01(v, data.volCrowd); save(); pushAudio();
      return data.volCrowd;
    },
    volMusic: function () { return data.volMusic; },
    setVolMusic: function (v) {
      data.volMusic = num01(v, data.volMusic); save(); pushAudio();
      return data.volMusic;
    },

    // ---- accessibility (must be real or absent — it is real) ----
    reducedMotion: function () { return data.reducedMotion; },
    setReducedMotion: function (on) {
      data.reducedMotion = !!on; save();
      return data.reducedMotion;
    },

    // ---- graphics quality (Phase 10) ----
    // 'auto' resolves per device: phones/tablets get MEDIUM, desktops HIGH.
    // Every heavier visual added later reads qualityLevel(), never the raw
    // setting, so 'auto' is handled in exactly one place.
    quality: function () { return data.quality; },
    setQuality: function (q) {
      if (QUALITY.indexOf(q) < 0) return data.quality;
      data.quality = q; save();
      return data.quality;
    },
    qualityLevel: function (isMobile) {
      if (data.quality !== 'auto') return data.quality;
      return isMobile ? 'medium' : 'high';
    },
    qualityProfile: function (isMobile) {
      var lvl = this.qualityLevel(isMobile);
      var Q = (LG.Config && LG.Config.quality) || {};
      return Q[lvl] || Q.high || { dprCap: 2, shadows: true, shadowMap: 2048 };
    },

    // Snapshot for bug reports / tests (never mutates).
    snapshot: function () {
      return {
        timeOfDay: data.timeOfDay,
        weather: data.weather,
        view: data.view,
        volMaster: data.volMaster,
        volSfx: data.volSfx,
        volCrowd: data.volCrowd,
        volMusic: data.volMusic,
        reducedMotion: data.reducedMotion,
        quality: data.quality,
      };
    },
  };
})();
