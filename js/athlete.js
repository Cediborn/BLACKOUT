// ============================================================
// ATHLETE — Phase 11: realistic footballers.
//
// One CC0 humanoid (Quaternius "Universal Animation Library" mannequin,
// realistic proportions, 65-bone skeleton) with REAL authored clips:
// idle / walk / jog / sprint / back-pedal / strafes / turning leans,
// kick, slide tackle, hits, knock-downs + get-ups, celebrations, dejection.
// Built into 3d/athlete.glb by tools/build-athlete.mjs.
//
// Each player is "dressed" on the real body rather than boxed over it:
// per-vertex kit regions (shirt, sleeve cuffs + collar, shorts, socks,
// boots, skin, hair, keeper gloves) are classified ONCE from the bind pose
// and coloured per player. Eyes + brows, hairstyle volume and a shirt
// number are small attachments on the head / spine bones.
//
// Contract (same as LG.RealPlayer / LG.Rig): { group, body, anim, height }
// plus clipDriven:true — celebration.js / reactions.js see that flag and
// trigger clips through anim.emote() instead of twisting limb bones.
// limbs is null on purpose: every legacy pose helper guards on it.
//
// Failure is never fatal: if the asset is missing or a build throws, the
// player falls back to the previous body (player.js), and the controller
// never returns false (so the procedural limb maths never runs on it).
// ============================================================
var LG = window.LG = window.LG || {};

LG.Athlete = (function () {
  var SRC = '3d/athlete.glb';
  var VISUAL = 1.12;           // same visible-size factor as the previous GLB body
  var NOMINAL = 1.62;          // BLOCKOUT player height before VISUAL

  var phase = 'idle';          // idle -> loading -> ready | error
  var errMsg = '';
  var enabled = true;
  var src = null;              // { scene, clips{}, meta }
  var silent = true;
  var readyQ = [];             // Build 3: listeners waiting for the body (fans, bystanders)

  function log() { if (!silent && window.console) console.log.apply(console, arguments); }
  function warn() { if (window.console && console.warn) console.warn.apply(console, arguments); }
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  // ---------------- regions ----------------
  var R = { SKIN: 0, HAIR: 1, SHIRT: 2, TRIM: 3, SHORTS: 4, SOCKS: 5, BOOTS: 6, HANDS: 7, SOLE: 8, BAND: 9 };

  // ---------------- loading ----------------
  function preload() {
    if (phase !== 'idle') return;
    if (typeof fetch !== 'function' || !window.THREE || !THREE.GLTFLoader) { phase = 'error'; errMsg = 'no GLTFLoader'; return; }
    // headless harnesses (no real page) keep the fallback bodies
    if (typeof location === 'undefined' || !/^(https?|file):$/.test(String(location.protocol))) { phase = 'error'; errMsg = 'no page'; return; }
    phase = 'loading';
    var t0 = nowMs();
    fetch(SRC).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      return new Promise(function (res, rej) { new THREE.GLTFLoader().parse(buf, '', res, rej); });
    }).then(function (g) {
      accept(g);
      log('[ATH] loaded ' + SRC + ' in ' + (nowMs() - t0).toFixed(0) + 'ms, clips=' + Object.keys(src.clips).length);
    }).catch(function (e) {
      phase = 'error';
      errMsg = (e && e.message) || String(e);
      warn('[ATH] FALLBACK: ' + errMsg);
    });
  }

  function accept(g) {
    var scene = g.scene;
    scene.updateMatrixWorld(true);
    var clips = {};
    (g.animations || []).forEach(function (c) { clips[c.name] = c; });
    var meshes = [];
    scene.traverse(function (o) { if (o.isSkinnedMesh) meshes.push(o); });
    if (!meshes.length) throw new Error('no skinned mesh');
    var meta = measure(scene, meshes, clips);
    src = { scene: scene, clips: clips, meshes: meshes, meta: meta };
    phase = 'ready';
    var q = readyQ; readyQ = [];
    q.forEach(function (cb) { try { cb(); } catch (e) { warn('[ATH] onReady listener failed -> ' + ((e && e.message) || e)); } });
  }

  function bone(scene, name) { return scene.getObjectByName(name) || null; }
  function wpos(o) { var v = new THREE.Vector3(); o.getWorldPosition(v); return v; }

  // Bind-pose measurements + the per-vertex region tables. Runs once.
  function measure(scene, meshes, clips) {
    snapRest(scene);
    var J = {};
    ['pelvis', 'spine_02', 'spine_03', 'neck_01', 'Head', 'upperarm_l', 'lowerarm_l', 'hand_l',
      'thigh_l', 'calf_l', 'foot_l', 'ball_l'].forEach(function (n) {
      var b = bone(scene, n); J[n] = b ? wpos(b) : new THREE.Vector3();
    });
    var v = new THREE.Vector3();
    var minY = Infinity, maxY = -Infinity;
    var perMesh = [];
    meshes.forEach(function (mesh) {
      // one region per TRIANGLE (sharp kit edges): split shared vertices once
      if (mesh.geometry.index) {
        var ni = mesh.geometry.toNonIndexed();
        ni.computeBoundingSphere();
        mesh.geometry = ni;
      }
      var geo = mesh.geometry, pos = geo.attributes.position, n = pos.count;
      var skinIdx = geo.attributes.skinIndex, skinW = geo.attributes.skinWeight;
      var bones = mesh.skeleton.bones;
      var P = new Float32Array(n * 3), dom = new Array(n);
      for (var i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i);
        mesh.boneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
        var best = 0, bw = -1;
        var ws = [skinW.getX(i), skinW.getY(i), skinW.getZ(i), skinW.getW(i)];
        var js = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)];
        for (var k = 0; k < 4; k++) if (ws[k] > bw) { bw = ws[k]; best = js[k]; }
        dom[i] = (bones[best] && bones[best].name) || '';
      }
      var mn = (mesh.material && mesh.material.name) || '';
      perMesh.push({ P: P, dom: dom, n: n, joints: /joint/i.test(mn) });
    });

    var top = maxY;
    var chin = J.neck_01.y + 0.03;
    var eyeY = chin + 0.47 * (top - chin);
    // face surface depth at the eye line (front = +z)
    var eyeZ = -Infinity, noseZ = -Infinity, backZ = Infinity, backY = J.spine_03.y - 0.02;
    perMesh.forEach(function (m) {
      for (var i = 0; i < m.n; i++) {
        var x = m.P[i * 3], y = m.P[i * 3 + 1], z = m.P[i * 3 + 2];
        if (m.dom[i] === 'Head' && Math.abs(y - eyeY) < 0.025 && Math.abs(x) > 0.015 && Math.abs(x) < 0.05 && z > eyeZ) eyeZ = z;
        if (Math.abs(y - (eyeY - 0.03)) < 0.015 && Math.abs(x) < 0.01 && z > noseZ) noseZ = z;
        if (Math.abs(y - backY) < 0.04 && Math.abs(x) < 0.05 && z < backZ) backZ = z;
      }
    });
    if (!isFinite(noseZ)) noseZ = J.Head.z + 0.11;
    if (!isFinite(eyeZ) || eyeZ < J.Head.z + 0.04) eyeZ = noseZ - 0.022;
    if (!isFinite(backZ)) backZ = J.spine_03.z - 0.12;

    var headBox = new THREE.Box3();
    perMesh.forEach(function (m) {
      // the cranium only (above the eye line): that is what hair covers
      for (var i = 0; i < m.n; i++) if (m.dom[i] === 'Head' && m.P[i * 3 + 1] > eyeY - 0.005) headBox.expandByPoint(new THREE.Vector3(m.P[i * 3], m.P[i * 3 + 1], m.P[i * 3 + 2]));
    });
    var headPts = [];
    perMesh.forEach(function (m) {
      for (var i = 0; i < m.n; i++) if (m.dom[i] === 'Head' || m.dom[i] === 'neck_01') headPts.push(m.P[i * 3], m.P[i * 3 + 1], m.P[i * 3 + 2]);
    });
    if (headBox.isEmpty()) headBox.set(new THREE.Vector3(-0.09, J.Head.y - 0.02, -0.11), new THREE.Vector3(0.09, top, 0.12));
    // Build 3: bone inverses of the REST pose (T-pose). The mesh's own bind
    // pose differs (arms down), so anything built in rest space (garments,
    // fan bodies) binds with these.
    scene.updateMatrixWorld(true);
    var restInv = meshes[0].skeleton.bones.map(function (b) { return b.matrixWorld.clone().invert(); });
    var kick = probeStrike(scene, clips.kick);
    return {
      J: J, minY: minY, top: top, height: top - minY, chin: chin, eyeY: eyeY, eyeZ: eyeZ,
      noseZ: noseZ, backZ: backZ, backY: backY, perMesh: perMesh, kickStrike: kick, headBox: headBox,
      headPts: headPts, restInv: restInv,
      skullC: new THREE.Vector3(0, eyeY - 0.01, (headBox.max.z + headBox.min.z) / 2 - 0.01),
    };
  }

  // rest-pose snapshot so probing a clip can never leave the master
  // skeleton (which every clone copies) in a posed state
  function snapRest(scene) {
    scene.traverse(function (o) { o.userData.__rest = { q: o.quaternion.clone(), p: o.position.clone(), s: o.scale.clone() }; });
  }
  function restoreRest(scene) {
    scene.traverse(function (o) {
      var r = o.userData.__rest;
      if (r) { o.quaternion.copy(r.q); o.position.copy(r.p); o.scale.copy(r.s); }
    });
    scene.updateMatrixWorld(true);
  }

  // the frame where the kicking boot is furthest forward
  function probeStrike(scene, clip) {
    if (!clip) return 0.45;
    try {
      var mixer = new THREE.AnimationMixer(scene);
      var a = mixer.clipAction(clip); a.play();
      var bl = bone(scene, 'ball_l'), br = bone(scene, 'ball_r');
      var v = new THREE.Vector3(), best = -Infinity, at = 0;
      for (var t = 0; t <= clip.duration; t += 1 / 60) {
        mixer.setTime(t); scene.updateMatrixWorld(true);
        bl.getWorldPosition(v); var z = v.z;
        br.getWorldPosition(v); z = Math.max(z, v.z);
        if (z > best) { best = z; at = t; }
      }
      mixer.stopAllAction(); mixer.uncacheRoot(scene);
      return at;
    } catch (e) { return 0.45; }
    finally { restoreRest(scene); }
  }

  // classify one bind-pose triangle into a kit region. The mannequin is
  // built in segments with joint rings between them, so regions follow
  // BONES (every edge lands on a real seam); only the head and a few bands
  // use heights. ring = the triangle belongs to the joint-ring mesh.
  function regionOf(x, y, z, dom, M, look, ring) {
    var J = M.J, ax = Math.abs(x);
    if (/index|middle|ring_|pinky|thumb|hand/.test(dom)) return R.HANDS;
    if (/lowerarm/.test(dom)) {
      if (look.wristband && ax > J.hand_l.x - 0.07) return R.BAND;
      if (ring && ax < J.lowerarm_l.x + 0.03) return look.longSleeve ? R.SHIRT : R.TRIM;   // elbow ring = cuff
      return look.longSleeve ? R.SHIRT : R.SKIN;
    }
    if (/upperarm/.test(dom)) {
      if (look.armband && !ring && ax > J.upperarm_l.x + 0.05 && ax < J.upperarm_l.x + 0.1) return R.BAND;
      if (ring && ax > J.lowerarm_l.x - 0.04) return look.longSleeve ? R.SHIRT : R.TRIM;
      return R.SHIRT;
    }
    if (/ball|foot/.test(dom)) return y < J.ball_l.y + 0.005 ? R.SOLE : R.BOOTS;
    if (/calf/.test(dom)) {
      if (ring && y > J.calf_l.y - 0.06) return R.SKIN;                 // knee
      return R.SOCKS;
    }
    if (/thigh/.test(dom)) {
      if (ring && y < J.calf_l.y + 0.08) return R.SKIN;                 // knee ring
      return R.SHORTS;
    }
    if (/pelvis/.test(dom)) return y > J.pelvis.y + 0.11 ? R.SHIRT : R.SHORTS;
    if (/Head/.test(dom)) {
      var hl = look.hairLine;
      if (look.headband && y > hl - 0.02 && y < hl + 0.004 && z > J.Head.z - 0.1) return R.BAND;
      return R.SKIN;          // hair is a smooth cap mesh (hairVolume) — clean hairline
    }
    if (/neck/.test(dom)) return ring && y < J.neck_01.y + 0.01 ? R.TRIM : R.SKIN;
    // spine / clavicle: the shirt; the ring under the neck is the collar
    if (ring && y > J.neck_01.y - 0.06 && ax < 0.09) return R.TRIM;
    return R.SHIRT;
  }

  // ---------------- look (hair / sleeves / accessories) ----------------
  function lookFor(def) {
    var cos = (def && def.__cos) || {};
    var style = def && def.hairStyle != null ? def.hairStyle : -1;
    var M = src.meta;
    var crown = M.eyeY + (M.top - M.eyeY) * 0.38;
    var outfit = cos.outfit || 'jersey';
    return {
      style: style,
      hairLine: style === 7 ? crown + 0.035 : crown,       // buzz sits higher/thinner
      bald: false,
      longHair: style === 6,
      longSleeve: /longsleeve|track|windbreaker|hoody/.test(outfit),
      headband: cos.accessory === 'headband',
      wristband: cos.accessory === 'wristband',
      armband: cos.accessory === 'armband',
      shades: cos.accessory === 'glasses',
    };
  }

  // ---------------- colours ----------------
  var _c = new THREE.Color();
  function lin(hex) { _c.setHex(hex >>> 0); return [_c.r, _c.g, _c.b]; }
  function shade(hex, k) {
    var r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    return (Math.round(r * k) << 16) | (Math.round(g * k) << 8) | Math.round(b * k);
  }
  function lum(hex) { return (((hex >> 16) & 255) * 0.3 + ((hex >> 8) & 255) * 0.59 + (hex & 255) * 0.11) / 255; }

  function paletteFor(def, isKeeper) {
    var p = (def && def.palette) || {};
    var shirt = p.shirt != null ? p.shirt : 0x4488ff;
    var shortsBase = p.pants != null ? p.pants : shirt;
    // real kits: shorts a deeper shade (or white on a dark shirt), socks
    // match the shirt, boots in the player's own accent colour
    var shorts = shortsBase === shirt ? (lum(shirt) < 0.22 ? 0xe9e9e4 : shade(shirt, 0.42)) : shortsBase;
    var trim = p.trim != null ? p.trim : 0xffffff;
    if (Math.abs(lum(trim) - lum(shirt)) < 0.12) trim = lum(shirt) > 0.5 ? 0x1a1a1f : 0xf2f2ee;
    var boots = p.trim != null ? p.trim : 0x16161a;
    if (isKeeper) boots = 0x1b1b20;
    return {
      skin: p.skin != null ? p.skin : 0xc89860,
      hair: p.hair != null ? p.hair : 0x2a211b,
      shirt: shirt, trim: trim, shorts: shorts, socks: shirt, boots: boots,
      sole: 0xf0f0ea,
      hands: isKeeper && def.body && def.body.gloves != null ? def.body.gloves : (p.skin != null ? p.skin : 0xc89860),
      band: isKeeper ? 0xffffff : (p.trim != null ? p.trim : 0xffd23f),
    };
  }

  // ---------------- clone ----------------
  function cloneScene(scene) {
    var clone = scene.clone(true), map = {}, orig = {};
    (function walk(a, b) { map[a.uuid] = b; orig[b.uuid] = a; for (var i = 0; i < a.children.length; i++) walk(a.children[i], b.children[i]); })(scene, clone);
    clone.traverse(function (node) {
      var o = orig[node.uuid];
      if (!node.isSkinnedMesh || !o || !o.skeleton) return;
      var bones = o.skeleton.bones.map(function (b) { return map[b.uuid] || b; });
      node.bind(new THREE.Skeleton(bones, o.skeleton.boneInverses), o.bindMatrix);
      node.frustumCulled = false;
    });
    return clone;
  }

  var sharedMat = null;
  function bodyMaterial() {
    if (!sharedMat) {
      sharedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.0 });
    }
    return sharedMat;
  }

  function dress(clone, def, isKeeper, look) {
    var pal = paletteFor(def, isKeeper);
    var table = [];
    table[R.SKIN] = lin(pal.skin); table[R.HAIR] = lin(pal.hair); table[R.SHIRT] = lin(pal.shirt);
    table[R.TRIM] = lin(pal.trim); table[R.SHORTS] = lin(pal.shorts); table[R.SOCKS] = lin(pal.socks);
    table[R.BOOTS] = lin(pal.boots); table[R.HANDS] = lin(pal.hands); table[R.SOLE] = lin(pal.sole);
    table[R.BAND] = lin(pal.band);
    var M = src.meta, mi = 0;
    clone.traverse(function (o) {
      if (!o.isSkinnedMesh) return;
      var pm = M.perMesh[mi++];
      var g = o.geometry;
      var geo = new THREE.BufferGeometry();
      for (var key in g.attributes) geo.setAttribute(key, g.attributes[key]);   // shared, read-only
      if (g.index) geo.setIndex(g.index);
      geo.boundingSphere = g.boundingSphere; geo.boundingBox = g.boundingBox;
      var col = new Float32Array(pm.n * 3), P = pm.P;
      for (var t = 0; t + 2 < pm.n; t += 3) {
        var cx = (P[t * 3] + P[t * 3 + 3] + P[t * 3 + 6]) / 3;
        var cy = (P[t * 3 + 1] + P[t * 3 + 4] + P[t * 3 + 7]) / 3;
        var cz = (P[t * 3 + 2] + P[t * 3 + 5] + P[t * 3 + 8]) / 3;
        var r = regionOf(cx, cy, cz, pm.dom[t], M, look, pm.joints);
        var c = table[r];
        // tiny deterministic tone variation breaks the flat plastic look
        var n = ((t * 2654435761) >>> 0) / 4294967296 * 0.05 - 0.025;
        for (var q = 0; q < 3; q++) {
          var i = (t + q) * 3;
          col[i] = Math.max(0, c[0] * (1 + n));
          col[i + 1] = Math.max(0, c[1] * (1 + n));
          col[i + 2] = Math.max(0, c[2] * (1 + n));
        }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      o.geometry = geo;
      o.material = bodyMaterial();
      o.castShadow = true;
      o.receiveShadow = false;
    });
    return pal;
  }

  // ---------------- attachments (bone-parented) ----------------
  var GEO = {};
  function geo(key, make) { return GEO[key] || (GEO[key] = make()); }
  var MATS = {};
  function mat(hex, rough) {
    var k = hex + ':' + (rough || 0.6);
    return MATS[k] || (MATS[k] = new THREE.MeshStandardMaterial({ color: hex, roughness: rough || 0.6, metalness: 0 }));
  }

  // attach a mesh at a bind-pose WORLD position, parented to a bone
  function attachAt(bn, mesh, world, rotY) {
    bn.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(bn.matrixWorld).invert();
    mesh.position.copy(world.clone().applyMatrix4(inv));
    var q = new THREE.Quaternion(); bn.getWorldQuaternion(q);
    mesh.quaternion.copy(q.invert());
    if (rotY) mesh.rotateY(rotY);
    bn.add(mesh);
    return mesh;
  }

  function face(clone, pal, look) {
    var head = bone(clone, 'Head');
    if (!head) return;
    var M = src.meta;
    var white = mat(0xd9d2c6, 0.45), iris = mat(0x22170f, 0.25), brow = mat(shade(pal.hair, 0.8), 0.95);
    var lip = mat(shade(pal.skin, 0.62), 0.7);
    var eyeG = geo('eye', function () { return new THREE.SphereGeometry(0.0085, 12, 8); });
    var irisG = geo('iris', function () { return new THREE.SphereGeometry(0.0046, 10, 6); });
    var browG = geo('brow', function () { var g = new THREE.CapsuleGeometry(0.0028, 0.021, 3, 6); g.rotateZ(Math.PI / 2); return g; });
    var mouthG = geo('mouth', function () { var g = new THREE.CapsuleGeometry(0.0022, 0.02, 3, 6); g.rotateZ(Math.PI / 2); return g; });
    [-1, 1].forEach(function (s) {
      var e = new THREE.Mesh(eyeG, white); e.scale.set(1.25, 0.5, 0.45);
      attachAt(head, e, new THREE.Vector3(s * 0.031, M.eyeY, M.eyeZ - 0.006));
      var ir = new THREE.Mesh(irisG, iris); ir.scale.set(1, 1, 0.45);
      attachAt(head, ir, new THREE.Vector3(s * 0.031, M.eyeY, M.eyeZ - 0.0025));
      var b = new THREE.Mesh(browG, brow);
      attachAt(head, b, new THREE.Vector3(s * 0.032, M.eyeY + 0.017, M.eyeZ - 0.002));
      b.rotateZ(s * -0.1);
    });
    var mo = new THREE.Mesh(mouthG, lip);
    attachAt(head, mo, new THREE.Vector3(0, M.eyeY - 0.062, M.eyeZ - 0.012));
    if (look.shades) {
      var lens = geo('lens', function () { return new THREE.CylinderGeometry(0.016, 0.016, 0.004, 14); });
      var dark = mat(0x111114, 0.15);
      [-1, 1].forEach(function (s) {
        var l = new THREE.Mesh(lens, dark); l.rotation.x = Math.PI / 2;
        var w = new THREE.Vector3(s * 0.033, M.eyeY, M.eyeZ + 0.012);
        attachAt(head, l, w); l.rotateX(Math.PI / 2);
      });
    }
  }

  function fittedCap(theta, gap) {
    var M = src.meta, c = M.skullC;
    var g = new THREE.SphereGeometry(1, 32, 20, 0, Math.PI * 2, 0, Math.PI * theta);
    g.rotateX(-0.45);                         // hairline high at the front, low at the nape
    var pts = M.headPts, pos = g.attributes.position, u = new THREE.Vector3(), d = new THREE.Vector3();
    for (var i = 0; i < pos.count; i++) {
      u.fromBufferAttribute(pos, i).normalize();
      var best = 0, bestDot = -1, far = 0;
      for (var k = 0; k < pts.length; k += 3) {
        d.set(pts[k] - c.x, pts[k + 1] - c.y, pts[k + 2] - c.z);
        var len = d.length();
        var dot = d.dot(u) / (len || 1);
        if (dot > 0.965 && len * dot > best) best = len * dot;        // within ~15 deg
        if (dot > bestDot) { bestDot = dot; far = len; }
      }
      var r = (best || far) + gap;
      pos.setXYZ(i, u.x * r, u.y * r, u.z * r);
    }
    g.computeVertexNormals();
    return g;
  }

  function hairVolume(clone, pal, look) {
    var head = bone(clone, 'Head');
    if (!head) return;
    var M = src.meta, J = M.J, hm = mat(pal.hair, 0.95);
    var cy = M.top - 0.07, cz = J.Head.z - 0.015;
    var s = look.style;
    // the cap: a shell fitted to THIS head. For every cap vertex direction
    // from the skull centre, the head surface radius is measured from the
    // bind-pose vertices, and the cap sits a few mm outside it. Built once
    // per hairstyle family and shared by every player.
    var theta = s === 7 ? 0.46 : (s === 3 ? 0.5 : 0.54);
    var gap = s === 7 ? 0.0035 : 0.007;
    var capG = geo('cap' + theta + ':' + gap, function () { return fittedCap(theta, gap); });
    var capM = new THREE.Mesh(capG, hm);
    capM.castShadow = true;
    attachAt(head, capM, M.skullC.clone());
    function blob(r, x, y, z, sx, sy, sz) {
      var g = geo('blob' + r, function () { return new THREE.SphereGeometry(r, 16, 12); });
      var m = new THREE.Mesh(g, hm); m.scale.set(sx || 1, sy || 1, sz || 1); m.castShadow = true;
      attachAt(head, m, new THREE.Vector3(x, y, z));
      return m;
    }
    if (s === 4) blob(0.118, 0, cy + 0.035, cz - 0.01, 1.05, 0.95, 1.05);          // afro
    else if (s === 5) blob(0.1, 0, cy + 0.02, cz - 0.005, 1.04, 0.85, 1.04);        // curly
    else if (s === 6) blob(0.038, 0, M.eyeY - 0.005, J.Head.z - 0.115, 0.9, 1.8, 0.9); // ponytail
    else if (s === 2) blob(0.03, 0, M.top - 0.012, cz - 0.01, 0.55, 0.9, 3.0);       // mohawk ridge
    else if (s === 0) {                                                                // spiky
      var cone = geo('spike', function () { return new THREE.ConeGeometry(0.016, 0.05, 6); });
      for (var i = 0; i < 7; i++) {
        var a = (i / 7) * Math.PI * 2;
        var m = new THREE.Mesh(cone, hm);
        attachAt(head, m, new THREE.Vector3(Math.sin(a) * 0.045, M.top - 0.012, cz + Math.cos(a) * 0.045));
      }
    }
  }

  var numTex = {};
  function numberTexture(n, fg, outline) {
    var key = n + ':' + fg + ':' + outline;
    if (numTex[key]) return numTex[key];
    var c = document.createElement('canvas'); c.width = 128; c.height = 128;
    var g = c.getContext('2d');
    if (!g || !g.fillText) return null;
    g.clearRect(0, 0, 128, 128);
    g.font = 'bold 92px Arial Black, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 9; g.strokeStyle = '#' + ('000000' + outline.toString(16)).slice(-6);
    g.fillStyle = '#' + ('000000' + fg.toString(16)).slice(-6);
    g.strokeText(String(n), 64, 70); g.fillText(String(n), 64, 70);
    var t = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    numTex[key] = t;
    return t;
  }

  function shirtNumber(clone, pal, num) {
    var sp = bone(clone, 'spine_03') || bone(clone, 'spine_02');
    if (!sp || num == null) return;
    var tex = numberTexture(num, pal.trim, shade(pal.shirt, 0.45));
    if (!tex) return;
    var M = src.meta;
    var plane = new THREE.Mesh(geo('num', function () { return new THREE.PlaneGeometry(0.17, 0.17); }),
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.35, roughness: 0.8, depthWrite: false }));
    attachAt(sp, plane, new THREE.Vector3(0, M.backY - 0.02, M.backZ - 0.012), Math.PI);
  }

  function numberFor(def, idx, isKeeper) {
    if (isKeeper) return 1;
    var ORDER = ['blaze', 'cannon', 'frenzy', 'stone', 'echo', 'pulse', 'volt', 'brute'];
    var nums = [7, 9, 11, 4, 10, 8, 17, 5];
    var i = ORDER.indexOf(def && def.id);
    if (i >= 0) return nums[i];
    var h = 0, s = String((def && def.id) || idx);
    for (var k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
    return 2 + (h % 20);
  }

  // ---------------- build ----------------
  function build(def, opts) {
    if (phase !== 'ready' || !enabled) return null;
    try {
      opts = opts || {};
      if (LG.Cosmetics && LG.Cosmetics.resolve) def = LG.Cosmetics.resolve(def);
      var isKeeper = !!(def && def.body && def.body.gloves != null);
      var t0 = nowMs();
      var clone = cloneScene(src.scene);
      var look = lookFor(def);
      var pal = dress(clone, def, isKeeper, look);
      var num = numberFor(def, opts.idx, isKeeper);
      // Build 3: real garments over the body (baggy kit, hoodie, pinnie…)
      var worn = null;
      if (LG.Garments && opts.garments !== false) {
        try {
          var design = opts.design || (isKeeper ? 'keeper' : (def && def.__cos && def.__cos.outfit) || 'jersey');
          var lean = !!opts.lite;
          try { lean = lean || LG.Settings.qualityLevel(/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) !== 'high'; } catch (qe) { /* high */ }
          worn = LG.Garments.dress(clone, src.meta, pal, design, num, { lean: lean });
        } catch (ge) { warn('[ATH] garments skipped -> ' + ((ge && ge.message) || ge)); worn = null; }
      }
      if (!opts.lite) face(clone, pal, look);
      if (!(worn && worn.hood)) hairVolume(clone, pal, look);
      if (!worn) shirtNumber(clone, pal, num);

      var group = new THREE.Group(), body = new THREE.Group(), anchor = new THREE.Group();
      group.add(body); body.add(anchor); anchor.add(clone);
      var tall = def && def.body && def.body.tall ? def.body.tall : 1;
      var wide = def && def.body && def.body.wide ? def.body.wide : 1;
      var M = src.meta;
      var k = (NOMINAL * tall * VISUAL) / M.height;
      // build variety: wide players are a touch broader, never cartoonish
      var bw = 1 + (wide - 1) * 0.35;
      anchor.scale.set(k * bw, k, k * (1 + (wide - 1) * 0.25));
      anchor.position.y = -M.minY * k;

      var m = {
        group: group, body: null, anchor: anchor, scene: clone,
        limbs: null, height: M.height, skinned: true, glb: true, athlete: true, clipDriven: true,
        palette: pal, garment: worn ? worn.design : null,
      };
      m.anim = controller(m, k);
      log('[ATH] built ' + (def && def.id) + ' in ' + (nowMs() - t0).toFixed(1) + 'ms');
      return m;
    } catch (e) {
      warn('[ATH] FALLBACK: build failed -> ' + ((e && e.stack) || e));
      return null;
    }
  }

  // ============================================================
  // CONTROLLER
  // ============================================================
  var LOCO = ['idle', 'walk', 'jog', 'sprint', 'jog_back', 'jog_left', 'jog_right', 'jog_lean_l', 'jog_lean_r', 'tired'];
  // body-relative ground speed (m/s of the model) each loop was authored at
  var REF = { walk: 1.15, jog: 4.1, sprint: 6.9, jog_back: 3.2, jog_left: 2.2, jog_right: 2.2, jog_lean_l: 4.1, jog_lean_r: 4.1 };
  var LOOPING = { idle: 1, idle_look: 1, tired: 1, walk: 1, jog: 1, sprint: 1, jog_back: 1, jog_left: 1, jog_right: 1,
    jog_lean_l: 1, jog_lean_r: 1, dance: 1, slide_loop: 1, no: 1, fold_arms: 1 };

  function controller(m, k) {
    var mixer = new THREE.AnimationMixer(m.scene);
    var acts = {};
    Object.keys(src.clips).forEach(function (nm) {
      var a = mixer.clipAction(src.clips[nm]);
      a.enabled = true;
      a.setEffectiveWeight(0);
      if (LOOPING[nm]) a.setLoop(THREE.LoopRepeat, Infinity);
      else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      a.play();
      if (LOCO.indexOf(nm) >= 0) a.setEffectiveTimeScale(0);   // time is written by hand (phase sync)
      else a.paused = true;
      acts[nm] = a;
    });

    var w = {};                 // current loco weights
    LOCO.forEach(function (n) { w[n] = n === 'idle' ? 1 : 0; });
    var phi = Math.random();    // shared locomotion phase (0..1)
    var last = 0, fails = 0, lastError = '';
    var shot = null;            // one-shot: { seq:[{n,from,to,ts}], i, t, w }
    var emo = null;             // emote: { n, t, dur, ts, hold, w }
    var wasKick = false, wasTackle = false, lastFacing = null, turnRate = 0, fat = 0;
    var cur = 'idle', pinned = null;
    var scale = k;              // anchor scale (model units -> group units)

    function begin(a, from, ts) {
      a.reset();
      a.enabled = true;
      a.paused = false;
      a.time = from || 0;
      a.setEffectiveTimeScale(ts || 1);
    }

    function playShot(seq) {
      shot = { seq: seq, i: 0, t: 0, w: shot ? shot.w : 0 };
      var s0 = seq[0];
      begin(acts[s0.n], s0.from, s0.ts);
    }

    function emote(name, o) {
      o = o || {};
      if (!acts[name]) return false;
      if (emo && emo.n === name && !o.restart) { emo.dur = Math.max(emo.dur, o.dur || 0); return true; }
      emo = { n: name, t: 0, dur: o.dur || src.clips[name].duration, hold: !!o.hold, w: emo ? emo.w : 0, ts: o.ts || 1 };
      begin(acts[name], o.from || 0, emo.ts);
      return true;
    }

    function clearEmote() { if (emo) emo.dur = Math.min(emo.dur, emo.t + 0.2); }

    function approach(cur, target, rate, dt) { return cur + (target - cur) * Math.min(1, dt * rate); }
    // weight 0 => disabled: the mixer skips disabled actions entirely, so a
    // player only ever pays for the 1-3 clips actually visible
    function setW(a, wt) {
      if (!a) return;
      var on = wt > 0.002;
      if (a.enabled !== on) a.enabled = on;
      a.setEffectiveWeight(on ? wt : 0);
    }

    function advance(dt, p) {
      // ---- signals ----
      var vx = p.vx || 0, vz = p.vz || 0;
      var spd = Math.sqrt(vx * vx + vz * vz);
      var S = (p.model && p.model.group ? p.model.group.scale.x : 1) * scale;
      var u = spd / Math.max(0.01, S);                     // body-relative speed
      var f = p.facing || 0;
      if (lastFacing === null) lastFacing = f;
      var df = f - lastFacing; df = Math.atan2(Math.sin(df), Math.cos(df));
      lastFacing = f;
      turnRate = approach(turnRate, dt > 0 ? df / dt : 0, 8, dt);

      // kick / pass edge -> authored kick, started just before the strike
      var kicking = p.kickAnim > 0;
      if (kicking && !wasKick && acts.kick) {
        var st = src.meta.kickStrike || 0.45;
        playShot([{ n: 'kick', from: Math.max(0, st - 0.2), to: Math.min(src.clips.kick.duration, st + 0.32), ts: 1.45 }]);
        emo = null;
      }
      wasKick = kicking;
      // tackle edge -> real slide tackle: drop, slide, rise
      var tackling = p.tackleAnim > 0;
      if (tackling && !wasTackle && acts.slide_start) {
        playShot([
          { n: 'slide_start', from: 0.08, to: src.clips.slide_start.duration, ts: 2.1 },
          { n: 'slide_exit', from: 0, to: src.clips.slide_exit.duration, ts: 1.5 },
        ]);
        emo = null;
      }
      wasTackle = tackling;

      // ---- one-shot sequence ----
      var shotTarget = 0;
      if (shot) {
        if (shot.i < shot.seq.length) {
          var sg = shot.seq[shot.i], a = acts[sg.n];
          if (a.time >= sg.to - 1e-3 || (!a.isRunning() && a.time > 0)) {
            shot.i++;
            if (shot.i < shot.seq.length) { sg = shot.seq[shot.i]; begin(acts[sg.n], sg.from, sg.ts); }
          }
        }
        shotTarget = shot.i < shot.seq.length ? 1 : 0;
        if (!shotTarget && shot.w < 0.02) {
          shot.seq.forEach(function (sq) { setW(acts[sq.n], 0); acts[sq.n].paused = true; });
          shot = null;
        }
      }
      // ---- emote ----
      var emoTarget = 0;
      if (emo) {
        emo.t += dt;
        // live movement cancels a casual emote; celebrations hold
        if (!emo.hold && u > 1.4 && emo.t > 0.15) emo.dur = Math.min(emo.dur, emo.t);
        emoTarget = emo.t < emo.dur ? 1 : 0;
        if (!emoTarget && emo.w < 0.02) { setW(acts[emo.n], 0); acts[emo.n].paused = true; emo = null; }
      }

      // ---- locomotion targets ----
      var target = {}; LOCO.forEach(function (n) { target[n] = 0; });
      var mode = 'idle', rate = 1;
      if (u < 0.35) {
        mode = (p.stamina != null && p.stamina < 0.22 && !p.isGoalkeeper) ? 'tired' : 'idle';
      } else {
        // direction of travel relative to where the body faces
        var mv = Math.atan2(vx, vz) - f; mv = Math.atan2(Math.sin(mv), Math.cos(mv));
        var am = Math.abs(mv);
        if (u < 1.6) { mode = 'walk'; }
        else if (am > 2.3) mode = 'jog_back';
        else if (am > 0.95 && u < 5.5) mode = mv > 0 ? 'jog_left' : 'jog_right';
        else if (u > 5.2 || (p.sprinting && u > 4.2)) mode = 'sprint';
        else mode = 'jog';
        rate = Math.min(1.45, Math.max(0.7, u / (REF[mode] || 4)));
      }
      target[mode] = 1;
      // turning lean while jogging
      if (mode === 'jog' && Math.abs(turnRate) > 1.2) {
        var lean = Math.min(0.8, (Math.abs(turnRate) - 1.2) / 3);
        target.jog = 1 - lean;
        target[turnRate > 0 ? 'jog_lean_l' : 'jog_lean_r'] = lean;
      }
      cur = mode;

      // shared phase: advance at the dominant clip's cadence
      var dom = src.clips[mode];
      if (dom) phi = (phi + dt * rate / dom.duration) % 1;

      // ---- weights ----
      if (shot) shot.w = approach(shot.w, shotTarget, shotTarget ? 22 : 9, dt);
      if (emo) emo.w = approach(emo.w, emoTarget, emoTarget ? 10 : 6, dt);
      var over = Math.max(shot ? shot.w : 0, emo ? emo.w : 0);
      LOCO.forEach(function (n) {
        w[n] = approach(w[n], target[n], 9, dt);
        var a = acts[n];
        if (!a) return;
        setW(a, w[n] * (1 - over));
        a.time = phi * src.clips[n].duration;
      });
      if (shot) {
        shot.seq.forEach(function (sq, i) {
          var aa = acts[sq.n];
          setW(aa, i === Math.min(shot.i, shot.seq.length - 1) ? shot.w : 0);
        });
      }
      if (emo) setW(acts[emo.n], emo.w * (1 - (shot ? shot.w : 0)));
      mixer.update(dt);
    }

    var api = {
      clipDriven: true,
      has: function (name) {
        if (name === 'tackle') return !!acts.slide_start;
        if (name === 'run') return !!acts.jog;
        return !!acts[name];
      },
      emote: emote,
      clearEmote: clearEmote,
      emoting: function () { return emo ? emo.n : null; },
      state: function () {
        var durs = {};
        Object.keys(src.clips).forEach(function (n) { durs[n] = src.clips[n].duration; });
        durs.run = durs.jog;
        return {
          cur: cur, fails: fails, lastError: lastError, time: phi * (durs[cur] || 1),
          emote: emo ? emo.n : null, shot: shot ? shot.seq[Math.min(shot.i, shot.seq.length - 1)].n : null,
          clips: Object.keys(src.clips).join(','), durs: durs, athlete: 1, retarget: 0, shim: 0,
          mapped: 65,
        };
      },
      // pin a clip at time t (goal cinematic + screenshot harness)
      pose: function (name, t) {
        try {
          var n = name === 'run' ? 'jog' : (name === 'tackle' ? 'slide_loop' : name);
          var a = acts[n];
          if (!a) return false;
          shot = null; emo = null;
          Object.keys(acts).forEach(function (q) { setW(acts[q], 0); });
          LOCO.forEach(function (q) { w[q] = 0; });
          var dur = src.clips[n].duration;
          var tt = Math.min(Math.max(0, t || 0), Math.max(0, dur - 1e-3));
          if (LOCO.indexOf(n) >= 0) { w[n] = 1; phi = tt / dur; a.time = tt; }
          else { a.paused = false; a.time = tt; a.setEffectiveTimeScale(0); }
          setW(a, 1);
          mixer.update(0);
          if (LOCO.indexOf(n) < 0) a.setEffectiveTimeScale(1);
          cur = n; pinned = n;
          return true;
        } catch (e) { fails++; lastError = e.message; return false; }
      },
      step: function (rdt, p) { try { advance(rdt, p); } catch (e) { fails++; lastError = e.message; } return true; },
      update: function (dt, p) {
        var t = nowMs();
        var rdt = last ? Math.min(0.1, (t - last) / 1000) : 0;
        last = t;
        try { advance(rdt, p); }
        catch (e) {
          fails++; lastError = (e && e.message) || String(e);
          if (fails === 1) warn('[ATH] animation error: ' + lastError);
        }
        return true;          // never hand this skeleton to the limb maths
      },
    };
    // paint a real pose on the first frame
    Object.keys(acts).forEach(function (q) { setW(acts[q], 0); });
    setW(acts.idle, 1);
    mixer.update(0);
    return api;
  }

  // ?athlete=0 compares against the previous bodies without a code change
  try {
    var q = /(?:[?&])athlete=([01])(?:&|$)/.exec(String(typeof location !== 'undefined' ? location.search : ''));
    if (q && q[1] === '0') enabled = false;
  } catch (e) { /* no location */ }

  if (enabled) preload();

  return {
    preload: preload,
    ready: function () { return phase === 'ready' && enabled; },
    // run cb once the body is loaded (at once if it already is). Never
    // fires on a failed load: callers keep their fallback figures.
    onReady: function (cb) { if (phase === 'ready') { try { cb(); } catch (e) { warn('[ATH] onReady listener failed -> ' + e); } } else readyQ.push(cb); },
    clip: function (name) { return src && src.clips[name] || null; },
    status: function () { return { phase: phase, error: errMsg, enabled: enabled, src: SRC, clips: src ? Object.keys(src.clips).length : 0 }; },
    build: build,
    setEnabled: function (on) { enabled = !!on; },
    setLogging: function (on) { silent = !on; },
    meta: function () { return src ? src.meta : null; },
    REGIONS: R,
    SRC: SRC,
  };
})();
