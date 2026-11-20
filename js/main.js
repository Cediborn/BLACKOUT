// ============================================================
// MAIN — boot, loop, menus, orchestration
// ============================================================
(function () {
  var LG = window.LG;
  var U = LG.Util;

  var renderer, scene, camera, camCtrl;
  var match = null;
  var arenaObj = null;
  var UIState = 'menu';          // menu | mode | challengePick | tournament | diff | select | style | court | setup | how | settings | about | profile | challenges | match | paused | result
  var howFromPause = false;      // track if how-to-play was opened from pause
  var profileResetArmed = false; // two-step confirm on RESET PROFILE
  var settingsResetArmed = false; // two-step confirm on RESET PROGRESS
  var quitting = false;          // mid-quit endMatch must not open the result board
  var resultActionLock = false;  // mode-aware result buttons: one action per result
  var selectedMode = 'quick_match';
  var selectedChallengeFocus = null;
  var selectedId = 'blaze';
  var outfitColor = null;        // null = regular clothes, or LG.OutfitColors entry
  var awayColor = null;          // null = default rogue kit, or LG.OutfitColors entry
  var homeStyle = null;          // Build 4: team kit style (LG.Cosmetics outfit id)
  var awayStyle = null;
  var bgT = 0;
  var clock = { t: 0 };
  var isMobile = false;

  // ---------------- last setup (Phase 10: PLAY NOW) ----------------
  // Difficulty, court and day/night + view already persist in their own
  // modules; the star and both kits did not. This tiny store remembers them
  // so PLAY NOW can start a match in one tap, and so the normal flow opens
  // on the player's last picks. A locked or unknown star falls back to the
  // default; a missing kit falls back to REGULAR.
  var LAST_KEY = 'blockout.lastsetup.v1';
  function colorById(id) {
    if (!id || !LG.OutfitColors) return null;
    for (var i = 0; i < LG.OutfitColors.length; i++) if (LG.OutfitColors[i].id === id) return LG.OutfitColors[i];
    return null;
  }
  function saveLastSetup() {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({
        star: selectedId,
        kit: outfitColor ? outfitColor.id : null,
        away: awayColor ? awayColor.id : null,
        homeStyle: homeStyle, awayStyle: awayStyle,
      }));
    } catch (e) { /* storage blocked: PLAY NOW just uses defaults */ }
    refreshQuickPlayLabel();
  }
  function applyLastSetup() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { d = null; }
    if (d && typeof d === 'object') {
      var known = false;
      for (var i = 0; i < LG.Roster.length; i++) if (LG.Roster[i].id === d.star) known = true;
      if (known && LG.Progression && LG.Progression.isUnlocked(d.star)) selectedId = d.star;
      outfitColor = colorById(d.kit);
      awayColor = colorById(d.away);
      if (outfitColor && awayColor && outfitColor.id === awayColor.id) awayColor = null;
      if (typeof d.homeStyle === 'string') homeStyle = d.homeStyle;
      if (typeof d.awayStyle === 'string') awayStyle = d.awayStyle;
    }
    refreshQuickPlayLabel();
  }
  function refreshQuickPlayLabel() {
    var el = document.getElementById('qp-sub');
    if (!el) return;
    var def = LG.byId(selectedId);
    var court = (LG.Courts && LG.Courts.get && LG.Courts.selected) ? LG.Courts.get(LG.Courts.selected()) : null;
    var parts = [def ? def.name : ''];
    var styleName = (LG.KitRoom && homeStyle) ? ' ' + LG.KitRoom.styleLabel(homeStyle) : ' KIT';
    parts.push((outfitColor ? outfitColor.label : 'BLUE') + styleName);
    if (court && court.name) parts.push(court.name);
    el.textContent = parts.join(' · ');
  }

  var IS_MOBILE = (function () {
    var t = 'ontouchstart' in window;
    var p = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var ua = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|Windows Phone/i.test(navigator.userAgent || '');
    return t || p || ua;
  })();

  // ---------------- init ----------------
  function hideLoading() {
    var el = document.getElementById('loading-overlay');
    if (el) el.classList.add('hidden');
  }

  var booted = false;
  function init() {
    // exactly one boot: a repeated 'load' (or anything else re-firing it) must
    // never build a second renderer, a second game loop or a second set of
    // listeners on top of a live one
    if (booted) return;
    booted = true;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: true });
    } catch (e) {
      var box = document.getElementById('loading-error');
      var tag = document.getElementById('loading-tag');
      var retry = document.getElementById('btn-loading-retry');
      if (tag) tag.classList.add('hidden');
      if (box) {
        box.classList.remove('hidden');
        box.textContent = '3D GRAPHICS ARE UNAVAILABLE IN THIS BROWSER — WEBGL FAILED TO START.';
      }
      if (retry) retry.classList.remove('hidden');
      return;
    }
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // sRGB in -> linear working space (see the inline hook in index.html) -> sRGB out
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x10141c, 45, 120);

    camera = new THREE.PerspectiveCamera(LG.Config.camera.fov, window.innerWidth / window.innerHeight, 0.1, 220);
    camCtrl = new LG.MatchCamera(camera);
    camCtrl.reset();

    // size the drawing buffer + camera from the REAL viewport before anything
    // downstream (lighting, particles, HUD, the first render) can read them
    applyViewportLayout();

    // Day/Night atmosphere lives in LG.Lighting (owns the key lights). The
    // arena environment is untouched by it — only its lighting is rebalanced.
    LG.Lighting.build(scene, renderer);
    applyQuality();        // Phase 10: resolution cap + shadows from the saved level
    var tArena = performance.now();
    arenaObj = LG.Arena.build(scene);
    // startup profiling: environment build cost (includes the instanced crowd)
    console.log('[START] arena build ' + (performance.now() - tArena).toFixed(1) + 'ms');
    if (LG.Living) LG.Living.build({ scene: scene }, arenaObj);
    LG.Particles.init(scene);
    // gather the environment's own lights/emissive signs/sky now that it exists
    LG.Lighting.collect(scene);
    LG.Lighting.setMode(LG.Settings.timeOfDay());
    // Build 5: rain (built lazily the first time it is switched on)
    if (LG.Weather) {
      LG.Weather.build(scene, function () { return LG.Settings.qualityLevel(IS_MOBILE); });
      LG.Weather.set(LG.Settings.weather());
    }

    // read-only handles for the offline verification tooling (tools/) — lets a
    // headless probe raycast the live scene without touching gameplay
    LG.debug = { scene: scene, camera: camera, renderer: renderer, arena: arenaObj ? arenaObj.root : null };

    LG.Input.init();
    LG.HUD.init();
    LG.HUD.bindButtons();
    applyLastSetup();      // Phase 10: open on the player's last star + kits
    refreshDifficultyUI();
    buildSelectGrid();

    // every signal that can change the visible area funnels into the SAME
    // layout pipeline (see scheduleViewportLayout) — no handler ever applies
    // a size of its own, and nothing here can bounce back into fullscreen
    window.addEventListener('resize', scheduleViewportLayout);
    window.addEventListener('orientationchange', scheduleViewportLayout);
    window.addEventListener('pageshow', scheduleViewportLayout);
    document.addEventListener('fullscreenchange', scheduleViewportLayout);
    document.addEventListener('webkitfullscreenchange', scheduleViewportLayout);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleViewportLayout();   // back from another app
    });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleViewportLayout);

    if (IS_MOBILE) {
      isMobile = true;
      // the rotate-phone overlay is driven from the loop, so it can never get
      // stuck over the menus (resize/orientationchange alone are unreliable on
      // phones, and a stuck overlay makes every button untappable)
      requestAnimationFrame(updateRotate);
    }

    // audio unlock on first gesture
    var unlockOnce = function () { LG.Audio.unlock(); if (LG.Music) LG.Music.unlock(); window.removeEventListener('pointerdown', unlockOnce); };
    window.addEventListener('pointerdown', unlockOnce);

    bindEvents();
    bindSettingsUI();
    refreshSettingsUI();
    refreshSettingsScreen();
    applyReducedMotionClass();
    if (LG.Audio && LG.Audio.applyVolumes) LG.Audio.applyVolumes();
    if (LG.Challenges && LG.Challenges.bind) LG.Challenges.bind();
    // keep the focus chip in step with live stats (event-driven, never per frame)
    ['goal', 'pass', 'shoot', 'tackleWin', 'keeperSave', 'perfectPass'].forEach(function (ev) {
      LG.eventBus.on(ev, function () { refreshModeChip(); });
    });
    // crowd audio: a real effort swells the stand (the weak poke at power 0.4
    // does not).  crowdSwell is deterministic, so this never touches the
    // seed-pinned gameplay stream.
    if (LG.Audio && LG.Audio.crowdSwell) {
      LG.eventBus.on('shoot', function (ev) {
        if (ev && typeof ev.power === 'number' && ev.power < 0.5) return;
        LG.Audio.crowdSwell(0.4 + (ev && ev.power ? ev.power : 0.6) * 0.5);
      });
    }
    showMenu(true);
    syncMusic();

    // Boot hand-off, in one animation frame, in this order:
    //   1. the FIRST real render happens BEHIND the loading cover. Compiling
    //      the scene's shaders is the biggest stall a phone pays at startup;
    //      revealing the UI first is exactly what "the game opens laggy"
    //      feels like. If this render throws, the cover stays up so the boot
    //      error box can report it instead of showing a black screen.
    //   2. only then is the cover lifted (no flash of empty canvas), and
    //   3. the court probes — they fetch every court png — start afterwards so
    //      they never fight the first frame for bandwidth or decode time.
    // Phase 11: the cover also waits (max 12 s) for the athlete body, so the
    // first match never starts on the fallback bodies just because the
    // model was still downloading. A failed load lifts the cover at once.
    var athT0 = nowMs();
    function athleteSettled() {
      if (!LG.Athlete || !LG.Athlete.status) return true;
      var ph = LG.Athlete.status().phase;
      return ph !== 'loading' || nowMs() - athT0 > 12000;
    }
    function reveal() {
      if (!athleteSettled()) { requestAnimationFrame(reveal); return; }
      renderer.render(scene, camera);
      hideLoading();
      if (LG.Courts) {
        LG.Courts.probeAll(function () {
          if (UIState === 'court') buildCourtGrid();
          refreshEnvironment(true);
        });
      }
      // the mobile viewport can still settle after boot (url bar collapse,
      // fullscreen already pending) — measure once more now that we are live
      scheduleViewportLayout();
      lastNow = nowSec();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(reveal);
  }

  var lastRotate = null;
  function updateRotate() {
    if (!isMobile) return;
    var el = document.getElementById('rotate-overlay');
    if (!el) return;
    var portraitDevice = window.innerHeight > window.innerWidth;
    // The phone is always held landscape during a match (both GAME VIEW options
    // run the device in landscape — only the camera/HUD follow the setting).
    // Prompt whenever a match is live on a portrait-held device, regardless of
    // the selected view. It is a HINT, never a modal: it never blocks touches
    // and never covers the thumb zones (see css #rotate-overlay), because a
    // full-screen wash here is what made players rotate the phone just to get
    // their joystick back.
    var want = portraitDevice &&
      (UIState === 'match' || UIState === 'paused');
    if (want === lastRotate) return;      // only touch the DOM on a real change
    lastRotate = want;
    el.classList.toggle('hidden', !want);
  }

  // Menu music follows the screen, not the other way round: the loop asks
  // every frame (setActive is a no-op when nothing changed), so Play ->
  // difficulty -> court -> kit -> settings all keep the same track running
  // while a match, its pause screen and the result board stop it.
  function syncMusic() {
    if (!LG.Music) return;
    LG.Music.setActive(UIState !== 'match' && UIState !== 'paused' && UIState !== 'result');
  }

  // Landscape + fullscreen, requested when a match actually starts — for BOTH
  // game views. Doing this on the first stray pointerdown looked harmless on
  // desktop but on a phone the viewport resize it triggers re-lays out the page
  // mid-tap, so the press was swallowed and the button never fired: exactly one
  // press of KICK OFF did nothing. Starting a match is a user gesture too, so it
  // is allowed. The physical screen never locks to portrait; only the camera
  // pose and HUD follow Settings.view.
  function enterLandscape() {
    if (!isMobile) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      requestOrientation('landscape');
      return;
    }
    try {
      var fs = document.documentElement;
      if (fs.requestFullscreen) {
        fs.requestFullscreen().then(function () {
          requestOrientation('landscape');
          scheduleViewportLayout();   // fullscreen changes the visible size
        }).catch(function () {});
      } else if (fs.webkitRequestFullscreen) {
        fs.webkitRequestFullscreen();
        requestOrientation('landscape');
        scheduleViewportLayout();
      }
    } catch (e) {}
  }

  // Steers the physical screen toward the player-chosen view. Locking only
  // exists behind fullscreen on most mobile browsers, and some refuse entirely
  // — every path is wrapped so the game keeps playing in whatever shape the
  // browser actually gives it (the camera + HUD follow the real viewport).
  function requestOrientation(orient) {
    try {
      var so = screen.orientation || {};
      if (so.lock && so.lock.call) so.lock(orient).catch(function () {});
      else if (orient === null && so.unlock) so.unlock();
    } catch (e) {}
  }

  // Keeps the body classes in sync with BOTH the real viewport shape and the
  // player's VIEW choice. is-portrait/is-landscape mirror the actual screen;
  // view-portrait/view-landscape mirror the selected setting, so choosing
  // LANDSCAPE rearranges the HUD/panels immediately even where the physical
  // window cannot rotate (desktop, unsupported orientation lock, ...).
  function updateLayoutClass() {
    var portrait = window.innerHeight > window.innerWidth;
    document.body.classList.toggle('is-portrait', portrait);
    document.body.classList.toggle('is-landscape', !portrait);
    var wantLandscape = LG.Settings.isLandscape();
    document.body.classList.toggle('view-landscape', wantLandscape);
    document.body.classList.toggle('view-portrait', !wantLandscape);
  }

  // ---------------- viewport layout (single source of truth) ----------------
  // Everything that depends on "how big is the visible screen" runs through
  // this one pipeline: renderer buffer + pixel ratio, camera aspect, the body
  // orientation/view classes and the rotate hint. Startup, resize,
  // orientationchange, fullscreenchange, visualViewport and pageshow all just
  // SCHEDULE it — no caller ever applies a size of its own.
  //
  // Why schedule instead of run synchronously: a phone announces a dimension
  // change BEFORE it has the final numbers (orientationchange and
  // fullscreenchange fire first, the resize carrying the real size follows),
  // and one gesture usually fires several of these at once. Reading the size
  // on the next animation frame therefore measures valid numbers, collapses a
  // burst into a single renderer reallocation instead of four, and a confirming
  // pass on the frame after that catches browsers that were still reporting
  // the old size. Nothing here ever re-enters fullscreen, so the
  // resize -> fullscreen -> resize loop is impossible by construction.
  var vpPending = false, vpConfirm = false;
  var vpW = 0, vpH = 0, vpDPR = 0, vpApplies = 0;

  // ---------------- graphics quality (Phase 10) ----------------
  // The profile caps the render resolution and switches sun shadows; the
  // viewport pipeline picks the new cap up on its next pass.
  function qualityProfile() {
    return (LG.Settings && LG.Settings.qualityProfile) ? LG.Settings.qualityProfile(IS_MOBILE)
      : { dprCap: 2, shadows: true, shadowMap: 2048 };
  }
  function maxDpr() {
    var c = Number(qualityProfile().dprCap);
    return isFinite(c) && c > 0 ? c : 2;
  }
  function applyQuality() {
    var q = qualityProfile();
    if (LG.Lighting && LG.Lighting.setShadows) LG.Lighting.setShadows(q.shadows, q.shadowMap);
    document.body.dataset.quality = LG.Settings.qualityLevel(IS_MOBILE);
    scheduleViewportLayout();
  }
  function setQuality(q) {
    LG.Settings.setQuality(q);
    applyQuality();
  }

  function applyViewportLayout() {
    vpApplies++;
    if (!renderer || !camera) return;
    var w = Math.max(1, Math.round(window.innerWidth || 1));
    var h = Math.max(1, Math.round(window.innerHeight || 1));
    var dpr = Math.min(window.devicePixelRatio || 1, maxDpr());
    var sizeMoved = w !== vpW || h !== vpH;
    var dprMoved = dpr !== vpDPR;
    if (dprMoved) {
      vpDPR = dpr;
      renderer.setPixelRatio(dpr);   // BEFORE setSize: one buffer allocation, not two
    }
    if (sizeMoved) {
      vpW = w; vpH = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    if (sizeMoved || dprMoved) renderer.setSize(w, h);
    updateLayoutClass();
    updateRotate();
    if (LG.DBG) LG.DBG.log('[viewport] ' + w + 'x' + h + ' @' + dpr);
  }

  function scheduleViewportLayout() {
    if (vpPending) return;          // a burst of events = one relayout
    vpPending = true;
    requestAnimationFrame(function () {
      vpPending = false;
      applyViewportLayout();
      if (vpConfirm) return;        // a confirm is already queued behind us
      vpConfirm = true;
      requestAnimationFrame(function () {
        vpConfirm = false;
        applyViewportLayout();      // no-op unless the size moved again
      });
    });
  }

  // ---------------- events ----------------
  function bindEvents() {
    var bus = LG.eventBus;

    // ------------------------------------------------------------
    // PRE-MATCH FLOW — mode first, then one screen, one purpose:
    //   menu -> MODE -> (challenge pick | tournament) -> DIFFICULTY
    //   -> STAR -> STYLE -> COURT -> MATCH SETUP -> game
    // Modes decide WHY; MatchManager keeps deciding HOW.
    // ------------------------------------------------------------
    bus.on('playRequested', function () {
      UIState = 'mode';
      selectedMode = (LG.Modes && LG.Modes.id) ? LG.Modes.id() : 'quick_match';
      refreshModeUI();
      showOverlay('menu-overlay', false);
      showOverlay('mode-overlay', true);
    });

    // PLAY NOW (Phase 10): one tap from the main menu straight into a Quick
    // Match with the last star, kits, difficulty, court and match setup.
    bus.on('quickPlayRequested', function () {
      if (UIState !== 'menu') return;
      if (LG.Modes) { LG.Modes.select('quick_match'); LG.Modes.clearChallenge(); }
      selectedMode = 'quick_match';
      applyLastSetup();
      startMatch(selectedId);
    });

    bus.on('modeBackRequested', function () {
      UIState = 'menu';
      showOverlay('mode-overlay', false);
      showOverlay('menu-overlay', true);
    });

    bus.on('modeRequested', function (e) {
      if (e && e.id) selectedMode = e.id;
      refreshModeUI();
    });

    bus.on('modeConfirmed', function () {
      if (LG.Modes) LG.Modes.select(selectedMode);
      if (selectedMode === 'challenge_match') {
        UIState = 'challengePick';
        selectedChallengeFocus = (LG.Modes && LG.Modes.challenge) ? LG.Modes.challenge() : null;
        refreshChallengePickUI();
        showOverlay('mode-overlay', false);
        showOverlay('challenge-pick-overlay', true);
        return;
      }
      if (selectedMode === 'tournament') {
        UIState = 'tournament';
        refreshTournamentUI();
        showOverlay('mode-overlay', false);
        showOverlay('tournament-overlay', true);
        return;
      }
      UIState = 'diff';
      refreshDifficultyUI();
      showOverlay('mode-overlay', false);
      showOverlay('diff-overlay', true);
    });

    bus.on('challengePickBackRequested', function () {
      UIState = 'mode';
      showOverlay('challenge-pick-overlay', false);
      showOverlay('mode-overlay', true);
    });

    bus.on('challengeFocusRequested', function (e) {
      if (e && e.id) selectedChallengeFocus = e.id;
      refreshChallengePickUI();
    });

    bus.on('challengePickConfirmed', function () {
      if (!selectedChallengeFocus || !LG.Modes || !LG.Modes.selectChallenge(selectedChallengeFocus)) {
        LG.HUD.toast('PICK A CHALLENGE');
        return;
      }
      UIState = 'diff';
      refreshDifficultyUI();
      showOverlay('challenge-pick-overlay', false);
      showOverlay('diff-overlay', true);
    });

    bus.on('tournamentBackRequested', function () {
      UIState = 'mode';
      showOverlay('tournament-overlay', false);
      showOverlay('mode-overlay', true);
    });

    bus.on('tournamentStartRequested', function () {
      var T = LG.Tournament;
      if (!T) return;
      // won/eliminated START = fresh cup (no page reload)
      if (T.status() === 'won' || T.status() === 'eliminated') T.reset();
      if (!T.active()) T.start(selectedId);
      // RESUME between fixtures skips setup and plays the next tie
      if (T.canContinue(false)) {
        showOverlay('tournament-overlay', false);
        startMatch(selectedId);
        return;
      }
      // first fixture (or a fresh draw) still runs the normal setup screens
      UIState = 'diff';
      refreshDifficultyUI();
      showOverlay('tournament-overlay', false);
      showOverlay('diff-overlay', true);
    });

    bus.on('tournamentContinueRequested', function () {
      if (resultActionLock) return;
      var T = LG.Tournament;
      if (!T || !T.canContinue(!!(match && !match._finalized))) return;
      resultActionLock = true;
      showOverlay('result-overlay', false);
      startMatch(selectedId);
      resultActionLock = false;
    });

    bus.on('resultSetupRequested', function () {
      if (resultActionLock) return;
      if (LG.Modes && LG.Modes.is('tournament')) return; // tournament has no mid-bracket setup hop
      resultActionLock = true;
      if (match && !match._finalized && match.clock !== undefined) {
        quitting = true;
        match.endMatch();
        quitting = false;
      }
      if (match) clearMatchFromScene();
      LG.Input.reset();
      LG.HUD.clearTags();
      LG.HUD.setModeChip('');
      showOverlay('result-overlay', false);
      showMatchUI(false);
      UIState = 'setup';
      refreshSettingsUI();
      showOverlay('setup-overlay', true);
      resultActionLock = false;
    });

    bus.on('difficultyRequested', function (e) {
      LG.Difficulty.set(e && e.id);
      refreshDifficultyUI();
    });

    bus.on('difficultyConfirmed', function () {
      UIState = 'select';
      showOverlay('diff-overlay', false);
      showOverlay('select-overlay', true);
    });

    bus.on('difficultyBackRequested', function () {
      // back into the mode layer (challenge/tournament return to their screens)
      if (selectedMode === 'challenge_match') {
        UIState = 'challengePick';
        selectedChallengeFocus = (LG.Modes && LG.Modes.challenge) ? LG.Modes.challenge() : null;
        refreshChallengePickUI();
        showOverlay('diff-overlay', false);
        showOverlay('challenge-pick-overlay', true);
        return;
      }
      if (selectedMode === 'tournament') {
        UIState = 'tournament';
        refreshTournamentUI();
        showOverlay('diff-overlay', false);
        showOverlay('tournament-overlay', true);
        return;
      }
      UIState = 'mode';
      refreshModeUI();
      showOverlay('diff-overlay', false);
      showOverlay('mode-overlay', true);
    });

    bus.on('howRequested', function () {
      howFromPause = false;
      UIState = 'how';
      showOverlay('menu-overlay', false);
      showOverlay('how-overlay', true);
    });
    bus.on('settingsRequested', function () {
      if (UIState !== 'menu') return;
      UIState = 'settings';
      settingsResetArmed = false;
      refreshSettingsScreen();
      showOverlay('menu-overlay', false);
      showOverlay('settings-overlay', true);
    });
    bus.on('settingsBackRequested', function () {
      UIState = 'menu';
      settingsResetArmed = false;
      showOverlay('settings-overlay', false);
      showOverlay('menu-overlay', true);
    });
    bus.on('aboutRequested', function () {
      if (UIState !== 'menu') return;
      UIState = 'about';
      refreshAboutUI();
      showOverlay('menu-overlay', false);
      showOverlay('about-overlay', true);
    });
    bus.on('aboutBackRequested', function () {
      UIState = 'menu';
      showOverlay('about-overlay', false);
      showOverlay('menu-overlay', true);
    });
    bus.on('profileRequested', function () {
      UIState = 'profile';
      refreshProfileUI();
      showOverlay('menu-overlay', false);
      showOverlay('profile-overlay', true);
    });
    bus.on('profileBackRequested', function () {
      UIState = 'menu';
      showOverlay('profile-overlay', false);
      showOverlay('menu-overlay', true);
    });
    bus.on('profileResetRequested', function () {
      if (profileResetArmed) {
        profileResetArmed = false;
        if (LG.Progression && LG.Progression.reset) LG.Progression.reset();
        if (LG.Tournament && LG.Tournament.reset) LG.Tournament.reset();
        LG.HUD.updateCoins();
        refreshProfileUI();
        refreshChallengesUI();
        var rb = document.getElementById('btn-profile-reset');
        if (rb) rb.textContent = 'RESET PROFILE';
        LG.HUD.toast('PROFILE RESET');
      } else {
        profileResetArmed = true;
        var rb2 = document.getElementById('btn-profile-reset');
        if (rb2) rb2.textContent = 'CONFIRM RESET?';
      }
    });
    bus.on('challengesRequested', function () {
      UIState = 'challenges';
      refreshChallengesUI();
      showOverlay('menu-overlay', false);
      showOverlay('challenges-overlay', true);
    });
    bus.on('challengesBackRequested', function () {
      UIState = 'menu';
      showOverlay('challenges-overlay', false);
      showOverlay('menu-overlay', true);
    });
    bus.on('pauseHowRequested', function () {
      howFromPause = true;
      UIState = 'how';
      showOverlay('pause-overlay', false);
      showOverlay('how-overlay', true);
    });
    bus.on('howBackRequested', function () {
      showOverlay('how-overlay', false);
      if (howFromPause) {
        UIState = 'paused';
        showOverlay('pause-overlay', true);
      } else {
        UIState = 'menu';
        showOverlay('menu-overlay', true);
      }
      howFromPause = false;
    });

    bus.on('menuBackRequested', function () {
      // STAR BACK returns to difficulty (unchanged); difficulty BACK is handled above
      UIState = 'diff';
      refreshDifficultyUI();
      showOverlay('select-overlay', false);
      showOverlay('diff-overlay', true);
    });

    // STAR -> PLAYER STYLE (kit colors for both sides)
    bus.on('selectConfirmed', function () {
      UIState = 'style';
      showOverlay('select-overlay', false);
      showOverlay('style-overlay', true);
      buildKitRoom();
    });

    bus.on('styleBackRequested', function () {
      UIState = 'select';
      if (LG.KitRoom) LG.KitRoom.stop();
      showOverlay('style-overlay', false);
      showOverlay('select-overlay', true);
    });

    // PLAYER STYLE -> COURT SELECTION
    bus.on('styleConfirmed', function () {
      UIState = 'court';
      if (LG.KitRoom) LG.KitRoom.stop();
      buildCourtGrid();
      showOverlay('style-overlay', false);
      showOverlay('court-overlay', true);
    });

    bus.on('courtBackRequested', function () {
      UIState = 'style';
      showOverlay('court-overlay', false);
      showOverlay('style-overlay', true);
      if (LG.KitRoom) { refreshKitRoom(); LG.KitRoom.start(); }
    });

    // COURT SELECTION -> MATCH SETUP (day/night + portrait/landscape)
    bus.on('courtConfirmed', function () {
      UIState = 'setup';
      refreshSettingsUI();
      showOverlay('court-overlay', false);
      showOverlay('setup-overlay', true);
    });

    bus.on('setupBackRequested', function () {
      UIState = 'court';
      showOverlay('setup-overlay', false);
      showOverlay('court-overlay', true);
    });

    bus.on('startMatchRequested', function () {
      startMatch(selectedId);
    });

    bus.on('pauseRequested', function () {
      if (UIState !== 'match') return;
      UIState = 'paused';
      if (LG.Hub) LG.Hub.pauseBoard(match);
      showOverlay('pause-overlay', true);
      LG.Audio.crowdStop();
      LG.Input.setEnabled(false);
      // a charged shot held across the pause must not fire on resume
      if (match) {
        match.all.forEach(function (p) {
          p.shotCharge = 0;
          p.wasShooting = false;
        });
        if (match.active) {
          match.active.shotCharge = 0;
          match.active.wasShooting = false;
        }
      }
    });
    bus.on('resumeRequested', function () {
      UIState = 'match';
      showOverlay('pause-overlay', false);
      lastNow = nowSec();
      LG.Audio.crowd(0.5);
    });

    bus.on('quitRequested', function () {
      UIState = 'menu';
      profileResetArmed = false;
      resultActionLock = false;
      // Build 6: leaving a friend match closes the link; the guest books nothing
      if (match && match.opts && match.opts.online === 'guest') match._finalized = true;
      if (LG.Net && LG.Net.role()) { var wasHost = LG.Net.role() === 'host'; if (!wasHost || match === null || match._finalized) LG.Net.leave(); else setTimeout(function () { LG.Net.leave(); }, 400); }
      restoreOnlineConditions();
      // leaving mid-match still books the unfinished game once (never re-books)
      if (match && !match._finalized && match.clock !== undefined) {
        quitting = true;
        match.endMatch();
        quitting = false;
      }
      if (match) clearMatchFromScene();
      LG.Input.reset();
      LG.HUD.clearTags();
      LG.HUD.setModeChip('');
      showOverlay('pause-overlay', false);
      showOverlay('result-overlay', false);
      showOverlay('profile-overlay', false);
      showOverlay('challenges-overlay', false);
      showOverlay('mode-overlay', false);
      showOverlay('challenge-pick-overlay', false);
      showOverlay('tournament-overlay', false);
      showOverlay('settings-overlay', false);
      showOverlay('about-overlay', false);
      showOverlay('how-overlay', false);
      howFromPause = false;
      settingsResetArmed = false;
      profileResetArmed = false;
      refreshSettingsScreen();
      showMatchUI(false);
      showOverlay('menu-overlay', true);
      LG.Particles.clear();
      camCtrl.reset();
      LG.Audio.crowdStop();
    });

    bus.on('rematchRequested', function () {
      if (LG.Modes && LG.Modes.is('tournament')) {
        var T = LG.Tournament;
        // results board: only a finished cup may START OVER (resets state)
        if (UIState === 'result') {
          if (resultActionLock || !T || !T.canRetry()) return;
          resultActionLock = true;
          T.reset();
          T.start(selectedId);
          showOverlay('result-overlay', false);
          startMatch(selectedId);
          resultActionLock = false;
          return;
        }
        // mid-match / pause RESTART re-runs the same fixture only
        if (UIState === 'paused' || UIState === 'match') startMatch(selectedId);
        return;
      }
      startMatch(selectedId);
    });

    bus.on('matchStart', function () {
      LG.HUD.reset(match);
      refreshModeChip();
      // short match-start beat: the board already shows both teams, this card
      // holds the freeze — READY, whistle, then the ball goes live
      LG.Audio.sfx.ready();
      LG.HUD.banner('READY', '', 900);
    });
    bus.on('clock', function (e) { LG.HUD.setClock(e.t); });
    // Golden Goal: tied at 0:00 — sudden death, next goal wins
    bus.on('goldenGoal', function () {
      LG.HUD.banner('GOLDEN GOAL', 'team1', 2200);
      LG.HUD.toast('NEXT GOAL WINS', 2400);
      if (LG.HUD.setGolden) LG.HUD.setGolden(true);
    });
    bus.on('matchStart', function () { if (LG.HUD.setGolden) LG.HUD.setGolden(false); });

    bus.on('goal', function (g) {
      var mine = g.team === 0;
      var who = g.scorer && g.scorer.name ? String(g.scorer.name).toUpperCase() : '';
      LG.HUD.banner(mine ? (who ? who + ' SCORES!' : 'GOAL!') : 'CONCEDED', mine ? 'team1' : 'team2', 1800);
      LG.HUD.flash(mine ? 'rgba(236,225,200,0.32)' : 'rgba(193,74,53,0.38)', 300);
      LG.HUD.setScore(g.score[0], g.score[1]);
      if (mine) camCtrl.pulse(0.5);
    });

    // goal celebration cinematic: takes the camera for the GOAL window only,
    // bound after the HUD listener so its snapshot sees the goal pulse
    if (LG.GoalCinematic) LG.GoalCinematic.bind(function () { return match; });

    bus.on('state', function (s) {
      // say KICKOFF the moment the ball is live — during the freeze itself
      // the READY card (match start) or the GOAL banner already holds the screen
      if (s.state === 'PLAY') LG.HUD.toast('KICKOFF', 800);
    });

    bus.on('abilityReady', function (p) {
      LG.HUD.toast(LG.Abilities[p.def.ability].name + ' READY!', 1300);
    });

    bus.on('abilityActivated', function (p) {
      var ab = LG.Abilities[(p.active && p.active.id) || p.def.ability];
      var n = ab ? ab.label : '';
      // Build 6: say whose move it is — yours, a mate's or the CPU's
      LG.HUD.banner('★ ' + n + ' ★', p.team === 0 ? 'team1' : 'team2', 1100);
      if (p.team === 1) LG.HUD.toast((p.name || 'ROGUE') + ' USED ' + n, 1200);
      LG.HUD.flash('rgba(196,106,43,0.4)', 220);
      camCtrl.pulse(0.8);
    });

    bus.on('tackleWin', function (t) {
      if (t.src.isHuman) { LG.HUD.toast('ROCKED THEM!', 900); LG.HUD.flash('rgba(169,199,122,0.2)', 180); }
      camCtrl.shake(0.2, 0.22);
    });

    bus.on('perfectPass', function () { LG.HUD.toast('LASER PASS', 800); });

    bus.on('keeperSave', function (e) {
      var me = (match.home || []).indexOf(e.gk) >= 0;
      if (me) { LG.HUD.toast(e.parry ? 'GUARD PUNCHES IT OUT!' : 'GUARD GRABS IT!', 1200); LG.HUD.flash('rgba(169,199,122,0.16)', 180); }
      else { LG.HUD.toast(e.parry ? 'WHAT A PARADE!' : 'KEEPER CLAIMS IT!', 1200); }
    });

    bus.on('switchPlayer', function () {
      LG.HUD.updateSpecial(match.active);
    });

    bus.on('matchEnd', function (r) {
      // Tournament books each fixture once here — even a quit-to-menu mid
      // match still records (MatchManager already finalized the profile).
      // Phase 3B challenge rewards stay solely inside Progression.finalizeMatch.
      if (r && !r._tournamentBooked && LG.Modes && LG.Modes.is('tournament') && LG.Tournament) {
        if (LG.Tournament.endMatch(r.won === 1, r.score)) r._tournamentBooked = true;
      }
      // ignore a late end from a match we already replaced (quit/rematch)
      if (quitting || match === null) return;
      if (LG.ModeCtrl) LG.ModeCtrl.hud(false);
      UIState = 'result';
      resultActionLock = false;
      LG.Input.reset();
      LG.Audio.crowdStop();
      LG.HUD.setModeChip('');
      // PHASE 5.1 — a deliberate ending: one full-time banner over the final
      // whistle before the board slides in. (Quit paths never get here — the
      // quitting guard above owns them.)
      LG.HUD.banner('FULL TIME', r.won === 1 ? 'team1' : r.won === -1 ? 'team2' : '', 1600);
      var endedMatch = match;
      setTimeout(function () {
        if (match !== endedMatch) return; // match was replaced (rematch/quit) while waiting
        showMatchUI(false);
        showOverlay('result-overlay', true);
        setupResult(r);
      }, 900);
    });
  }

  // ---------------- Build 6: FRIEND MATCH screen ----------------
  function bindFriendUI() {
    var $ = function (id) { return document.getElementById(id); };
    function click(id, fn) { var b = $(id); if (b) b.addEventListener('click', function () { LG.Audio.sfx.click(); fn(); }); }
    function setTxt(id, t) { var e = $(id); if (e) e.textContent = t; }
    function showCode(c) {
      var box = $('friend-code');
      if (!box) return;
      box.innerHTML = '';
      for (var i = 0; i < 6; i++) { var d = document.createElement('span'); d.textContent = c ? c[i] : '·'; box.appendChild(d); }
    }
    click('btn-friend', function () {
      if (UIState !== 'menu') return;
      UIState = 'friend';
      showOverlay('menu-overlay', false);
      showOverlay('friend-overlay', true);
      var me = LG.byId(selectedId);
      setTxt('friend-you', 'You play as ' + (me ? me.name : 'your star') + ' — change your star in KICK OFF.');
      showCode('');
      setTxt('friend-host-status', ''); setTxt('friend-join-status', '');
    });
    click('btn-friend-back', function () {
      if (LG.Net) LG.Net.leave();
      UIState = 'menu';
      showOverlay('friend-overlay', false);
      showOverlay('menu-overlay', true);
    });
    click('btn-friend-host', function () {
      if (!LG.Net) return;
      if (LG.Audio.unlock) LG.Audio.unlock();
      showCode(LG.Net.host());
    });
    click('btn-friend-copy', function () {
      var c = LG.Net && LG.Net.code();
      if (!c) return;
      try { navigator.clipboard.writeText(c); LG.HUD.toast('CODE COPIED', 900); } catch (e) { /* no clipboard */ }
    });
    var inp = $('friend-input');
    if (inp && inp.addEventListener) inp.addEventListener('input', function () { inp.value = LG.Net ? LG.Net.cleanCode(inp.value) : inp.value; });
    click('btn-friend-join', function () {
      if (!LG.Net || !inp) return;
      if (LG.Audio.unlock) LG.Audio.unlock();
      LG.Net.join(inp.value);
    });
    if (!LG.Net) return;
    LG.Net.on('status', function (e) {
      var el = LG.Net.role() === 'guest' ? 'friend-join-status' : 'friend-host-status';
      setTxt(el, e.msg || '');
      var w = $(el); if (w && w.classList) w.classList.toggle('err', e.status === 'error');
    });
    LG.Net.on('start', function (e) { if (UIState === 'friend') startOnline(e.role, e.setup); });
    LG.Net.on('closed', function () {
      if (UIState === 'match' || UIState === 'paused') {
        LG.HUD.toast('YOUR FRIEND LEFT', 2200);
        if (match && match.opts.online === 'host' && !match._finalized) match.endMatch();
        else if (match && match.opts.online === 'guest') setTimeout(function () { LG.eventBus.emit('quitRequested'); }, 1600);
      }
    });
  }

  // ---------------- match settings (Time of Day / View) ----------------
  function bindSettingsUI() {
    bindFriendUI();
    function on(id, fn) {
      var b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', function () { LG.Audio.sfx.click(); fn(); });
    }
    on('time-day', function () { setTimeOfDay('day'); });
    on('time-dusk', function () { setTimeOfDay('dusk'); });
    on('time-night', function () { setTimeOfDay('night'); });
    on('time-blackout', function () { setTimeOfDay('blackout'); });
    on('weather-dry', function () { setWeather('dry'); });
    on('weather-rain', function () { setWeather('rain'); });
    on('weather-fog', function () { setWeather('fog'); });
    on('weather-wind', function () { setWeather('wind'); });
    ['empty', 'locals', 'busy', 'packed'].forEach(function (c) {
      on('crowd-' + c, function () { LG.Settings.setCrowd(c); applyConditions(); refreshSettingsUI(); });
    });
    ['off', 'low', 'med', 'full'].forEach(function (l) {
      on('life-' + l, function () { LG.Settings.setLife(l); applyConditions(); refreshSettingsUI(); });
    });
    on('view-portrait', function () { setView('portrait'); });
    on('view-landscape', function () { setView('landscape'); });
    // Settings screen (Phase 4) — same stores, separate controls
    on('settings-day', function () { setTimeOfDay('day'); refreshSettingsScreen(); });
    on('settings-night', function () { setTimeOfDay('night'); refreshSettingsScreen(); });
    on('settings-dusk', function () { setTimeOfDay('dusk'); refreshSettingsScreen(); });
    on('settings-blackout', function () { setTimeOfDay('blackout'); refreshSettingsScreen(); });
    on('settings-weather-dry', function () { setWeather('dry'); refreshSettingsScreen(); });
    on('settings-weather-rain', function () { setWeather('rain'); refreshSettingsScreen(); });
    on('settings-portrait', function () { setView('portrait'); refreshSettingsScreen(); });
    on('settings-landscape', function () { setView('landscape'); refreshSettingsScreen(); });
    on('vol-master-0', function () { LG.Settings.setVolMaster(0); refreshSettingsScreen(); });
    on('vol-master-50', function () { LG.Settings.setVolMaster(0.5); refreshSettingsScreen(); });
    on('vol-master-100', function () { LG.Settings.setVolMaster(1); refreshSettingsScreen(); });
    on('vol-sfx-0', function () { LG.Settings.setVolSfx(0); refreshSettingsScreen(); });
    on('vol-sfx-50', function () { LG.Settings.setVolSfx(0.5); refreshSettingsScreen(); });
    on('vol-sfx-100', function () { LG.Settings.setVolSfx(1); refreshSettingsScreen(); });
    on('vol-crowd-0', function () { LG.Settings.setVolCrowd(0); refreshSettingsScreen(); });
    on('vol-crowd-50', function () { LG.Settings.setVolCrowd(0.5); refreshSettingsScreen(); });
    on('vol-crowd-100', function () { LG.Settings.setVolCrowd(1); refreshSettingsScreen(); });
    on('vol-music-0', function () { LG.Settings.setVolMusic(0); refreshSettingsScreen(); });
    on('vol-music-50', function () { LG.Settings.setVolMusic(0.5); refreshSettingsScreen(); });
    on('vol-music-100', function () { LG.Settings.setVolMusic(1); refreshSettingsScreen(); });
    on('gfx-auto', function () { setQuality('auto'); refreshSettingsScreen(); });
    on('gfx-low', function () { setQuality('low'); refreshSettingsScreen(); });
    on('gfx-medium', function () { setQuality('medium'); refreshSettingsScreen(); });
    on('gfx-high', function () { setQuality('high'); refreshSettingsScreen(); });
    on('rm-on', function () { setReducedMotion(true); refreshSettingsScreen(); });
    on('rm-off', function () { setReducedMotion(false); refreshSettingsScreen(); });
    on('btn-settings-reset', function () { requestSettingsReset(); });
    on('btn-bug-fill', function () { fillBugReport(); });
    on('btn-bug-copy', function () { copyBugReport(); });
    // stamp versions from the single source
    var ver = (LG.Config && LG.Config.version) || '0.0.0';
    var mv = document.getElementById('menu-version');
    if (mv) mv.textContent = 'v' + ver;
    var av = document.getElementById('about-version');
    if (av) av.textContent = ver;
    applyReducedMotionClass();
    LG.Audio.applyVolumes();
  }

  function setReducedMotion(on) {
    LG.Settings.setReducedMotion(on);
    applyReducedMotionClass();
    if (camCtrl) { camCtrl.shakeT = 0; camCtrl.shakeAmp = 0; camCtrl.zoomPulse = 0; }
  }

  function applyReducedMotionClass() {
    var on = LG.Settings.reducedMotion();
    document.body.classList.toggle('reduced-motion', on);
  }

  function markSelected(id, on) {
    var b = document.getElementById(id);
    if (b) b.classList.toggle('selected', !!on);
  }

  function volBucket(v) {
    if (v <= 0.01) return 0;
    if (v <= 0.6) return 50;
    return 100;
  }

  function refreshSettingsScreen() {
    var tod = LG.Settings.timeOfDay();
    var view = LG.Settings.view();
    markSelected('settings-day', tod === 'day');
    markSelected('settings-dusk', tod === 'dusk');
    markSelected('settings-night', tod === 'night');
    markSelected('settings-blackout', tod === 'blackout');
    markSelected('settings-weather-dry', LG.Settings.weather() === 'dry');
    markSelected('settings-weather-rain', LG.Settings.weather() === 'rain');
    markSelected('settings-portrait', view === 'portrait');
    markSelected('settings-landscape', view === 'landscape');
    var mb = volBucket(LG.Settings.volMaster());
    var sb = volBucket(LG.Settings.volSfx());
    var cb = volBucket(LG.Settings.volCrowd());
    markSelected('vol-master-0', mb === 0);
    markSelected('vol-master-50', mb === 50);
    markSelected('vol-master-100', mb === 100);
    markSelected('vol-sfx-0', sb === 0);
    markSelected('vol-sfx-50', sb === 50);
    markSelected('vol-sfx-100', sb === 100);
    markSelected('vol-crowd-0', cb === 0);
    markSelected('vol-crowd-50', cb === 50);
    markSelected('vol-crowd-100', cb === 100);
    var mb2 = volBucket(LG.Settings.volMusic());
    markSelected('vol-music-0', mb2 === 0);
    markSelected('vol-music-50', mb2 === 50);
    markSelected('vol-music-100', mb2 === 100);
    var gq = LG.Settings.quality();
    markSelected('gfx-auto', gq === 'auto');
    markSelected('gfx-low', gq === 'low');
    markSelected('gfx-medium', gq === 'medium');
    markSelected('gfx-high', gq === 'high');
    var gn = document.getElementById('gfx-note');
    if (gn) gn.textContent = gq === 'auto' ? 'AUTO IS USING ' + LG.Settings.qualityLevel(IS_MOBILE).toUpperCase() + ' ON THIS DEVICE' : '';
    markSelected('rm-on', LG.Settings.reducedMotion());
    markSelected('rm-off', !LG.Settings.reducedMotion());
    var rb = document.getElementById('btn-settings-reset');
    if (rb) {
      rb.textContent = settingsResetArmed ? 'CONFIRM WIPE?' : 'RESET PROGRESS';
      rb.classList.toggle('selected', settingsResetArmed);
    }
    refreshSettingsUI();
  }

  // Clears profile / challenges / tournament; keeps display, audio, difficulty, court.
  function requestSettingsReset() {
    if (!settingsResetArmed) {
      settingsResetArmed = true;
      refreshSettingsScreen();
      return;
    }
    settingsResetArmed = false;
    if (LG.Progression && LG.Progression.reset) LG.Progression.reset();
    if (LG.Tournament && LG.Tournament.reset) LG.Tournament.reset();
    if (LG.Modes && LG.Modes.reset) LG.Modes.reset();
    selectedChallengeFocus = null;
    selectedMode = 'quick_match';
    LG.HUD.updateCoins();
    refreshProfileUI();
    refreshChallengesUI();
    refreshSettingsScreen();
    LG.HUD.toast('PROGRESS RESET');
  }

  function fillBugReport() {
    var box = document.getElementById('bug-report-box');
    if (!box) return;
    var ver = (LG.Config && LG.Config.version) || '0.0.0';
    var lines = [];
    lines.push('BLACKOUT bug report');
    lines.push('version: ' + ver);
    lines.push('time: ' + new Date().toISOString());
    lines.push('state: ' + UIState);
    lines.push('mode: ' + ((LG.Modes && LG.Modes.id) ? LG.Modes.id() : '-'));
    lines.push('viewport: ' + window.innerWidth + 'x' + window.innerHeight);
    lines.push('mobile: ' + isMobile);
    lines.push('view: ' + LG.Settings.view() + '  tod: ' + LG.Settings.timeOfDay());
    lines.push('reducedMotion: ' + LG.Settings.reducedMotion());
    lines.push('difficulty: ' + ((LG.Difficulty && LG.Difficulty.get) ? LG.Difficulty.get() : '-'));
    lines.push('court: ' + ((LG.Courts && LG.Courts.selected) ? LG.Courts.selected() : '-'));
    lines.push('coins: ' + ((LG.Progression && LG.Progression.coins) ? LG.Progression.coins() : '-'));
    lines.push('matches: ' + ((LG.Progression && LG.Progression.career) ? (LG.Progression.career().matches || 0) : '-'));
    lines.push('tournament: ' + ((LG.Tournament && LG.Tournament.status) ? LG.Tournament.status() : '-'));
    lines.push('ua: ' + (navigator.userAgent || 'unknown'));
    lines.push('storage: ' + (function () {
      try {
        localStorage.setItem('__bo_probe__', '1');
        localStorage.removeItem('__bo_probe__');
        return 'ok';
      } catch (e) { return 'blocked'; }
    })());
    lines.push('---');
    lines.push('What happened?');
    lines.push('Steps to reproduce:');
    box.value = lines.join('\n');
    var st = document.getElementById('bug-copy-status');
    if (st) st.textContent = 'REPORT READY — USE COPY';
  }

  function copyBugReport() {
    var box = document.getElementById('bug-report-box');
    var st = document.getElementById('bug-copy-status');
    if (!box) return;
    if (!box.value) fillBugReport();
    function done(ok) { if (st) st.textContent = ok ? 'COPIED TO CLIPBOARD' : 'SELECT ALL AND COPY MANUALLY'; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(function () { done(true); }, function () { fallbackCopy(box, done); });
    } else {
      fallbackCopy(box, done);
    }
  }

  function fallbackCopy(box, done) {
    try {
      box.focus();
      box.select();
      var ok = document.execCommand && document.execCommand('copy');
      done(!!ok);
    } catch (e) { done(false); }
  }

  function refreshAboutUI() {
    var ver = (LG.Config && LG.Config.version) || '0.0.0';
    var av = document.getElementById('about-version');
    if (av) av.textContent = ver;
    var box = document.getElementById('bug-report-box');
    if (box && !box.value) fillBugReport();
    var st = document.getElementById('bug-copy-status');
    if (st) st.textContent = '';
  }

  function setTimeOfDay(m) {
    LG.Settings.setTimeOfDay(m);
    // cheap reconfigure — the environment is already built, only the lighting
    // presets are re-applied (no rebuild, no reload)
    LG.Lighting.setMode(LG.Settings.timeOfDay());
    if (LG.Weather) LG.Weather.set(LG.Settings.weather());   // fog rides on the time's fog
    refreshSettingsUI();
  }

  // Build 6: crowd + street life levels onto the living street
  function applyConditions() {
    try {
      if (LG.Crowd && LG.Crowd.setDensity) LG.Crowd.setDensity(LG.Settings.crowdFrac());
      if (LG.Living && LG.Living.setLife) LG.Living.setLife(LG.Settings.lifeFrac());
      if (LG.StreetLife && LG.StreetLife.setLevel) LG.StreetLife.setLevel(LG.Settings.lifeFrac());
    } catch (e) { /* a level change must never break the menu */ }
  }

  // Build 5: rain on/off — re-wets the current surface, no rebuild
  function setWeather(w) {
    LG.Settings.setWeather(w);
    if (LG.Weather) LG.Weather.set(LG.Settings.weather());
    refreshSettingsUI();
  }

  function setView(m) {
    LG.Settings.setView(m);
    // The phone stays landscape for BOTH views — only the camera pose and HUD
    // follow the choice. Never lock portrait (a portrait lock fought the rotate
    // prompt and left the device stuck upright for a landscape-world camera).
    requestOrientation('landscape');
    updateRotate();
    refreshSettingsUI();
    updateLayoutClass();
    if (LG.DBG) LG.DBG.log('[orientation] ' + LG.Settings.view());
  }

  function refreshSettingsUI() {
    var tod = LG.Settings.timeOfDay();
    var view = LG.Settings.view();
    var pairs = [
      ['time-day', tod === 'day'], ['time-dusk', tod === 'dusk'],
      ['time-night', tod === 'night'], ['time-blackout', tod === 'blackout'],
      ['weather-dry', LG.Settings.weather() === 'dry'], ['weather-rain', LG.Settings.weather() === 'rain'],
      ['weather-fog', LG.Settings.weather() === 'fog'], ['weather-wind', LG.Settings.weather() === 'wind'],
      ['crowd-empty', LG.Settings.crowd() === 'empty'], ['crowd-locals', LG.Settings.crowd() === 'locals'],
      ['crowd-busy', LG.Settings.crowd() === 'busy'], ['crowd-packed', LG.Settings.crowd() === 'packed'],
      ['life-off', LG.Settings.life() === 'off'], ['life-low', LG.Settings.life() === 'low'],
      ['life-med', LG.Settings.life() === 'med'], ['life-full', LG.Settings.life() === 'full'],
      ['view-portrait', view === 'portrait'], ['view-landscape', view === 'landscape'],
    ];
    for (var i = 0; i < pairs.length; i++) {
      var b = document.getElementById(pairs[i][0]);
      if (b) b.classList.toggle('selected', pairs[i][1]);
    }
    // one line under MATCH SETUP saying what the pick does to the street
    var note = document.getElementById('setup-note');
    if (note) {
      var wet = LG.Settings.weather() === 'rain';
      var NOTE = {
        day: 'DAY: hard sun and long shadows.',
        dusk: 'DUSK: low orange sun; lamps and windows are coming on.',
        night: 'NIGHT: floodlights on, headlights on the ring road.',
        blackout: 'BLACKOUT: the power is cut. Moonlight, a flickering generator lamp and car headlights light the court.',
      };
      var WX = { dry: '', rain: ' RAIN: wet, shiny asphalt reflects the lights and slides spray water.',
        fog: ' FOG: the far end of the court fades out; long passes are harder to read.',
        wind: ' WIND: gusts blow dust across and bend balls in the air.' };
      var CR = { empty: ' Empty stands.', locals: ' A few locals watching.', busy: ' Busy stands.', packed: ' Packed stands.' };
      note.textContent = (NOTE[tod] || '') + (WX[LG.Settings.weather()] || '');
      var eff = document.getElementById('court-effect');
      if (eff) eff.textContent = note.textContent + (CR[LG.Settings.crowd()] || '') +
        (LG.Settings.life() === 'off' ? ' Quiet street: no traffic or walkers.' : '');
    }
  }

  // Re-apply the environment options to the arena: with courtSwitch it also
  // swaps the pitch surface (court change); without it the surface stays put
  // while the lighting re-collects + re-applies the chosen time of day. This
  // is what makes the DAY/NIGHT setting actually reach the rendered match (and
  // keeps a new court's lights/signs on the selected atmosphere).
  function refreshEnvironment(courtSwitch) {
    if (courtSwitch && arenaObj && arenaObj.refreshCourt) arenaObj.refreshCourt();
    if (LG.Lighting) {
      LG.Lighting.collect(scene);
      LG.Lighting.setMode(LG.Settings.timeOfDay());
    }
    if (LG.Weather) LG.Weather.set(LG.Settings.weather());
    applyConditions();
  }

  // Reflect the selected level on the difficulty screen.
  function refreshDifficultyUI() {
    var cur = LG.Difficulty.get();
    var levels = LG.Difficulty.LEVELS;
    for (var i = 0; i < levels.length; i++) {
      var btn = document.getElementById('diff-' + levels[i]);
      if (btn) btn.classList.toggle('selected', levels[i] === cur);
    }
  }

  function setupResult(r) {
    var modeId = (LG.Modes && typeof LG.Modes.id === 'function') ? LG.Modes.id() : 'quick_match';
    var T = LG.Tournament;
    var title = document.getElementById('result-title');
    var note = document.getElementById('result-mode-note');
    var btnContinue = document.getElementById('btn-continue');
    var btnRematch = document.getElementById('btn-rematch');
    var btnSetup = document.getElementById('btn-result-setup');
    var modeTag = document.getElementById('result-mode-tag');

    // mode-aware headline
    var headline;
    if (modeId === 'tournament' && T) {
      if (T.status() === 'won') headline = 'CUP WON';
      else if (T.status() === 'eliminated') headline = T.currentRound() === 1 ? 'FINAL LOST' : 'SEMIFINAL LOST';
      else headline = 'SEMIFINAL WON'; // active + advanced after a semi win
    } else if (modeId === 'challenge_match') {
      var focusDone = false;
      var completed = r.completedChallenges || [];
      var focusId = (LG.Modes && LG.Modes.challenge) ? LG.Modes.challenge() : null;
      for (var fi = 0; fi < completed.length; fi++) {
        if (focusId && completed[fi].id === focusId) { focusDone = true; break; }
      }
      if (focusDone) headline = 'CHALLENGE CLEARED';
      else headline = r.won === 1 ? 'MATCH WON' : r.won === 0 ? 'DRAW' : 'MATCH LOST';
    } else if (r.ctrl === 'shootout') {
      headline = r.won === 1 ? 'SHOOTOUT WON' : 'SHOOTOUT LOST';
    } else if (r.ctrl === 'yard') {
      headline = 'TRAINING DONE';
    } else if (r.online) {
      headline = r.won === 1 ? 'YOU BEAT YOUR FRIEND' : r.won === 0 ? 'DRAW' : 'YOUR FRIEND WON';
    } else {
      headline = r.won === 1 ? 'MATCH WON' : r.won === 0 ? 'DRAW' : 'MATCH LOST';
    }

    title.className = 'result-title ' + (r.won === 1 ? 'win' : r.won === 0 ? 'draw' : 'lose');
    title.textContent = headline;

    if (modeTag) {
      var tagText = modeId === 'tournament' && T ? ('STREET CUP · ' + T.roundLabel())
        : modeId === 'challenge_match' ? 'CHALLENGE MATCH'
        : r.online ? 'FRIEND MATCH · ONLINE'
        : (LG.Modes && LG.Modes.def(modeId)) ? LG.Modes.def(modeId).name
        : 'QUICK MATCH';
      modeTag.textContent = tagText;
      modeTag.classList.remove('hidden');
    }

    document.getElementById('res-home').textContent = r.score[0];
    document.getElementById('res-away').textContent = r.score[1];
    document.getElementById('res-coins-n').textContent = '+' + U.fmtMoney(r.coins);
    if (LG.Hub) LG.Hub.resultCoins(r);
    // Build 6: shootout dots / drill scores
    var msAway = document.getElementById('ms-away-name');
    if (msAway) msAway.textContent = r.online ? 'FRIEND' : (r.awayName && r.awayName !== 'YOU' ? r.awayName : 'ROGUE');
    var sumEl = document.getElementById('res-summary');
    if (sumEl) {
      sumEl.innerHTML = '';
      (r.summary || []).forEach(function (line) { var d = document.createElement('div'); d.className = 'rs-line'; d.textContent = line; sumEl.appendChild(d); });
      sumEl.classList.toggle('hidden', !(r.summary && r.summary.length));
    }
    if (r.ctrl === 'yard') document.getElementById('res-coins-n').textContent = '+' + U.fmtMoney((r.summary && match && match.ctrl ? match.ctrl.results.reduce(function (a, x) { return a + x.coins; }, 0) : 0));
    // match statistics table (missing stats degrades to zeros / 50%)
    var s = r.stats || {};
    var h = s.home || {};
    var a = s.away || {};
    var map = [
      ['st-h-g', 'st-a-g', 'goals', 0],
      ['st-h-as', 'st-a-as', 'assists', 0],
      ['st-h-s', 'st-a-s', 'shots', 0],
      ['st-h-p', 'st-a-p', 'passes', 0],
      ['st-h-t', 'st-a-t', 'tackles', 0],
      ['st-h-sv', 'st-a-sv', 'saves', 0],
    ];
    for (var i = 0; i < map.length; i++) {
      var he = document.getElementById(map[i][0]);
      var ae = document.getElementById(map[i][1]);
      if (he) he.textContent = h[map[i][2]] != null ? h[map[i][2]] : map[i][3];
      if (ae) ae.textContent = a[map[i][2]] != null ? a[map[i][2]] : map[i][3];
    }
    var hp = document.getElementById('st-h-po');
    var ap = document.getElementById('st-a-po');
    if (hp) hp.textContent = (h.poss != null ? h.poss : 50) + '%';
    if (ap) ap.textContent = (a.poss != null ? a.poss : 50) + '%';

    // challenges completed this match (empty list is fine — never punitive)
    var chList = document.getElementById('res-ch-list');
    var chEmpty = document.getElementById('res-ch-empty');
    var chCoins = document.getElementById('res-ch-coins');
    var completedAll = r.completedChallenges || [];
    if (chList) {
      chList.innerHTML = '';
      for (var ci = 0; ci < completedAll.length; ci++) {
        var c = completedAll[ci];
        var li = document.createElement('li');
        li.className = 'pf-row ch-done';
        li.innerHTML = '<span class="ch-check">✓</span>' +
          '<span class="ch-title">' + c.title + '</span>' +
          '<span class="ch-desc">' + (c.description || '') + '</span>' +
          '<span class="pf-c">+' + c.reward + '</span>';
        chList.appendChild(li);
      }
    }
    if (chEmpty) chEmpty.classList.toggle('hidden', completedAll.length > 0);
    if (chCoins) {
      var chAmt = r.challengeCoins || 0;
      chCoins.classList.toggle('hidden', !chAmt);
      chCoins.innerHTML = chAmt ? '<span class="coin"></span><span>+ ' + chAmt + ' CHALLENGES</span>' : '';
    }

    // mode-aware action row (idempotent labels + visibility)
    resultActionLock = false;
    if (btnContinue && btnRematch && btnSetup) {
      var showContinue = modeId === 'tournament' && T && T.canContinue(false);
      var showRetryCup = modeId === 'tournament' && T && T.canRetry();
      if (modeId === 'tournament') {
        btnContinue.classList.toggle('hidden', !showContinue);
        btnRematch.textContent = 'NEW TOURNAMENT';
        btnRematch.classList.toggle('hidden', !showRetryCup);
        btnRematch.classList.add('gold');
        btnSetup.classList.add('hidden');
      } else if (modeId === 'challenge_match') {
        btnContinue.classList.add('hidden');
        btnRematch.textContent = 'RETRY';
        btnRematch.classList.remove('hidden');
        btnRematch.classList.add('gold');
        btnSetup.classList.remove('hidden');
      } else {
        btnContinue.classList.add('hidden');
        btnRematch.textContent = 'REMATCH';
        btnRematch.classList.remove('hidden');
        btnRematch.classList.add('gold');
        btnSetup.classList.remove('hidden');
      }
      // Build 6: a friend match ends with MAIN MENU only (host a new code to replay)
      if (r.online) { btnRematch.classList.add('hidden'); btnSetup.classList.add('hidden'); }
    }
    if (note) {
      if (modeId === 'tournament') note.textContent = 'ONE CUP · TWO WINS · NO SHORTCUTS';
      else if (modeId === 'challenge_match') note.textContent = 'FOCUSED CHALLENGE PAYS VIA THE ACTIVE SET';
      else note.textContent = '+ COINS UNLOCK MORE STARS';
    }

    LG.HUD.updateCoins();
    if (r.won === 1) LG.Audio.sfx.resultWin();
    else if (r.won === 0) LG.Audio.sfx.resultDraw();
    else LG.Audio.sfx.resultLose();
  }

  // Fill the profile card from the single source of truth (safe on missing nodes).
  function refreshProfileUI() {
    var P = LG.Progression;
    if (!P) return;
    var c = (P.career && P.career()) || {};
    var best = (P.best && P.best()) || { goals: 0, wins: 0, streak: 0 };
    function set(id, v) {
      var el = document.getElementById(id);
      if (el) el.textContent = v;
    }
    set('pf-coins', U.fmtMoney(P.coins ? P.coins() : 0));
    set('pf-matches', c.matches || 0);
    set('pf-wins', c.wins || 0);
    set('pf-draws', c.draws || 0);
    set('pf-losses', c.losses || 0);
    set('pf-winrate', (P.winRate ? P.winRate() : 0) + '%');
    set('pf-gf', c.goalsFor || 0);
    set('pf-ga', c.goalsAgainst || 0);
    set('pf-cs', c.cleanSheets || 0);
    set('pf-assists', c.assists || 0);
    set('pf-shots', c.shots || 0);
    set('pf-tackles', c.tackles || 0);
    set('pf-saves', c.saves || 0);
    set('pf-streak', best.streak || 0);
    set('pf-best', best.goals || 0);

    var list = document.getElementById('pf-history');
    if (!list) return;
    var hist = (P.history && P.history()) || [];
    list.innerHTML = '';
    if (!hist.length) {
      var empty = document.createElement('li');
      empty.className = 'pf-empty';
      empty.textContent = 'NO MATCHES YET — KICK OFF';
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < hist.length && i < 5; i++) {
      var e = hist[i];
      var li = document.createElement('li');
      li.className = 'pf-row ' + (e.won === 1 ? 'w' : e.won === -1 ? 'l' : 'd');
      var res = e.won === 1 ? 'W' : e.won === -1 ? 'L' : 'D';
      li.innerHTML = '<span class="pf-res">' + res + '</span>' +
        '<span class="pf-sc">' + e.score[0] + '–' + e.score[1] + '</span>' +
        '<span class="pf-meta">' + (e.difficulty || 'match') + (e.court ? ' · ' + e.court : '') + '</span>' +
        '<span class="pf-c">+' + e.coins + '</span>';
      list.appendChild(li);
    }
    var rb = document.getElementById('btn-profile-reset');
    if (rb) rb.textContent = 'RESET PROFILE';
    profileResetArmed = false;
  }

  // Active challenges screen — 3 slots, pure defs from LG.Challenges.
  function refreshChallengesUI() {
    var list = document.getElementById('challenge-list');
    if (!list) return;
    list.innerHTML = '';
    var act = (LG.Progression && LG.Progression.activeChallenges) ? LG.Progression.activeChallenges() : [];
    if (!act.length) {
      var empty = document.createElement('div');
      empty.className = 'pf-empty';
      empty.textContent = 'NO ACTIVE CHALLENGES';
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < act.length; i++) {
      var def = LG.Challenges && LG.Challenges.byId ? LG.Challenges.byId(act[i]) : null;
      if (!def) continue;
      var card = document.createElement('div');
      card.className = 'challenge-card ch-' + def.difficulty;
      card.innerHTML =
        '<div class="challenge-head">' +
          '<span class="challenge-title">' + def.title + '</span>' +
          '<span class="challenge-diff">' + def.difficulty.toUpperCase() + '</span>' +
        '</div>' +
        '<div class="challenge-desc">' + def.description + '</div>' +
        '<div class="challenge-meta">' +
          '<span class="challenge-target">' + challengeTargetLabel(def) + '</span>' +
          '<span class="challenge-reward"><span class="coin"></span>+' + def.reward + '</span>' +
        '</div>';
      list.appendChild(card);
    }
  }

  function challengeTargetLabel(def) {
    switch (def.objectiveType) {
      case 'cleanSheet': return 'CLEAN SHEET';
      case 'win': return '1 WIN';
      case 'winBy': return 'WIN BY ' + def.target + '+';
      default: return 'TARGET ' + def.target;
    }
  }

  // ---------------- mode / tournament UI (Phase 3D) ----------------
  // Build 5 mode tiles: icon, kicker, name, blurb. Three planned modes are
  // shown as SOON tiles that cannot be picked (they are on the roadmap).
  var MODE_ICON = {
    quick_match: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5l4 3-1.5 4.5h-5L8 10.5z',
    challenge_match: 'M12 3l2.6 5.5 6 .8-4.4 4.2 1.1 6L12 16.6 6.7 19.5l1.1-6L3.4 9.3l6-.8z',
    tournament: 'M7 4h10v4a5 5 0 01-10 0zM7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4M12 13v4M8 21h8M9 17h6',
    first_to_5: 'M5 21V4M5 4h11l-2 4 2 4H5',
    street_twist: 'M20 14A8 8 0 1110 4a6 6 0 0010 10z',
    penalty_shootout: 'M3 20V6h18v14M3 10h18M8 6v14M16 6v14',
    the_yard: 'M4 20l4-8 4 4 4-10 4 14M3 20h18',
    rumble: 'M13 2L4 14h7l-1 8 9-12h-7z',
  };
  var MODE_SOON = [];   // Build 6: all three are playable now
  var MODE_SOON_OLD = [
    { name: 'PENALTY SHOOTOUT', blurb: 'Five kicks each. Aim, charge, shoot, then dive the right way.', icon: 'M3 20V6h18v14M3 10h18M8 6v14M16 6v14' },
    { name: 'THE YARD', blurb: 'Training drills with 3-star scores.', icon: 'M4 20l4-8 4 4 4-10 4 14M3 20h18' },
    { name: 'RUMBLE', blurb: 'Grab orbs on the court to fire any of the 8 abilities.', icon: 'M13 2L4 14h7l-1 8 9-12h-7z' },
  ];
  // tolerant attribute write (the headless boot harness uses a tiny fake DOM)
  function setAttr(el, k, v) { if (el && el.setAttribute) el.setAttribute(k, v); }
  function modeIcon(d) {
    return '<svg class="mode-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  function refreshModeUI() {
    var list = document.getElementById('mode-list');
    if (!list) return;
    list.innerHTML = '';
    var modes = (LG.Modes && LG.Modes.list) ? LG.Modes.list() : [];
    var T = LG.Tournament;
    for (var i = 0; i < modes.length; i++) {
      (function (m) {
        var card = document.createElement('div');
        card.className = 'mode-card mode-' + m.id + (m.id === selectedMode ? ' selected' : '');
        card.dataset.id = m.id;
        setAttr(card, 'role', 'button');
        setAttr(card, 'tabindex', '0');
        setAttr(card, 'aria-pressed', m.id === selectedMode ? 'true' : 'false');
        var tw = m.id === 'street_twist' && LG.Modes.twistInfo ? LG.Modes.twistInfo('daily') : null;
        var tag = m.id === 'tournament' ? (T && T.active() ? 'IN PROGRESS · ' + T.roundLabel() : 'KNOCKOUT · 4 TEAMS')
          : m.id === 'challenge_match' ? 'USES YOUR 3 ACTIVE CHALLENGES'
          : m.id === 'first_to_5' ? 'NO CLOCK PRESSURE · NO DRAWS'
          : m.id === 'penalty_shootout' ? 'NEW · 5 KICKS EACH'
          : m.id === 'the_yard' ? 'NEW · TRAINING · 3 DRILLS'
          : m.id === 'rumble' ? 'NEW · POWER-UP ORBS'
          : tw ? 'TODAY: ' + tw.label
          : 'STANDARD MATCH';
        var blurb = tw ? tw.blurb + ' ' + m.blurb : m.blurb;
        card.innerHTML =
          '<div class="mode-top">' + modeIcon(MODE_ICON[m.id] || MODE_ICON.quick_match) + '</div>' +
          '<div class="mode-tag">' + tag + '</div>' +
          '<div class="mode-name">' + m.name + '</div>' +
          '<div class="mode-blurb">' + blurb + '</div>';
        function pick() {
          selectedMode = m.id;
          if (LG.Modes) LG.Modes.select(m.id);
          refreshModeUI();
          LG.Audio.sfx.click();
        }
        card.addEventListener('click', pick);
        card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        list.appendChild(card);
      })(modes[i]);
    }
    for (var j = 0; j < MODE_SOON.length; j++) {
      var sd = MODE_SOON[j];
      var sc = document.createElement('div');
      sc.className = 'mode-card mode-soon';
      setAttr(sc, 'aria-disabled', 'true');
      sc.innerHTML =
        '<div class="mode-top">' + modeIcon(sd.icon) + '<span class="mode-badge">SOON</span></div>' +
        '<div class="mode-tag">ON THE ROADMAP</div>' +
        '<div class="mode-name">' + sd.name + '</div>' +
        '<div class="mode-blurb">' + sd.blurb + '</div>';
      list.appendChild(sc);
    }
  }

  function refreshChallengePickUI() {
    var list = document.getElementById('challenge-pick-list');
    if (!list) return;
    list.innerHTML = '';
    var act = (LG.Progression && LG.Progression.activeChallenges) ? LG.Progression.activeChallenges() : [];
    if (!act.length) {
      var empty = document.createElement('div');
      empty.className = 'pf-empty';
      empty.textContent = 'NO ACTIVE CHALLENGES';
      list.appendChild(empty);
      return;
    }
    if (!selectedChallengeFocus || act.indexOf(selectedChallengeFocus) < 0) {
      selectedChallengeFocus = act[0];
    }
    if (LG.Modes) LG.Modes.selectChallenge(selectedChallengeFocus);
    for (var i = 0; i < act.length; i++) {
      (function (id) {
        var def = LG.Challenges && LG.Challenges.byId ? LG.Challenges.byId(id) : null;
        if (!def) return;
        var card = document.createElement('div');
        card.className = 'challenge-card ch-' + def.difficulty +
          (id === selectedChallengeFocus ? ' selected-focus' : '');
        card.dataset.id = id;
        if (id === selectedChallengeFocus) card.style.outline = '2px solid #14c8db';
        card.innerHTML =
          '<div class="challenge-head">' +
            '<span class="challenge-title">' + def.title + '</span>' +
            '<span class="challenge-diff">' + def.difficulty.toUpperCase() + '</span>' +
          '</div>' +
          '<div class="challenge-desc">' + def.description + '</div>' +
          '<div class="challenge-meta">' +
            '<span class="challenge-target">' + challengeTargetLabel(def) + '</span>' +
            '<span class="challenge-reward"><span class="coin"></span>+' + def.reward + '</span>' +
          '</div>';
        card.addEventListener('click', function () {
          selectedChallengeFocus = id;
          if (LG.Modes) LG.Modes.selectChallenge(id);
          refreshChallengePickUI();
          LG.Audio.sfx.click();
        });
        list.appendChild(card);
      })(act[i]);
    }
  }

  function refreshTournamentUI() {
    var statusEl = document.getElementById('tournament-status');
    var bracket = document.getElementById('tournament-bracket');
    var startBtn = document.getElementById('btn-tournament-start');
    var T = LG.Tournament;
    if (!T) return;
    var st = T.status();
    if (statusEl) {
      if (st === 'idle') statusEl.textContent = '4 TEAMS · SEMIFINAL + FINAL';
      else if (st === 'active') statusEl.textContent = 'IN PROGRESS · ' + T.roundLabel();
      else if (st === 'won') statusEl.textContent = 'CHAMPIONS · START A NEW CUP';
      else statusEl.textContent = 'ELIMINATED · START A NEW CUP';
    }
    if (startBtn) {
      startBtn.textContent = st === 'active' ? 'RESUME' : 'START';
    }
    if (bracket) {
      bracket.innerHTML = '';
      if (st === 'idle' || !T.teams().length) {
        var ph = document.createElement('div');
        ph.className = 'pf-empty';
        ph.textContent = 'DRAW PENDING — HIT START';
        bracket.appendChild(ph);
        return;
      }
      var teams = T.teams();
      var results = T.results();
      // SEMIFINAL column
      var semi = document.createElement('div');
      semi.className = 'tournament-round' + (T.currentRound() === 0 && st === 'active' ? ' active-round' : st !== 'idle' ? ' done-round' : '');
      semi.innerHTML = '<div class="tr-title">SEMIFINAL</div>';
      var you = teams[0], opp = teams[1];
      var semiRes = results[0];
      semi.appendChild(fixtureRow(you, opp, semiRes));
      var otherA = teams[2], otherB = teams[3];
      var otherWin = T.snapshot().otherSemiWinner;
      var row2 = document.createElement('div');
      row2.className = 'tr-fixture';
      row2.innerHTML =
        '<span class="' + (otherWin === otherA.id ? 'win' : 'lose') + '">' + otherA.name + '</span>' +
        '<span class="' + (otherWin === otherB.id ? 'win' : 'lose') + '">' + otherB.name + '</span>';
      semi.appendChild(row2);
      bracket.appendChild(semi);
      // FINAL column
      var fin = document.createElement('div');
      fin.className = 'tournament-round' + (T.currentRound() === 1 && st === 'active' ? ' active-round' : st === 'won' ? ' done-round' : '');
      fin.innerHTML = '<div class="tr-title">FINAL</div>';
      var finRow = document.createElement('div');
      finRow.className = 'tr-fixture';
      var finalRes = results[1];
      var finalOppName = otherWin ? (otherWin === otherA.id ? otherA.name : otherB.name) : '—';
      if (st === 'won') {
        finRow.innerHTML = '<span class="win you">' + you.name + '</span><span class="win">' + finalOppName + '</span>';
      } else if (st === 'eliminated' && T.currentRound() === 1 && finalRes) {
        finRow.innerHTML = '<span class="' + (finalRes.won ? 'win' : 'lose') + ' you">' + you.name + '</span>' +
          '<span class="' + (finalRes.won ? 'lose' : 'win') + '">' + finalOppName + '</span>';
      } else if (st === 'active' && T.currentRound() === 1) {
        finRow.innerHTML = '<span class="you">' + you.name + '</span><span>' + finalOppName + '</span>';
      } else {
        finRow.innerHTML = '<span class="you">' + you.name + '</span><span>' + finalOppName + '</span>';
      }
      fin.appendChild(finRow);
      bracket.appendChild(fin);
    }
  }

  function fixtureRow(a, b, res) {
    var row = document.createElement('div');
    row.className = 'tr-fixture';
    var aCls = a.isPlayer ? 'you' : '';
    var bCls = b.isPlayer ? 'you' : '';
    if (res) {
      // won flag is from the player's perspective on round 0/1 player fixture
      var playerWon = res.won;
      if (a.isPlayer) {
        aCls += playerWon ? ' win' : ' lose';
        bCls += playerWon ? ' lose' : ' win';
      }
      row.innerHTML = '<span class="' + aCls + '">' + a.name + '</span>' +
        '<span class="' + bCls + '">' + b.name + '</span>';
    } else {
      row.innerHTML = '<span class="' + aCls + '">' + a.name + '</span>' +
        '<span class="' + bCls + '">' + b.name + '</span>';
    }
    return row;
  }

  // Non-modal focus chip: mode label + optional live challenge progress.
  function refreshModeChip() {
    if (UIState !== 'match' && UIState !== 'paused') return;
    var modeId = (LG.Modes && LG.Modes.id) ? LG.Modes.id() : 'quick_match';
    if (modeId === 'tournament' && LG.Tournament) {
      LG.HUD.setModeChip(LG.Tournament.summary());
      return;
    }
    if (modeId === 'challenge_match') {
      var def = (LG.Modes && LG.Modes.challenge && LG.Challenges)
        ? LG.Challenges.byId(LG.Modes.challenge()) : null;
      if (!def || !match) { LG.HUD.setModeChip('CHALLENGE MATCH'); return; }
      var live = {
        score: match.score,
        stats: { home: match.stats.home, away: match.stats.away },
        won: null,
      };
      var ev = LG.Challenges.evaluate(def, live, true);
      LG.HUD.setModeChip('CHALLENGE ' + def.title + '  ' + Math.min(ev.progress, def.target) + '/' + def.target);
      return;
    }
    LG.HUD.setModeChip('');
  }

  // ---------------- match lifecycle ----------------
  // one line of startup profiling: how long the match hand-off actually blocks
  // for (rosters = the per-player body builds, the rest = scene/HUD/camera)
  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function startMatch(playerId, online) {
    var t0 = nowMs();
    selectedId = playerId;
    saveLastSetup();
    enterLandscape();
    // consume the selected atmosphere now (also re-collects + re-applies if a
    // court swap added any new lights or emissive signs after boot)
    refreshEnvironment();
    LG.Input.reset();
    if (match) {
      clearMatchFromScene();
    }

    var matchOpts = {
      playerId: playerId, homeName: 'YOU', awayName: 'ROGUE',
      difficulty: LG.Difficulty.get(),
      outfitColor: outfitColor,
      awayColor: awayColor,
      homeStyle: homeStyle,
      awayStyle: awayStyle,
    };

    // Tournament fixture: pin the opponent side + open the once-only latch.
    // Restarting the same fixture reuses an open latch (never double-begins).
    if (LG.Modes && LG.Modes.is('tournament') && LG.Tournament && LG.Tournament.active()) {
      if (!LG.Tournament.snapshot().awaitingResult) LG.Tournament.beginMatch();
      var opp = LG.Tournament.opponent();
      if (opp) {
        var oppDef = LG.byId(opp.id);
        var awayIds = [opp.id];
        var mates = (oppDef && oppDef.team) || [];
        for (var mi = 0; mi < mates.length && awayIds.length < 3; mi++) {
          if (awayIds.indexOf(mates[mi]) < 0) awayIds.push(mates[mi]);
        }
        var fillers = ['stone', 'volt', 'brute', 'echo', 'pulse', 'cannon'];
        for (var fi = 0; fi < fillers.length && awayIds.length < 3; fi++) {
          if (awayIds.indexOf(fillers[fi]) < 0 && fillers[fi] !== playerId) awayIds.push(fillers[fi]);
        }
        matchOpts.awayIds = awayIds;
        matchOpts.awayName = opp.name.toUpperCase();
      }
      matchOpts.mode = 'tournament';
    } else if (LG.Modes && LG.Modes.is('tournament')) {
      // cup not active yet — still label the mode, random draw like quick
      matchOpts.mode = 'tournament';
    } else {
      matchOpts.mode = (LG.Modes && LG.Modes.id) ? LG.Modes.id() : 'quick_match';
    }
    // the mode's rules ride into the match (Phase 10 / 11)
    var rules = (LG.Modes && LG.Modes.rules) ? LG.Modes.rules() : {};
    // Build 6: a FRIEND MATCH is a plain match on the host's setup
    if (online) { rules = { goldenGoal: false, firstTo: 0, duration: 0, twist: null }; matchOpts.mode = 'friend_match'; }
    matchOpts.goldenGoal = !!rules.goldenGoal;
    matchOpts.firstTo = rules.firstTo > 0 ? rules.firstTo : 0;
    matchOpts.duration = rules.duration > 0 ? rules.duration : 0;
    // twists bend Config for THIS match only: always cleared first
    matchOpts.twist = (LG.Modes && LG.Modes.applyTwist) ? LG.Modes.applyTwist(rules.twist) : null;

    // phone screens get one extra size bump, baked into every player as it is
    // built (model + collision body + height move together) — see LG.Config.player
    if (LG.Player) LG.Player.deviceScale = isMobile ? (LG.Config.player.mobileScale || 1) : 1;
    if (online) {
      var S = online.setup;
      matchOpts.online = online.role;
      matchOpts.awayIds = S.awayIds;
      matchOpts.outfitColor = S.homeKit; matchOpts.awayColor = S.awayKit;
      matchOpts.homeStyle = S.homeStyle; matchOpts.awayStyle = S.awayStyle;
      matchOpts.homeName = online.role === 'host' ? 'YOU' : 'FRIEND';
      matchOpts.awayName = online.role === 'host' ? 'FRIEND' : 'YOU';
      matchOpts.noAISpecials = false;
    }

    var t1 = nowMs();
    match = new LG.MatchManager(matchOpts);
    var t2 = nowMs();
    match.attachScene(scene, arenaObj);
    match.camera = camCtrl;
    match.selectActive();
    // Build 6: shootout / yard / rumble ride on the match as a controller
    match.ctrl = online ? (online.role === 'host' ? new LG.Net.HostCtrl(match) : new LG.Net.GuestCtrl(match))
      : ((LG.ModeCtrl && LG.ModeCtrl.create) ? LG.ModeCtrl.create(matchOpts.mode) : null);
    if (LG.ModeCtrl && !match.ctrl) LG.ModeCtrl.hud(false);

    // the ball is read a touch larger on phones only
    if (isMobile && match.ball && match.ball.mesh) {
      match.ball.mesh.scale.set(1.25, 1.25, 1.25);
      match.ball.r *= 1.25;
    }

    showMatchUI(true);

    // HUD.reset + mode chip ride the matchStart event below — one reset, not two
    camCtrl.reset();
    camCtrl.pulse(0.6);
    LG.Particles.clear();
    match.start();
    if (match.ctrl && match.ctrl.start) match.ctrl.start(match);
    UIState = 'match';
    // announce the bent rule (Phase 11)
    try {
      if (matchOpts.twist && LG.Modes.twistInfo) { var ti = LG.Modes.twistInfo(matchOpts.twist); LG.HUD.toast(ti.label + ' — ' + ti.blurb.toUpperCase(), 2600); }
      else if (matchOpts.firstTo) LG.HUD.toast('FIRST TO ' + matchOpts.firstTo + ' WINS', 2400);
    } catch (e) { /* cosmetic */ }
    syncMusic();   // stop now, not on the next frame — the whistle and the menu
    lastNow = nowSec();
    console.log('[START] match setup ' + (nowMs() - t0).toFixed(1) + 'ms (rosters ' +
      (t2 - t1).toFixed(1) + 'ms, env+ui ' + (t1 - t0).toFixed(1) + 'ms)');
  }

  function clearMatchFromScene() {
    if (match.ctrl && match.ctrl.stop) { try { match.ctrl.stop(); } catch (e) { /* cosmetic */ } }
    if (match.ball && match.ball.mesh) scene.remove(match.ball.mesh);
    if (match.ballGlow) scene.remove(match.ballGlow);
    if (match.carrierMark) scene.remove(match.carrierMark);
    var all = match.all || [];
    for (var i = 0; i < all.length; i++) {
      var p = all[i];
      scene.remove(p.model.group);
      if (p.ring) scene.remove(p.ring);
      if (p.auraMesh) scene.remove(p.auraMesh);
    }
    match = null;
  }

  function showMatchUI(on) {
    document.getElementById('controls').classList.toggle('hidden', !on);
    document.getElementById('scoreboard').classList.toggle('hidden', !on);
    document.getElementById('pause-btn').classList.toggle('hidden', !on);
    document.getElementById('coin-chip').classList.toggle('hidden', false);
    var overlays = ['menu-overlay', 'mode-overlay', 'challenge-pick-overlay', 'tournament-overlay', 'diff-overlay', 'select-overlay', 'style-overlay', 'court-overlay', 'setup-overlay', 'how-overlay', 'settings-overlay', 'about-overlay', 'profile-overlay', 'challenges-overlay', 'pause-overlay', 'result-overlay', 'friend-overlay'];
    for (var i = 0; i < overlays.length; i++) document.getElementById(overlays[i]).classList.add('hidden');
  }

  function showMenu(on) {
    if (on && LG.Modes && LG.Modes.clearTwist) LG.Modes.clearTwist();   // twists never outlive their match
    showOverlay('menu-overlay', on);
    document.getElementById('coin-chip').classList.toggle('hidden', false);
    document.getElementById('controls').classList.add('hidden');
    document.getElementById('scoreboard').classList.add('hidden');
    document.getElementById('pause-btn').classList.add('hidden');
  }

  function showOverlay(id, on) {
    if (id === 'menu-overlay' && on) {
      if (LG.Modes && LG.Modes.clearTwist) LG.Modes.clearTwist();       // twists never outlive their match
      refreshQuickPlayLabel();
      if (LG.Hub) LG.Hub.refresh();
    }
    var el = document.getElementById(id);
    if (!el) return;
    if (on) {
      el.classList.remove('hidden');
      el.classList.remove('leaving');
      // force reflow so re-showing the same panel replays paste-in
      if (el.offsetWidth != null) void el.offsetWidth;
    } else {
      // class flips synchronously (tests + a11y); the CSS carries the exit —
      // .overlay.hidden keeps the board laid out so paste-out can play,
      // then flips visibility. Never delays the hide.
      el.classList.add('leaving');
      el.classList.add('hidden');
      clearTimeout(el._hideT);
      el._hideT = setTimeout(function () { el.classList.remove('leaving'); }, 220);
    }
  }

  // ---------------- character select UI ----------------
  // Build 5 star cards: OVR (the average of the six stats), six stat bars,
  // the ability with its one-line description, and the unlock price.
  function ovrOf(stats) {
    var names = ['speed', 'shoot', 'pass', 'dribble', 'defense', 'stamina'], t = 0;
    for (var i = 0; i < names.length; i++) t += stats[names[i]] || 0;
    return Math.round(t / names.length * 10);
  }

  function buildSelectGrid() {
    var grid = document.getElementById('char-grid');
    grid.innerHTML = '';
    for (var i = 0; i < LG.Roster.length; i++) {
      (function (def, idx) {
        var card = document.createElement('div');
        card.className = 'char-card' + (def.id === selectedId ? ' selected' : '');
        setAttr(card, 'role', 'button');
        setAttr(card, 'tabindex', '0');
        var pal = def.palette;
        var color = '#' + pal.shirt.toString(16).padStart(6, '0');
        var ab = LG.Abilities && LG.Abilities[def.ability];
        if (card.style && card.style.setProperty) card.style.setProperty('--kit', color);
        card.innerHTML =
          '<div class="cc-top">' +
            '<div class="char-ovr"><b>' + ovrOf(def.stats) + '</b><span>OVR</span></div>' +
            '<div class="cc-id"><div class="crole">' + def.role + '</div><div class="cname">' + def.name + '</div></div>' +
          '</div>' +
          '<div class="cstats">' + statRows(def.stats) + '</div>' +
          (ab ? '<div class="cc-ab"><b>' + ab.label + '</b><span>' + ab.desc + '</span></div>' : '');
        card.dataset.id = def.id;
        card.addEventListener('click', function () {
          onCardClick(def, card);
        });
        card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCardClick(def, card); } });
        grid.appendChild(card);
        refreshCardLock(card, def);
      })(LG.Roster[i], i);
    }
  }

  function statRows(stats) {
    var names = ['speed', 'shoot', 'pass', 'dribble', 'defense', 'stamina'];
    var html = '';
    for (var i = 0; i < names.length; i++) {
      var v = stats[names[i]];
      html += '<div class="stat-row"><span class="sn">' + names[i] + '</span><b>' + v + '</b>' +
        '<i class="stat-bar"><i style="width:' + Math.max(0, Math.min(10, v)) * 10 + '%"></i></i></div>';
    }
    return html;
  }

  function onCardClick(def, card) {
    if (!LG.Progression.isUnlocked(def.id)) {
      var cost = LG.Progression.costOf(def.id);
      if (LG.Progression.unlock(def.id)) {
        LG.Audio.sfx.specialReady();
        LG.HUD.updateCoins();
        refreshCardLock(card, def);
      } else {
        LG.HUD.toast('NEED ' + cost + ' COINS');
        LG.Audio.sfx.click();
        return;
      }
    }
    selectedId = def.id;
    var cards = document.querySelectorAll('.char-card');
    for (var i = 0; i < cards.length; i++) cards[i].classList.remove('selected');
    card.classList.add('selected');
    LG.Audio.sfx.click();
  }

  // Locked stars stay selectable: tapping buys them if the coins are there
  // (the toast says the price otherwise). Presentation only — the underlying
  // progression/unlock system is untouched, but the full-card lock overlay
  // and coin emoji are gone in favour of one quiet price line.
  function refreshCardLock(card, def) {
    var price = card.querySelector('.price');
    if (!LG.Progression.isUnlocked(def.id)) {
      card.classList.add('locked');
      if (!price) {
        price = document.createElement('span');
        price.className = 'price';
        card.appendChild(price);
      }
      var cost = LG.Progression.costOf(def.id), have = LG.Progression.coins();
      price.textContent = have >= cost ? 'TAP TO UNLOCK · ' + cost + ' COINS' : cost + ' COINS · ' + (cost - have) + ' TO GO';
    } else {
      card.classList.remove('locked');
      if (price) price.remove();
    }
  }

  // ---------------- player style / customization UI ----------------
  // The two squads must never end up in the same kit. YOUR kit always wins
  // the pick: if the Rogue Squad was wearing it, it slides to the first color
  // that is not yours. A Rogue pick that would mirror YOUR kit is refused
  // (the note under the grid says why), so the clash can never happen.
  function resolveKitClash() {
    if (!outfitColor || !awayColor || awayColor.id !== outfitColor.id) return;
    for (var i = 0; i < LG.OutfitColors.length; i++) {
      if (LG.OutfitColors[i].id !== outfitColor.id) { awayColor = LG.OutfitColors[i]; return; }
    }
  }

  // ---------------- kit room (Build 4) ----------------
  // Two live players: YOUR TEAM and the ROGUE SQUAD. Tap a player for the
  // next kit colour (never the other team's), tap the orb under them for the
  // next kit style. Looks (hair, accessory, skin) are dealt by LG.KitRoom.
  var kitLooks = null;
  function kitColour(side) {
    var c = side === 'home' ? outfitColor : awayColor;
    if (c) return c;
    var want = side === 'home' ? (LG.Config.kits && LG.Config.kits.home) : (LG.Config.kits && LG.Config.kits.away);
    for (var i = 0; i < LG.OutfitColors.length; i++) if (LG.OutfitColors[i].color === want) return LG.OutfitColors[i];
    return LG.OutfitColors[side === 'home' ? 1 : 0];
  }
  function nextKitColour(side) {
    var cur = kitColour(side), other = kitColour(side === 'home' ? 'away' : 'home');
    var L = LG.OutfitColors, i;
    for (i = 0; i < L.length; i++) if (L[i].id === cur.id) break;
    var n = L[(i + 1) % L.length];
    if (n.id === other.id) n = L[(i + 2) % L.length];
    if (side === 'home') outfitColor = n; else awayColor = n;
  }
  function rogueDef() {
    var mine = LG.byId(selectedId);
    var team = (mine && mine.team) || [];
    var pool = ['stone', 'echo', 'volt', 'cannon', 'brute', 'blaze'];
    for (var i = 0; i < pool.length; i++) {
      if (pool[i] !== selectedId && team.indexOf(pool[i]) < 0 && LG.byId(pool[i])) return LG.byId(pool[i]);
    }
    return LG.byId('stone') || mine;
  }
  function buildKitRoom() {
    if (!LG.KitRoom) return;
    kitLooks = { home: LG.KitRoom.looks(1)[0], away: LG.KitRoom.looks(1)[0] };
    LG.KitRoom.mount('home', document.getElementById('kit-home-canvas'));
    LG.KitRoom.mount('away', document.getElementById('kit-away-canvas'));
    ['home', 'away'].forEach(function (side) {
      var player = document.getElementById('kit-' + side + '-player');
      var orb = document.getElementById('kit-' + side + '-orb');
      if (player && !player._kitBound) {
        player._kitBound = 1;
        player.addEventListener('click', function () {
          nextKitColour(side);
          refreshKitRoom();
          LG.Audio.sfx.click();
        });
      }
      if (orb && !orb._kitBound) {
        orb._kitBound = 1;
        orb.addEventListener('click', function () {
          if (side === 'home') homeStyle = LG.KitRoom.nextStyle(homeStyle);
          else awayStyle = LG.KitRoom.nextStyle(awayStyle);
          refreshKitRoom();
          LG.Audio.sfx.click();
        });
      }
    });
    refreshKitRoom();
    LG.KitRoom.start();
  }
  function refreshKitRoom() {
    if (!LG.KitRoom) return;
    homeStyle = LG.KitRoom.validStyle(homeStyle, 'home');
    awayStyle = LG.KitRoom.validStyle(awayStyle, 'away');
    ['home', 'away'].forEach(function (side) {
      var c = kitColour(side), other = kitColour(side === 'home' ? 'away' : 'home');
      var style = side === 'home' ? homeStyle : awayStyle;
      var team = side === 'home' ? 'YOUR TEAM' : 'ROGUE SQUAD';
      var el = function (id) { return document.getElementById('kit-' + side + '-' + id); };
      if (el('colour')) el('colour').textContent = c.label;
      if (el('style')) el('style').textContent = LG.KitRoom.styleLabel(style);
      if (el('floor')) el('floor').style.background = c.hex;
      var orbEl = el('orb'), playerEl = el('player');
      if (orbEl && orbEl.style && orbEl.style.setProperty) orbEl.style.setProperty('--kit', c.hex);
      if (orbEl && orbEl.setAttribute) orbEl.setAttribute('aria-label', team + ' kit style ' + LG.KitRoom.styleLabel(style) + ', tap to change');
      if (playerEl && playerEl.setAttribute) playerEl.setAttribute('aria-label', team + ' kit colour ' + c.label + ', tap to change');
      if (el('dots')) {
        var html = '';
        for (var i = 0; i < LG.OutfitColors.length; i++) {
          var d = LG.OutfitColors[i];
          html += '<span class="kit-dot' + (d.id === c.id ? ' on' : '') + (d.id === other.id ? ' taken' : '') +
            '" style="background:' + d.hex + '"></span>';
        }
        el('dots').innerHTML = html;
      }
      var base = side === 'home' ? LG.byId(selectedId) : rogueDef();
      var def = JSON.parse(JSON.stringify(base || {}));
      def.palette = def.palette || {};
      def.palette.shirt = c.color; def.palette.pants = c.color;
      var live = base && kitLooks ? LG.KitRoom.show(side, def, style, kitLooks[side]) : false;
      var badge = el('badge');
      if (badge) {
        badge.style.display = live ? 'none' : 'flex';
        badge.style.background = c.hex;
        badge.textContent = LG.KitRoom.styleLabel(style);
      }
    });
    saveLastSetup();
  }
  // ---------------- court picker UI ----------------
  function buildCourtGrid() {
    var grid = document.getElementById('court-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var list = (LG.Courts && LG.Courts.list()) || [];
    var selected = LG.Courts ? LG.Courts.selected() : '';

    // procedural / classic tile
    (function () {
      var t = document.createElement('div');
      t.className = 'court-btn' + (selected === '' ? ' selected' : '');
      t.innerHTML =
        '<div class="court-thumb procedural">CLASSIC<br>&nbsp;STREET</div>' +
        '<div class="court-name">CLASSIC</div>';
      t.addEventListener('click', function () {
        if (!LG.Courts) return;
        LG.Courts.set('');
        refreshEnvironment(true);
        LG.Audio.sfx.click();
        refreshCourtGrid();
      });
      grid.appendChild(t);
    })();

    // court tiles
    for (var i = 0; i < list.length; i++) {
      (function (c) {
        var t = document.createElement('div');
        t.className = 'court-btn' + (selected === c.id ? ' selected' : '');
        var name = c.name || ('COURT ' + c.id.replace('court', ''));
        t.innerHTML =
          '<img class="court-thumb" src="courts/' + c.file + '" alt="' + name + '" loading="lazy">' +
          '<div class="court-name">' + name + '</div>';
        t.addEventListener('click', function () {
          if (!LG.Courts) return;
          LG.Courts.set(c.id);
          refreshEnvironment(true);
          LG.Audio.sfx.click();
          refreshCourtGrid();
        });
        grid.appendChild(t);
      })(list[i]);
    }

    refreshCourtGrid();
  }

  function refreshCourtGrid() {
    var grid = document.getElementById('court-grid');
    if (!grid) return;
    var selected = LG.Courts ? LG.Courts.selected() : '';
    var list = (LG.Courts && LG.Courts.list()) || [];
    var btns = grid.querySelectorAll('.court-btn');
    for (var i = 0; i < btns.length; i++) {
      var id = i === 0 ? '' : (list[i - 1] ? list[i - 1].id : '');
      btns[i].classList.toggle('selected', id === selected);
    }
    // Build 6: name the pick under the strip and count the grounds
    var nm = 'CLASSIC STREET';
    for (var j = 0; j < list.length; j++) if (list[j].id === selected) nm = list[j].name || nm;
    var sel = document.getElementById('court-sel-name');
    if (sel) sel.textContent = nm;
    var cnt = document.getElementById('court-count');
    if (cnt) cnt.textContent = (list.length + 1) + ' GROUNDS';
    refreshSettingsUI();
  }

  // Apply outfit colors to a player definition (returns a new palette)
  function applyOutfit(def) {
    if (!outfitColor) return def.palette; // regular clothes: keep original
    var p = JSON.parse(JSON.stringify(def.palette));
    p.shirt = outfitColor.color;
    p.shoe = outfitColor.color;
    return p;
  }

  // ---------------- loop ----------------
  var lastNow = nowSec();
  function nowSec() { return performance.now() / 1000; }

  var MENU_ORBIT = { mode: 1, challengePick: 1, tournament: 1, diff: 1, select: 1, style: 1, court: 1, setup: 1,
    settings: 1, about: 1, profile: 1, challenges: 1, how: 1, friend: 1 };
  function loop() {
    requestAnimationFrame(loop);
    var now = nowSec();
    var dt = U.clamp(now - lastNow, 0, 0.05);
    lastNow = now;

    LG.Input.setEnabled(UIState === 'match');
    LG.Input.update(now);
    bgT += dt;
    // dimension guard: integer reads only, no layout, no allocation. The
    // browser is allowed to change the visible size without a usable event
    // (or with one that fired before the numbers settled), so the layout is
    // re-verified against reality every frame instead of trusting the events.
    var vw = Math.max(1, Math.round(window.innerWidth || 1));
    var vh = Math.max(1, Math.round(window.innerHeight || 1));
    var vdpr = Math.min(window.devicePixelRatio || 1, maxDpr());
    if (vw !== vpW || vh !== vpH || vdpr !== vpDPR) scheduleViewportLayout();
    syncMusic();
    updateRotate();

    if (UIState === 'match') {
      match.update(dt);
      // camera: while the goal cinematic owns it, camCtrl.update must not
      // run — it would overwrite the cinematic pose in the same frame
      if (LG.GoalCinematic && LG.GoalCinematic.active()) {
        // frozen/celebration states have zero velocity, so this is the raw
        // target — the cinematic stays bit-for-bit on its own maths
        LG.GoalCinematic.update(dt, match.active.x, match.active.z, match.ball.x, match.ball.z);
      } else {
        // PHASE 4.5 — velocity LEAD for the follow camera (broadcast style):
        // aim slightly ahead of the carrier so the action sits in frame
        // instead of dragging at the edge. Outside the cinematic block, so
        // goal-cinematic.js's mirrored follow maths needs no change. Frozen
        // states hold velocity at zero, so there is nothing to lead on.
        var act = match.active;
        var leadX = act.x + U.clamp(act.vx * 0.24, -1.6, 1.6);
        var leadZ = act.z + U.clamp(act.vz * 0.24, -1.6, 1.6);
        camCtrl.update(dt, leadX, leadZ, match.ball.x, match.ball.z);
      }
      // Build 6: a mode can frame its own shot (the shootout's behind-the-kicker view)
      var mc = match.ctrl && match.ctrl.cam ? match.ctrl.cam() : null;
      if (mc && camera) { camera.position.set(mc.p[0], mc.p[1], mc.p[2]); camera.lookAt(mc.l[0], mc.l[1], mc.l[2]); }
      LG.HUD.updateSpecial(match.active);
      LG.HUD.updateCoins();
      LG.HUD.aim(match.active.shotCharge > 0.15 && match.active.hasBall);
      // particles must keep running through GOAL — otherwise the celebration
      // confetti freezes in mid-air for the whole goalDelay
      LG.Particles.update(dt);
      arenaObj.update(dt);
      if (LG.Living) LG.Living.update(dt);
    } else if (UIState === 'menu' || MENU_ORBIT[UIState]) {
      // idle cinematic drift — Build 5: the live street shows behind every
      // pre-match menu, so the drift keeps going on all of them
      var a = bgT * 0.06;
      camera.position.set(Math.sin(a) * 30, 21, Math.cos(a) * 30 + 6);
      camera.lookAt(0, 0, 0);
      LG.Particles.update(dt);
      arenaObj.update(dt);
      if (LG.Living) LG.Living.update(dt);
    } else if (UIState === 'paused' || (UIState === 'how' && howFromPause)) {
      // PHASE 5.1 — hold the match camera EXACTLY where it was. Writing the
      // menu's overhead pose here used to make RESUME snap back to the follow
      // camera; a frozen pose means pause → resume is seamless. P/ESC also
      // resumes (the buttons do the same) — the press is edge-read, so one
      // key = one toggle.
      if (UIState === 'paused' && LG.Input.pressed('pause')) LG.eventBus.emit('resumeRequested');
    } else {
      // R on the results screen = rematch (the button does the same thing)
      if (UIState === 'result' && LG.Input.pressed('rematch')) LG.eventBus.emit('rematchRequested');
      camera.position.set(0, 19, 24);
      camera.lookAt(0, 0, 0);
    }

    // Build 5: blackout flicker + rain keep moving behind the menus too,
    // and freeze with the match on pause
    if (UIState !== 'paused') {
      if (LG.Lighting.update) LG.Lighting.update(dt);
      if (LG.Weather) LG.Weather.update(dt);
    }

    // review hook (tools/look.js): a parked camera wins over the loop's own
    // pose for this frame only. Absent in normal play — one property read.
    var lc = window.__lookCam;
    if (lc && lc.p && lc.l) {
      camera.position.set(lc.p[0], lc.p[1], lc.p[2]);
      camera.lookAt(lc.l[0], lc.l[1], lc.l[2]);
      if (lc.f && Math.abs(camera.fov - lc.f) > 0.01) { camera.fov = lc.f; camera.updateProjectionMatrix(); }
    }

    renderer.render(scene, camera);
  }

  // PWA service worker registration. A phone that has already run an older
  // worker keeps being served the OLD game out of its cache with no way to see
  // the fix, so: never serve the worker script from HTTP cache, force an update
  // check on every load, and take the new build as soon as it takes over — but
  // ONLY while the boot cover is still on screen. Reloading after the menu is
  // up is a visible "game appears, disappears, appears again" plus a second
  // full init (every shader compiled twice: that is startup lag you can feel).
  // Arriving too late for an invisible swap simply leaves this session on the
  // old build: the new worker is already installed, so its build lands on the
  // next visit, and the once-per-session latch still applies either way.
  if ('serviceWorker' in navigator && navigator.serviceWorker) {
    window.addEventListener('load', function () {
      var sw = navigator.serviceWorker;
      var hadController = !!sw.controller;
      var reloaded = false;
      sw.addEventListener('controllerchange', function () {
        if (!hadController || reloaded) return;
        var load = document.getElementById('loading-overlay');
        if (!load || load.classList.contains('hidden')) return;   // too late to swap invisibly
        try {
          if (sessionStorage.getItem('blockout.swReload')) return;
          sessionStorage.setItem('blockout.swReload', '1');
        } catch (e) { return; }
        reloaded = true;
        location.reload();
      });
      sw.register('./service-worker.js', { updateViaCache: 'none' })
        .then(function (reg) { reg.update(); })
        .catch(function () {});
    });
  }

  // boot
  window.addEventListener('load', init);
  // ---------------- Build 6: FRIEND MATCH glue ----------------
  var savedConditions = null;
  function restoreOnlineConditions() {
    if (!savedConditions) return;
    var c = savedConditions; savedConditions = null;
    try {
      if (LG.Courts) LG.Courts.set(c.court);
      LG.Settings.setTimeOfDay(c.tod); LG.Settings.setWeather(c.weather);
      LG.Settings.setCrowd(c.crowd); LG.Settings.setLife(c.life);
      refreshEnvironment(true);
    } catch (e) { /* cosmetic */ }
  }
  // host: the setup both phones will build (host's star, court, conditions)
  function onlineSetup(guestStar, guestKit) {
    var g = LG.byId(guestStar) ? guestStar : 'cannon';
    var gd = LG.byId(g), awayIds = [g];
    (gd.team || []).forEach(function (id) { if (awayIds.length < 3 && awayIds.indexOf(id) < 0) awayIds.push(id); });
    ['stone', 'volt', 'brute', 'echo', 'pulse', 'cannon'].forEach(function (id) { if (awayIds.length < 3 && awayIds.indexOf(id) < 0) awayIds.push(id); });
    var awayKit = (guestKit && guestKit.color != null && (!outfitColor || guestKit.color !== outfitColor.color)) ? guestKit : awayColor;
    return {
      hostStar: selectedId, awayIds: awayIds,
      homeKit: outfitColor, awayKit: awayKit, homeStyle: homeStyle, awayStyle: (guestKit && guestKit.style) || awayStyle,
      court: LG.Courts ? LG.Courts.selected() : '', tod: LG.Settings.timeOfDay(), weather: LG.Settings.weather(),
      crowd: LG.Settings.crowd(), life: LG.Settings.life(),
    };
  }
  function startOnline(roleName, setup) {
    if (roleName === 'guest') {
      savedConditions = { court: LG.Courts ? LG.Courts.selected() : '', tod: LG.Settings.timeOfDay(), weather: LG.Settings.weather(), crowd: LG.Settings.crowd(), life: LG.Settings.life() };
      if (LG.Courts) LG.Courts.set(setup.court || '');
      LG.Settings.setTimeOfDay(setup.tod); LG.Settings.setWeather(setup.weather);
      LG.Settings.setCrowd(setup.crowd); LG.Settings.setLife(setup.life);
      refreshEnvironment(true);
    }
    showOverlay('friend-overlay', false);
    startMatch(roleName === 'host' ? selectedId : setup.hostStar, { role: roleName, setup: setup });
    LG.HUD.toast(roleName === 'host' ? 'FRIEND MATCH — YOU ARE THE HOME SIDE' : 'FRIEND MATCH — YOU ARE THE AWAY SIDE', 2400);
  }

  window.LGMain = {
    startMatch: startMatch,
    startOnline: startOnline,
    onlineSetup: onlineSetup,
    selections: function () { return { star: selectedId, kit: outfitColor ? { id: outfitColor.id, color: outfitColor.color, style: homeStyle } : null }; },
    getState: function () { return UIState; },
    getMatch: function () { return match; },
    // read-only view of the layout pipeline: the size the renderer was last
    // actually given, and how many times the pipeline has run (a burst of
    // resize/orientation/fullscreen events must cost ONE run, not one each)
    getViewport: function () {
      return { w: vpW, h: vpH, dpr: vpDPR, applies: vpApplies };
    },
    // read-only view of the pre-match choices — used by the boot harness to
    // prove the menu selections really reach the match
    getSelections: function () {
      return {
        player: selectedId,
        homeKit: outfitColor ? outfitColor.id : null,
        awayKit: awayColor ? awayColor.id : null,
        homeStyle: homeStyle, awayStyle: awayStyle,
        difficulty: LG.Difficulty.get(),
        court: LG.Courts ? LG.Courts.selected() : '',
        timeOfDay: LG.Settings.timeOfDay(),
        view: LG.Settings.view(),
      };
    },
  };
})();

