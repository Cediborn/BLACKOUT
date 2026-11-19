// ============================================================
// MODES — the game-mode selection layer over the match engine.
// Modes decide WHY a match is being played; MatchManager decides
// HOW. One current mode + optional challenge focus; tournament
// state lives in LG.Tournament. No per-frame work here.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Modes = (function () {
  var DEFS = [
    {
      id: 'quick_match',
      name: 'QUICK MATCH',
      blurb: 'One friendly. Full setup, full rewards.',
      type: 'quick',
      rules: { goldenGoal: false },
    },
    {
      id: 'challenge_match',
      name: 'CHALLENGE MATCH',
      blurb: 'Focus one active challenge. Clear it for coins.',
      type: 'challenge',
      rules: { goldenGoal: false },
    },
    {
      id: 'tournament',
      name: 'TOURNAMENT',
      blurb: 'Four-team knockout. Win two matches, take the crown. A tie goes to Golden Goal.',
      type: 'tournament',
      rules: { goldenGoal: true },
    },
    {
      id: 'first_to_5',
      name: 'FIRST TO 5',
      blurb: 'No draws. First side to five goals wins. 5:00 cap, then the leader takes it.',
      type: 'quick',
      rules: { firstTo: 5, duration: 300, goldenGoal: true },
    },
    {
      id: 'street_twist',
      name: 'STREET TWIST',
      blurb: 'One rule bent, a new one every day: moon ball, soap floor, big ball or turbo.',
      type: 'quick',
      rules: { twist: 'daily' },
    },
  ];

  var byIdMap = {};
  for (var i = 0; i < DEFS.length; i++) byIdMap[DEFS[i].id] = DEFS[i];

  var currentId = 'quick_match';
  var selectedChallenge = null;

  function list() {
    return DEFS.slice();
  }

  function def(id) {
    return byIdMap[id] || null;
  }

  function current() {
    return def(currentId) || DEFS[0];
  }

  function id() {
    return current().id;
  }

  function is(modeId) {
    return id() === modeId;
  }

  function type() {
    return current().type;
  }

  // Match rules for the current mode (Phase 10). MatchManager reads these
  // through match opts, so a new mode is mostly one DEFS entry. Unknown keys
  // fall back to the quick-match behaviour.
  var DEFAULT_RULES = { goldenGoal: false, firstTo: 0, duration: 0, twist: null };
  function rules(modeId) {
    var d = modeId ? def(modeId) : current();
    var r = (d && d.rules) || {};
    var out = {};
    for (var k in DEFAULT_RULES) out[k] = (k in r) ? r[k] : DEFAULT_RULES[k];
    return out;
  }

  function select(modeId) {
    if (!byIdMap[modeId]) return currentId;
    currentId = modeId;
    if (currentId !== 'challenge_match') selectedChallenge = null;
    return currentId;
  }

  // Challenge Match focuses exactly one of the player's 3 active
  // Phase 3B objectives — never a separate reward path.
  function challenge() {
    return selectedChallenge;
  }

  function selectChallenge(chId) {
    if (!chId || !LG.Challenges || !LG.Challenges.byId(chId)) return false;
    var act = (LG.Progression && LG.Progression.activeChallenges)
      ? LG.Progression.activeChallenges() : [];
    if (act.indexOf(chId) < 0) return false;
    selectedChallenge = chId;
    return true;
  }

  // ---- Phase 11: match twists — temporary physics/body overrides ----
  // Applied by main.js right before a match is built, ALWAYS cleared first,
  // and cleared again on quit, so a twist can never leak into a normal game.
  var TWISTS = {
    moon:    { label: 'MOON BALL',  blurb: 'Low gravity, big bounces.', physics: { gravity: -7, bounce: 0.74 } },
    soap:    { label: 'SOAP FLOOR', blurb: 'The court is slippery.', physics: { groundDrag: 0.992, playerAccel: 17, stopBoost: 0.45, revBoost: 1.0 } },
    bigball: { label: 'BIG BALL',   blurb: 'A ball twice the size.', court: { ballRadius: 0.5 } },
    turbo:   { label: 'TURBO',      blurb: 'Everyone is faster.', player: { speedScale: 1.28 }, physics: { sprintDrain: 0.1 } },
  };
  var TWIST_ORDER = ['moon', 'soap', 'bigball', 'turbo'];
  var saved = null;
  function twistOfDay(date) {
    var d = date || new Date();
    var day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    return TWIST_ORDER[((day % TWIST_ORDER.length) + TWIST_ORDER.length) % TWIST_ORDER.length];
  }
  function resolveTwist(id) {
    if (id === 'daily') return twistOfDay();
    return TWISTS[id] ? id : null;
  }
  function applyTwist(id) {
    clearTwist();
    id = resolveTwist(id);
    var T = id && TWISTS[id];
    if (!T || !LG.Config) return null;
    saved = {};
    ['physics', 'court', 'player'].forEach(function (blk) {
      if (!T[blk]) return;
      var dst = LG.Config[blk] || (LG.Config[blk] = {});
      saved[blk] = {};
      for (var k in T[blk]) {
        saved[blk][k] = Object.prototype.hasOwnProperty.call(dst, k) ? dst[k] : undefined;
        dst[k] = T[blk][k];
      }
    });
    saved.__id = id;
    return id;
  }
  function clearTwist() {
    if (!saved || !LG.Config) { saved = null; return; }
    ['physics', 'court', 'player'].forEach(function (blk) {
      if (!saved[blk]) return;
      for (var k in saved[blk]) {
        if (saved[blk][k] === undefined) delete LG.Config[blk][k];
        else LG.Config[blk][k] = saved[blk][k];
      }
    });
    saved = null;
  }
  function activeTwist() { return saved ? saved.__id : null; }
  function twistInfo(id) { id = resolveTwist(id || 'daily'); return id ? { id: id, label: TWISTS[id].label, blurb: TWISTS[id].blurb } : null; }

  function clearChallenge() {
    selectedChallenge = null;
  }

  function reset() {
    currentId = 'quick_match';
    selectedChallenge = null;
  }

  return {
    DEFS: DEFS,
    list: list,
    def: def,
    current: current,
    id: id,
    is: is,
    type: type,
    rules: rules,
    applyTwist: applyTwist,
    clearTwist: clearTwist,
    activeTwist: activeTwist,
    twistInfo: twistInfo,
    twistOfDay: twistOfDay,
    TWISTS: TWISTS,
    select: select,
    challenge: challenge,
    selectChallenge: selectChallenge,
    clearChallenge: clearChallenge,
    reset: reset,
  };
})();
