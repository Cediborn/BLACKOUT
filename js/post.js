// ============================================================
// POST — Build 7 graphics pipeline on pmndrs/postprocessing (Zlib,
// lib/postprocessing.min.js, bundled for three r147 as window.POSTPROCESSING).
//
// One EffectComposer, one RenderPass, ONE merged EffectPass (postprocessing
// fuses all effects into a single fullscreen shader, so a tier costs one
// extra full-screen draw + the bloom mip chain, not one pass per effect).
//
//   tier 0 (LOW)    : off — the scene renders straight to the screen,
//                     exactly as before (canvas MSAA on)
//   tier 1 (MEDIUM) : floodlight BLOOM (mip-blur, high threshold so only
//                     lamps, LEDs and kit trims glow) + broadcast VIGNETTE
//                     + MSAA x4 on WebGL2 (SMAA on WebGL1)
//   tier 2 (HIGH)   : tier 1 + stronger bloom + a light broadcast grade
//                     (contrast / saturation) + SMAA edge polish
//
// It renders in a half-float buffer when the GPU allows, so floodlights
// can be brighter than white before the bloom picks them out.
// Safety: any error building or running the chain turns post OFF for the
// session and the game renders directly; the dynamic-resolution governor
// (js/perf.js) also bypasses post while a phone is struggling, before it
// has to drop resolution further.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Post = (function () {
  var PP = null, composer = null, renderer = null, scene = null, camera = null;
  var tier = 0, built = -1, failed = false, effects = {}, lastW = 0, lastH = 0, bypassed = false;
  var stats = { frames: 0, direct: 0, errors: 0 };

  function lib() { return PP || (PP = window.POSTPROCESSING || null); }

  function init(r, s, c) { renderer = r; scene = s; camera = c; }

  function dispose() {
    if (composer) { try { composer.dispose(); } catch (e) { /* gone */ } }
    composer = null; effects = {}; built = -1;
  }

  function build(t) {
    dispose();
    if (t <= 0 || failed || !lib() || !renderer) return;
    try {
      var P = lib();
      var gl2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
      var half = gl2 && renderer.extensions && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
      var samples = gl2 ? Math.min(4, renderer.capabilities.maxSamples || 0) : 0;
      composer = new P.EffectComposer(renderer, {
        frameBufferType: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
        multisampling: samples,
      });
      composer.addPass(new P.RenderPass(scene, camera));
      var list = [];
      effects.bloom = new P.BloomEffect({
        blendFunction: P.BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: t >= 2 ? 0.78 : 0.84,
        luminanceSmoothing: 0.18,
        intensity: t >= 2 ? 0.95 : 0.7,
        radius: 0.62,
      });
      list.push(effects.bloom);
      // the scene now renders into an off-screen HDR buffer, where three
      // skips its own tone mapping — so the SAME curve (ACES, the lighting
      // module's exposure) is applied here, after the bloom
      if (renderer.toneMapping === THREE.ACESFilmicToneMapping) {
        effects.tone = new P.ToneMappingEffect({ mode: P.ToneMappingMode.ACES_FILMIC });
        list.push(effects.tone);
      }
      effects.vignette = new P.VignetteEffect({ offset: 0.32, darkness: t >= 2 ? 0.5 : 0.42 });
      list.push(effects.vignette);
      if (t >= 2) {
        effects.grade = new P.BrightnessContrastEffect({ brightness: 0.0, contrast: 0.07 });
        effects.sat = new P.HueSaturationEffect({ hue: 0, saturation: 0.08 });
        list.push(effects.grade, effects.sat);
      }
      if (t >= 2 || samples === 0) {
        effects.smaa = new P.SMAAEffect({ preset: P.SMAAPreset.MEDIUM });
        list.unshift(effects.smaa);
      }
      // one merged fullscreen pass for everything above
      var pass = new P.EffectPass(camera, list[0], list[1], list[2], list[3], list[4], list[5]);
      composer.addPass(pass);
      built = t;
      lastW = 0; lastH = 0;
      resize();
      if (window.console) console.log('[POST] tier ' + t + ' (' + list.length + ' effects, ' + (half ? 'half-float' : '8-bit') + ', msaa ' + samples + ')');
    } catch (e) {
      failed = true; stats.errors++;
      if (window.console) console.warn('[POST] disabled: ' + e.message);
      dispose();
    }
  }

  function setTier(t) {
    tier = t | 0;
    if (tier !== built) build(tier);
  }

  function resize() {
    if (!composer || !renderer) return;
    var v = new THREE.Vector2();
    renderer.getSize(v);
    if (v.x === lastW && v.y === lastH && composer._dpr === renderer.getPixelRatio()) return;
    lastW = v.x; lastH = v.y; composer._dpr = renderer.getPixelRatio();
    composer.setSize(v.x, v.y, false);
  }

  // draw one frame (replaces renderer.render in the main loop)
  function render(dt) {
    var struggling = LG.Perf && LG.Perf.scale && LG.Perf.scale() < 0.82;
    bypassed = !!struggling;
    if (!composer || failed || bypassed) { stats.direct++; renderer.render(scene, camera); return; }
    try {
      resize();
      composer.render(dt || 0.016);
      stats.frames++;
    } catch (e) {
      failed = true; stats.errors++;
      if (window.console) console.warn('[POST] render failed, falling back: ' + e.message);
      dispose();
      renderer.render(scene, camera);
    }
  }

  return {
    init: init, setTier: setTier, render: render, resize: resize,
    tier: function () { return built > 0 ? built : 0; },
    active: function () { return !!composer && !failed && !bypassed; },
    available: function () { return !!lib(); },
    info: function () { return { tier: tier, built: built, failed: failed, bypassed: bypassed, lib: !!lib(), stats: stats, effects: Object.keys(effects) }; },
  };
})();
