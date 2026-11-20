// ============================================================
// PERF (Build 7) — keep the frame rate steady on any phone.
// Watches the real frame time during a match and moves a render-scale
// between 0.6 and 1.0 of the quality's pixel-ratio cap:
//   * frames slower than ~40 fps for a second  -> render fewer pixels
//   * frames faster than ~55 fps for 4 seconds -> win pixels back
// main.js folds the scale into maxDpr(), so the canvas simply renders
// at a lower resolution — the game clock is never touched (gameplay
// runs in real time via sub-steps either way).
// ============================================================
var LG = window.LG = window.LG || {};

LG.Perf = (function () {
  var ema = 1 / 60, scale = 1, t = 0, calm = 0, frames = 0, drops = 0;
  var MIN = 0.6;

  function frame(dt, inMatch) {
    if (!(dt > 0)) return;
    frames++;
    ema += (dt - ema) * 0.08;
    if (!inMatch) return;
    t += dt;
    if (t < 1) return;
    t = 0;
    if (ema > 1 / 40 && scale > MIN) { scale = Math.max(MIN, scale - 0.1); calm = 0; drops++; }
    else if (ema < 1 / 55) { calm++; if (calm >= 4 && scale < 1) { scale = Math.min(1, scale + 0.05); calm = 0; } }
    else calm = 0;
  }

  return {
    frame: frame,
    scale: function () { return scale; },
    fps: function () { return Math.round(1 / ema); },
    info: function () { return { fps: Math.round(1 / ema), scale: scale, drops: drops, frames: frames }; },
    reset: function () { scale = 1; calm = 0; t = 0; },
  };
})();
