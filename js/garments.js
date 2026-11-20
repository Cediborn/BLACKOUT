// ============================================================
// GARMENTS — real clothes on the athlete body (Build 3).
//
// Until now every outfit on the realistic body was only a colour pattern
// painted on a slim mannequin, so a BAGGY KIT, a HOODIE and a PINNIE all
// had the same skin-tight shape. This module builds actual garments:
//
//   * a SHELL is cut from the athlete's own bind-pose triangles (torso,
//     sleeves, shorts / trousers, hood) and pushed outward along the
//     surface normal. Looseness grows towards hems, so a baggy tee hangs
//     and flares and baggy shorts reach past the knee.
//   * the shell keeps the body's skin weights, so it moves with every
//     authored clip exactly like the body (it is one more SkinnedMesh on
//     the same skeleton: one extra draw per player).
//   * cylindrical UVs are generated per part and a kit texture is painted
//     on a canvas per design: side panels, chevrons, zips, kangaroo
//     pocket, sleeve stripes, numbers, crest, ribbing, cuffs and collars.
//   * extra pieces (hood down, drawstrings, stand-up collar) are built in
//     bind space and rigidly skinned to one bone.
//
// Designs follow the outfit list in LG.Cosmetics (and what the old box
// bodies drew for each one): hoody, hoodydown, track, jersey, pinnie,
// longsleeve, windbreaker, baggy, plus 'keeper' and the street-clothes
// designs used by the bystanders and fans (tee, hoodie, jacket, …).
//
// Failure is never fatal: athlete.js calls dress() in a try/catch and the
// painted body stays as it was.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Garments = (function () {
  var W = 512, H = 512;
  // canvas rows (flipY = false, so v = canvasY / H)
  var RT = { y0: 0, y1: 300 };        // torso
  var RS = { y0: 304, y1: 384 };      // sleeves
  var RP = { y0: 388, y1: 476 };      // shorts / trousers
  var PATCH_Y = 496;                  // solid colour patches (8 columns)
  var P = { TRIM: 0, RIB: 1, PRIB: 2, SHIRT: 3, LINING: 4, DARK: 5, PANTS: 6, WHITE: 7 };

  function sat(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(a, b, x) { var t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  function hex(n) { return '#' + ('000000' + (n >>> 0).toString(16)).slice(-6); }
  function shade(c, k) {
    var r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    return (Math.min(255, Math.round(r * k)) << 16) | (Math.min(255, Math.round(g * k)) << 8) | Math.min(255, Math.round(b * k));
  }
  function mix(a, b, t) {
    var r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
    var g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
    var bl = (a & 255) * (1 - t) + (b & 255) * t;
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
  }
  function lum(c) { return (((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11) / 255; }

  // ---------------- design specs ----------------
  // offsets in metres (the bind pose is in metres, 1.83 m tall).
  // t0/flare: torso looseness at the chest and extra at the hem.
  // sleeve: 'short' | 'elbow' | 'long' | 'none'. s0/sFlare: sleeve looseness.
  // hem: hem height relative to the pelvis joint. longHem: the tee also
  // covers the top of the thighs. legs: 'shorts' | 'long' | 'knee' | 'trousers'.
  var SPECS = {
    jersey:     { t0: 0.013, flare: 0.022, hem: -0.005, sleeve: 'short', s0: 0.016, sFlare: 0.014, legs: 'shorts', p0: 0.014, pFlare: 0.032, collar: 'v' },
    baggy:      { t0: 0.030, flare: 0.055, hem: -0.13, longHem: true, sleeve: 'elbow', s0: 0.032, sFlare: 0.034, legs: 'knee', p0: 0.03, pFlare: 0.062, collar: 'crew' },
    hoody:      { t0: 0.024, flare: 0.024, hem: -0.03, sleeve: 'long', s0: 0.02, sFlare: 0.01, legs: 'shorts', p0: 0.016, pFlare: 0.03, collar: 'none', hood: 'up', ribHem: true },
    hoodydown:  { t0: 0.024, flare: 0.024, hem: -0.03, sleeve: 'long', s0: 0.02, sFlare: 0.01, legs: 'shorts', p0: 0.016, pFlare: 0.03, collar: 'none', hood: 'down', ribHem: true },
    track:      { t0: 0.017, flare: 0.014, hem: -0.01, sleeve: 'long', s0: 0.016, sFlare: 0.008, legs: 'shorts', p0: 0.014, pFlare: 0.03, collar: 'stand', zip: true },
    longsleeve: { t0: 0.008, flare: 0.008, hem: 0.0, sleeve: 'long', s0: 0.007, sFlare: 0.003, legs: 'shorts', p0: 0.012, pFlare: 0.026, collar: 'crew' },
    windbreaker:{ t0: 0.026, flare: 0.034, hem: -0.02, sleeve: 'long', s0: 0.024, sFlare: 0.012, legs: 'shorts', p0: 0.014, pFlare: 0.03, collar: 'stand', zip: true, shiny: true },
    pinnie:     { t0: 0.010, flare: 0.012, hem: 0.0, sleeve: 'short', s0: 0.012, sFlare: 0.008, legs: 'shorts', p0: 0.014, pFlare: 0.03, collar: 'crew', bib: true },
    keeper:     { t0: 0.017, flare: 0.022, hem: -0.01, sleeve: 'long', s0: 0.022, sFlare: 0.012, legs: 'shorts', p0: 0.017, pFlare: 0.034, collar: 'crew' },
    // ---- street clothes (bystanders / fans) ----
    tee:        { t0: 0.014, flare: 0.026, hem: -0.06, longHem: true, sleeve: 'short', s0: 0.018, sFlare: 0.014, legs: 'trousers', p0: 0.012, pFlare: 0.012, collar: 'crew' },
    hoodie:     { t0: 0.026, flare: 0.026, hem: -0.06, longHem: true, sleeve: 'long', s0: 0.022, sFlare: 0.01, legs: 'trousers', p0: 0.014, pFlare: 0.018, collar: 'none', hood: 'down', ribHem: true },
    jacket:     { t0: 0.03, flare: 0.03, hem: -0.07, longHem: true, sleeve: 'long', s0: 0.026, sFlare: 0.01, legs: 'trousers', p0: 0.012, pFlare: 0.012, collar: 'stand', zip: true, shiny: true },
    tank:       { t0: 0.01, flare: 0.02, hem: -0.04, longHem: true, sleeve: 'none', s0: 0, sFlare: 0, legs: 'knee', p0: 0.024, pFlare: 0.04, collar: 'crew' },
    oversize:   { t0: 0.034, flare: 0.05, hem: -0.12, longHem: true, sleeve: 'elbow', s0: 0.034, sFlare: 0.03, legs: 'trousers', p0: 0.026, pFlare: 0.03, collar: 'crew' },
  };
  var STREET = ['tee', 'hoodie', 'jacket', 'tank', 'oversize'];

  // ---------------- per-skeleton geometry cache ----------------
  // The cut + offset depends only on the design (never on colours), so it
  // is computed once per design and shared by every player wearing it.
  var GEOCACHE = {};

  function boneIndex(bones, name) {
    for (var i = 0; i < bones.length; i++) if (bones[i].name === name) return i;
    return 0;
  }

  // smooth REST-POSE normals across both meshes (body + joint rings):
  // face normals from the rest positions, averaged per shared position,
  // so offsets never crack at seams
  function smoothNormals(M) {
    var acc = {};
    function key(P, i) { return Math.round(P[i * 3] * 400) + ',' + Math.round(P[i * 3 + 1] * 400) + ',' + Math.round(P[i * 3 + 2] * 400); }
    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    M.perMesh.forEach(function (pm) {
      var P = pm.P;
      for (var t = 0; t + 2 < pm.n; t += 3) {
        a.set(P[t * 3], P[t * 3 + 1], P[t * 3 + 2]);
        b.set(P[t * 3 + 3], P[t * 3 + 4], P[t * 3 + 5]);
        c.set(P[t * 3 + 6], P[t * 3 + 7], P[t * 3 + 8]);
        b.sub(a); c.sub(a); b.cross(c);            // area-weighted face normal
        for (var q = 0; q < 3; q++) {
          var k = key(P, t + q), s = acc[k] || (acc[k] = [0, 0, 0]);
          s[0] += b.x; s[1] += b.y; s[2] += b.z;
        }
      }
    });
    return M.perMesh.map(function (pm) {
      var out = new Float32Array(pm.n * 3);
      for (var i = 0; i < pm.n; i++) {
        var s = acc[key(pm.P, i)], l = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]) || 1;
        out[i * 3] = s[0] / l; out[i * 3 + 1] = s[1] / l; out[i * 3 + 2] = s[2] / l;
      }
      return out;
    });
  }

  // Sutherland-Hodgman: clip a triangle (array of vert objects) against
  // d(v) >= 0. Interpolates position + normal; skin data comes from the
  // nearer end (indices cannot be blended). Returns a polygon (0-4 verts).
  function lerpV(a, b, t) {
    var n = t < 0.5 ? a : b;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
      nx: a.nx + (b.nx - a.nx) * t, ny: a.ny + (b.ny - a.ny) * t, nz: a.nz + (b.nz - a.nz) * t,
      si: n.si.slice(), sw: n.sw.slice(), dom: n.dom };
  }
  function clip(poly, d) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length], da = d(a), db = d(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) out.push(lerpV(a, b, da / (da - db)));
    }
    return out;
  }
  function fan(poly, cb) { for (var i = 1; i + 1 < poly.length; i++) cb([poly[0], poly[i], poly[i + 1]]); }

  function buildGeometry(meshes, M, design) {
    var S = SPECS[design];
    var J = M.J;
    var normals = smoothNormals(M);
    var bones = meshes[0].skeleton.bones;
    var hemY = J.pelvis.y + S.hem;
    var waistY = J.pelvis.y + 0.115;
    var chestY = J.spine_03.y;
    var topY = J.neck_01.y + 0.01;
    var shoulderX = 0.15;
    var sleeveEnd = S.sleeve === 'short' ? J.upperarm_l.x + 0.15
      : S.sleeve === 'elbow' ? J.lowerarm_l.x + 0.035
      : S.sleeve === 'long' ? J.hand_l.x - 0.03 : 0.2;
    var legEnd = S.legs === 'shorts' ? J.calf_l.y + 0.13
      : S.legs === 'knee' ? J.calf_l.y - 0.12
      : S.legs === 'trousers' ? J.foot_l.y + 0.035 : J.calf_l.y + 0.13;
    var zc = -0.025;
    var headZ = J.Head.z;

    var out = { pos: [], nor: [], uv: [], si: [], sw: [], bib: null };
    var hidden = [];   // per body mesh: triangle starts fully inside the garment
    var bib = S.bib ? { pos: [], nor: [], uv: [], si: [], sw: [] } : null;

    function isArm(dom) { return /upperarm|lowerarm/.test(dom); }
    function topOff(x, y) {
      var ax = Math.abs(x);
      var body = S.t0 + S.flare * sat((chestY - y) / Math.max(0.05, chestY - hemY));
      var sl = S.s0 + S.sFlare * sat((ax - 0.2) / Math.max(0.05, sleeveEnd - 0.2));
      var w = smooth(0.17, 0.27, ax);
      return body * (1 - w) + sl * w;
    }
    function legOff(y) {
      return S.p0 + S.pFlare * sat((J.thigh_l.y - y) / Math.max(0.05, J.thigh_l.y - legEnd));
    }
    function faceOval(x, y, z) {
      return z > headZ + 0.035 && y < M.eyeY + 0.065 && y > M.chin - 0.04 && Math.abs(x) < 0.078;
    }

    // ---- uv mappers (u may exceed 1: wrapS = repeat, every row is full width) ----
    function uvTorso(x, y, z) {
      var phi = Math.atan2(x, z - zc);             // 0 front, +pi/2 the body's left
      var u = 0.25 + phi / (2 * Math.PI); if (u < 0) u += 1;
      var v = sat((topY - y) / (topY - hemY + 0.0001));
      return [u, (RT.y0 + v * (RT.y1 - RT.y0)) / H];
    }
    function uvSleeve(x, y, z) {
      var th = Math.atan2(z - J.upperarm_l.z, y - J.upperarm_l.y);   // 0 = top of the arm
      var u = 0.5 + th / (2 * Math.PI);
      var v = sat((Math.abs(x) - shoulderX) / (sleeveEnd - shoulderX));
      return [u, (RS.y0 + v * (RS.y1 - RS.y0)) / H];
    }
    function uvLeg(x, y, z) {
      var s = x >= 0 ? 1 : -1;
      var ph = Math.atan2(z, s * x - J.thigh_l.x);   // 0 = outer side
      var u = 0.5 + ph / (2 * Math.PI);
      var v = sat((waistY - y) / (waistY - legEnd));
      return [u, (RP.y0 + v * (RP.y1 - RP.y0)) / H];
    }
    function patch(c) { return [(c + 0.5) / 8, PATCH_Y / H]; }

    var bi = {}; // bone index cache
    function bIdx(n) { return bi[n] != null ? bi[n] : (bi[n] = boneIndex(bones, n)); }

    function emit(dst, verts, uvs) {
      // seam fix: a triangle that straddles u=0/1 is unwrapped into u>1
      if (!uvs.patch) {
        var mn = Math.min(uvs[0][0], uvs[1][0], uvs[2][0]), mx = Math.max(uvs[0][0], uvs[1][0], uvs[2][0]);
        if (mx - mn > 0.5) for (var q = 0; q < 3; q++) if (uvs[q][0] < 0.5) uvs[q][0] += 1;
      }
      for (var k = 0; k < 3; k++) {
        var vv = verts[k];
        dst.pos.push(vv.x, vv.y, vv.z);
        dst.nor.push(vv.nx, vv.ny, vv.nz);
        dst.uv.push(uvs[k][0], uvs[k][1]);
        dst.si.push(vv.si[0], vv.si[1], vv.si[2], vv.si[3]);
        dst.sw.push(vv.sw[0], vv.sw[1], vv.sw[2], vv.sw[3]);
      }
    }

    meshes.forEach(function (mesh, mi) {
      var g = mesh.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight;
      var pm = M.perMesh[mi], N = normals[mi];
      if (!pm) return;
      // rest-pose (T-pose) positions: the space every threshold is measured in
      var RP_ = pm.P;
      var pa = { count: pm.n,
        getX: function (i) { return RP_[i * 3]; }, getY: function (i) { return RP_[i * 3 + 1]; }, getZ: function (i) { return RP_[i * 3 + 2]; } };
      // this mesh's bone order may differ from the base skeleton: remap by name
      var remap = mesh.skeleton.bones.map(function (b) { return boneIndex(bones, b.name); });
      function vert(i) {
        return {
          x: pa.getX(i), y: pa.getY(i), z: pa.getZ(i),
          nx: N[i * 3], ny: N[i * 3 + 1], nz: N[i * 3 + 2],
          si: [remap[sI.getX(i)], remap[sI.getY(i)], remap[sI.getZ(i)], remap[sI.getW(i)]],
          sw: [sW.getX(i), sW.getY(i), sW.getZ(i), sW.getW(i)],
          dom: pm.dom[i],
        };
      }
      for (var t = 0; t + 2 < pa.count; t += 3) {
        var cx = (pa.getX(t) + pa.getX(t + 1) + pa.getX(t + 2)) / 3;
        var cy = (pa.getY(t) + pa.getY(t + 1) + pa.getY(t + 2)) / 3;
        var cz = (pa.getZ(t) + pa.getZ(t + 1) + pa.getZ(t + 2)) / 3;
        var dom = pm.dom[t] || '';
        var ax = Math.abs(cx);
        if (/index|middle|ring_|pinky|thumb|hand|ball|foot/.test(dom)) continue;
        // ---- is the body triangle fully under cloth? (then it is never seen) ----
        var y0 = Math.min(pa.getY(t), pa.getY(t + 1), pa.getY(t + 2)), y1 = Math.max(pa.getY(t), pa.getY(t + 1), pa.getY(t + 2));
        var ax1 = Math.max(Math.abs(pa.getX(t)), Math.abs(pa.getX(t + 1)), Math.abs(pa.getX(t + 2)));
        var under = false;
        if (/spine|clavicle/.test(dom)) under = y1 < J.neck_01.y - 0.035 && (S.sleeve !== 'none' || ax1 < 0.14);
        else if (isArm(dom)) under = S.sleeve !== 'none' && ax1 < sleeveEnd - 0.012;
        else if (/pelvis/.test(dom)) under = y0 > hemY + 0.01 || (y1 < waistY - 0.01 && y0 > legEnd + 0.01);
        else if (/thigh/.test(dom)) under = y0 > legEnd + 0.012 || (!!S.longHem && y0 > hemY + 0.01);
        else if (/calf/.test(dom)) under = y0 > legEnd + 0.012;
        if (under) (hidden[mi] || (hidden[mi] = [])).push(t);

        // ---------- TOP ----------
        var inTop = false;
        var ymax = Math.max(pa.getY(t), pa.getY(t + 1), pa.getY(t + 2));
        if (/spine|clavicle/.test(dom)) inTop = true;
        else if (/pelvis/.test(dom)) inTop = ymax > hemY;
        else if (isArm(dom)) inTop = S.sleeve !== 'none';
        else if (/thigh/.test(dom)) inTop = !!S.longHem && ymax > hemY;
        if (S.sleeve === 'none' && ax > 0.155) inTop = false;
        if (/neck|Head/.test(dom)) inTop = false;
        if (inTop) {
          var poly = clip([vert(t), vert(t + 1), vert(t + 2)], function (v) { return v.y - hemY; });
          if (isArm(dom)) poly = clip(poly, function (v) { return sleeveEnd - Math.abs(v.x); });
          if (S.sleeve === 'none') poly = clip(poly, function (v) { return 0.155 - Math.abs(v.x); });
          var trimTri = -1;
          if (cy > J.neck_01.y - 0.05 && ax < 0.11 && S.collar !== 'none' && S.collar !== 'v') trimTri = P.TRIM;
          else if (isArm(dom) && S.sleeve !== 'none' && ax > sleeveEnd - (S.sleeve === 'long' ? 0.045 : 0.022)) trimTri = S.sleeve === 'long' && !S.zip && S.collar !== 'crew' ? P.RIB : P.TRIM;
          else if (S.ribHem && cy < hemY + 0.035 && !isArm(dom)) trimTri = P.RIB;
          var armTri = isArm(dom) || ax > 0.2;
          fan(poly, function (vs) {
            var uvs = [];
            for (var k = 0; k < 3; k++) {
              var v = vs[k] = Object.assign({}, vs[k]);
              var d = topOff(v.x, v.y);
              v.x += v.nx * d; v.y += v.ny * d; v.z += v.nz * d;
              uvs.push(armTri ? uvSleeve(v.x, v.y, v.z) : uvTorso(v.x, v.y, v.z));
            }
            if (trimTri >= 0) { uvs = [patch(trimTri), patch(trimTri), patch(trimTri)]; uvs.patch = true; }
            emit(out, vs, uvs);
          });

          // ---------- pinnie bib (over the tee, open at the sides) ----------
          if (bib && !isArm(dom) && ax < 0.16 && cy > hemY + 0.03) {
            var phi = Math.atan2(cx, cz - zc);
            var side = Math.abs(Math.abs(phi) - Math.PI / 2) < 0.42;
            if (!side) {
              fan(clip([vert(t), vert(t + 1), vert(t + 2)], function (v) { return v.y - hemY - 0.03; }), function (vb) {
                var ub = [];
                for (var k2 = 0; k2 < 3; k2++) {
                  var w2 = vb[k2] = Object.assign({}, vb[k2]);
                  var db = topOff(w2.x, w2.y) + 0.018 + 0.02 * sat((chestY - w2.y) / 0.4);
                  w2.x += w2.nx * db; w2.y += w2.ny * db; w2.z += w2.nz * db;
                  ub.push(uvTorso(w2.x, w2.y, w2.z));
                }
                emit(bib, vb, ub);
              });
            }
          }
        }

        // ---------- SHORTS / TROUSERS ----------
        var inLeg = false;
        var ymin = Math.min(pa.getY(t), pa.getY(t + 1), pa.getY(t + 2));
        if (/pelvis/.test(dom)) inLeg = ymin < waistY;
        else if (/thigh/.test(dom)) inLeg = true;
        else if (/calf/.test(dom)) inLeg = ymax > legEnd;
        if (/spine/.test(dom) && ymin < waistY) inLeg = true;
        if (inLeg) {
          var lp = clip([vert(t), vert(t + 1), vert(t + 2)], function (v) { return v.y - legEnd; });
          lp = clip(lp, function (v) { return waistY - v.y; });
          var tl = cy > waistY - 0.03 ? P.PRIB : -1;
          fan(lp, function (vl) {
            var ul = [];
            for (var k3 = 0; k3 < 3; k3++) {
              var u2 = vl[k3] = Object.assign({}, vl[k3]);
              var dl = legOff(u2.y);
              u2.x += u2.nx * dl; u2.y += u2.ny * dl; u2.z += u2.nz * dl;
              ul.push(uvLeg(u2.x, u2.y, u2.z));
            }
            if (tl >= 0) { ul = [patch(tl), patch(tl), patch(tl)]; ul.patch = true; }
            emit(out, vl, ul);
          });
        }

        // ---------- HOOD (up) ----------
        if (S.hood === 'up' && (/Head/.test(dom) || /neck/.test(dom))) {
          if (!faceOval(cx, cy, cz) && cy < M.top + 0.01) {
            var vh = [vert(t), vert(t + 1), vert(t + 2)], uh = [];
            for (k = 0; k < 3; k++) {
              var h = vh[k];
              var dh = 0.022 + 0.026 * sat((headZ - h.z) / 0.1) + 0.008 * sat((h.y - M.eyeY) / 0.1);
              h.x += h.nx * dh; h.y += h.ny * dh; h.z += h.nz * dh;
              uh.push(patch(P.SHIRT));
            }
            uh.patch = true;
            emit(out, vh, uh);
          }
        }
      }
    });

    // ---------- rigid extras (bind space, skinned to one bone) ----------
    function addRigid(dst, geo, boneName, patchId) {
      var gg = geo.index ? geo.toNonIndexed() : geo;
      var p2 = gg.attributes.position, n2 = gg.attributes.normal, b = bIdx(boneName);
      var pu = patch(patchId);
      for (var i = 0; i < p2.count; i++) {
        dst.pos.push(p2.getX(i), p2.getY(i), p2.getZ(i));
        dst.nor.push(n2.getX(i), n2.getY(i), n2.getZ(i));
        dst.uv.push(pu[0], pu[1]);
        dst.si.push(b, 0, 0, 0); dst.sw.push(1, 0, 0, 0);
      }
    }
    // front surface depth of the finished shell at a height (for strings)
    function frontZ(y) {
      var best = -1;
      for (var i = 0; i < out.pos.length; i += 3) {
        if (Math.abs(out.pos[i]) < 0.04 && Math.abs(out.pos[i + 1] - y) < 0.03 && out.pos[i + 2] > best) best = out.pos[i + 2];
      }
      return best > -1 ? best : 0.13;
    }
    if (S.hood === 'down') {
      // the folded hood lying on the upper back
      var hg = new THREE.SphereGeometry(0.1, 14, 10);
      if (typeof hg.scale === 'function') hg.scale(1.45, 0.62, 0.72);
      hg.translate(0, J.neck_01.y - 0.035, J.neck_01.z - 0.095);
      addRigid(out, hg, 'spine_03', P.SHIRT);
      var rim = new THREE.TorusGeometry(0.085, 0.02, 6, 16, Math.PI);
      rim.rotateX(Math.PI / 2); rim.rotateY(Math.PI);
      rim.translate(0, J.neck_01.y - 0.012, J.neck_01.z - 0.005);
      addRigid(out, rim, 'spine_03', P.LINING);
    }
    if (S.hood) {
      // drawstrings
      var fz = frontZ(J.neck_01.y - 0.07);
      for (var s = -1; s <= 1; s += 2) {
        var cg = new THREE.CylinderGeometry(0.0045, 0.0045, 0.15, 5);
        cg.translate(s * 0.032, J.neck_01.y - 0.1, fz + 0.006);
        addRigid(out, cg, 'spine_03', P.WHITE);
        var tip = new THREE.CylinderGeometry(0.0065, 0.0065, 0.022, 5);
        tip.translate(s * 0.032, J.neck_01.y - 0.18, fz + 0.006);
        addRigid(out, tip, 'spine_03', P.DARK);
      }
    }
    if (S.collar === 'stand') {
      var cg2 = new THREE.CylinderGeometry(0.068, 0.074, 0.055, 16, 1, true);
      cg2.translate(0, J.neck_01.y + 0.0, J.neck_01.z + 0.004);
      addRigid(out, cg2, 'neck_01', P.TRIM);
    }

    function pack(o) {
      if (!o || !o.pos.length) return null;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(o.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(o.si, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(o.sw, 4));
      geo.computeBoundingSphere();
      return geo;
    }
    return { main: pack(out), bib: pack(bib), tris: out.pos.length / 9, hidden: hidden, keep: null };
  }

  // ---------------- kit textures ----------------
  var TEXCACHE = {};
  function canvas(w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d');
    return g && g.fillRect ? { c: c, g: g } : null;
  }
  // deterministic fabric grain (no Math.random: the sim stream is pinned)
  function grain(g, x0, y0, w, h, amt, seed) {
    var s = seed || 7;
    for (var i = 0; i < (w * h) / 90; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      var x = x0 + (s % w); s = (s * 1664525 + 1013904223) >>> 0;
      var y = y0 + (s % h);
      g.fillStyle = (s & 1) ? 'rgba(255,255,255,' + amt + ')' : 'rgba(0,0,0,' + amt + ')';
      g.fillRect(x, y, 2, 1);
    }
  }
  function folds(g, x0, y0, w, h, n, amt) {
    // soft vertical fold shadows for loose fabric
    for (var i = 0; i < n; i++) {
      var x = x0 + ((i * 97 + 31) % w);
      var gr = g.createLinearGradient(x - 10, 0, x + 10, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, 'rgba(0,0,0,' + amt + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - 10, y0 + h * 0.25, 20, h * 0.75);
    }
  }
  function numberText(g, n, x, y, size, fill, stroke) {
    g.save();
    g.font = '900 ' + size + 'px "Arial Black", Impact, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(4, size * 0.09); g.strokeStyle = hex(stroke);
    g.strokeText(String(n), x, y);
    g.fillStyle = hex(fill); g.fillText(String(n), x, y);
    g.restore();
  }
  function crest(g, x, y, r, fill, line) {
    g.save();
    g.beginPath();
    g.moveTo(x - r, y - r); g.lineTo(x + r, y - r); g.lineTo(x + r, y + r * 0.2);
    g.quadraticCurveTo(x + r * 0.9, y + r * 1.0, x, y + r * 1.35);
    g.quadraticCurveTo(x - r * 0.9, y + r * 1.0, x - r, y + r * 0.2);
    g.closePath();
    g.fillStyle = hex(fill); g.fill();
    g.lineWidth = 3; g.strokeStyle = hex(line); g.stroke();
    g.fillStyle = hex(line);
    g.font = '900 ' + Math.round(r * 0.9) + 'px Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('B', x, y + r * 0.1);
    g.restore();
  }
  // torso helpers: canvas x of a body angle (0 = front centre)
  function tx(phi) { var u = 0.25 + phi / (2 * Math.PI); if (u < 0) u += 1; return u * W; }
  var FRONT = W * 0.25, BACK = W * 0.75, LSIDE = W * 0.5, RSIDE = 0;

  function paint(design, pal, num) {
    var key = design + ':' + pal.shirt + ':' + pal.trim + ':' + pal.shorts + ':' + num;
    if (TEXCACHE[key]) return TEXCACHE[key];
    var cv = canvas(W, H);
    if (!cv) return null;
    var g = cv.g, S = SPECS[design];
    var shirt = pal.shirt, trim = pal.trim, pants = pal.shorts;
    var dark = shade(shirt, 0.72), rib = shade(shirt, 0.78);
    var tY0 = RT.y0, tH = RT.y1 - RT.y0;

    // ---- base fills ----
    g.fillStyle = hex(shirt); g.fillRect(0, RT.y0, W, RS.y1 - RT.y0 + 2);
    g.fillStyle = hex(pants); g.fillRect(0, RP.y0 - 2, W, RP.y1 - RP.y0 + 4);
    // side shading (cheap ambient occlusion under the arms / at the sides)
    [LSIDE, RSIDE, W].forEach(function (x) {
      var gr = g.createLinearGradient(x - 60, 0, x + 60, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.16)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - 60, tY0, 120, tH);
    });

    // ---- per design ----
    if (design === 'jersey' || design === 'keeper') {
      // contrast side panels with piping
      [LSIDE, RSIDE, W].forEach(function (x) {
        g.fillStyle = hex(dark); g.fillRect(x - 34, tY0 + 40, 68, tH - 40);
        g.fillStyle = hex(trim); g.fillRect(x - 36, tY0 + 40, 4, tH - 40); g.fillRect(x + 32, tY0 + 40, 4, tH - 40);
      });
      // V-neck
      g.fillStyle = hex(trim);
      g.beginPath(); g.moveTo(FRONT - 42, tY0); g.lineTo(FRONT, tY0 + 46); g.lineTo(FRONT + 42, tY0);
      g.lineTo(FRONT + 30, tY0); g.lineTo(FRONT, tY0 + 30); g.lineTo(FRONT - 30, tY0); g.closePath(); g.fill();
      g.fillRect(BACK - 46, tY0, 92, 8);
      if (design === 'jersey') {
        // chest chevron
        g.globalAlpha = 0.9; g.lineWidth = 9; g.strokeStyle = hex(trim);
        g.beginPath(); g.moveTo(FRONT - 70, tY0 + 92); g.lineTo(FRONT, tY0 + 128); g.lineTo(FRONT + 70, tY0 + 92); g.stroke();
        g.globalAlpha = 1;
        crest(g, tx(0.42), tY0 + 72, 13, shade(shirt, 0.6), trim);
        numberText(g, num, tx(-0.38), tY0 + 76, 30, trim, dark);
      } else {
        // keeper: shoulder blocks + elbow pads
        g.fillStyle = hex(dark); g.fillRect(0, tY0, W, 34);
        g.fillStyle = hex(trim); g.fillRect(0, tY0 + 34, W, 5);
        crest(g, tx(0.42), tY0 + 80, 13, dark, trim);
        g.fillStyle = hex(shade(shirt, 0.55)); g.fillRect(0, RS.y0 + 42, W, 14);
      }
      numberText(g, num, BACK, tY0 + 140, 120, trim, dark);
      // sleeve band near the cuff
      g.fillStyle = hex(trim); g.fillRect(0, RS.y1 - 22, W, 6);
      // shorts: side stripe + number
      g.fillStyle = hex(trim); g.fillRect(W * 0.5 - 7, RP.y0, 14, RP.y1 - RP.y0);
      numberText(g, num, W * 0.66, RP.y0 + 34, 22, trim, shade(pants, 0.6));
    } else if (design === 'baggy' || design === 'oversize') {
      // oversized street tee: wide chest band + side panels in the shorts colour
      [LSIDE, RSIDE, W].forEach(function (x) {
        g.fillStyle = hex(pants); g.fillRect(x - 26, tY0 + 60, 52, tH - 60);
      });
      if (design === 'baggy') {
        g.fillStyle = hex(trim); g.fillRect(0, tY0 + 84, W, 34);
        g.fillStyle = hex(dark); g.fillRect(0, tY0 + 118, W, 6);
        g.save(); g.font = '900 26px "Arial Black", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = hex(shirt); g.fillText('BLACKOUT', FRONT, tY0 + 102); g.restore();
        numberText(g, num, BACK, tY0 + 176, 136, trim, dark);
        g.fillStyle = hex(trim); g.fillRect(0, RS.y1 - 12, W, 8);
      } else {
        g.fillStyle = hex(shade(shirt, 1.25)); g.globalAlpha = 0.85;
        g.beginPath(); g.arc(FRONT, tY0 + 120, 44, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      }
      folds(g, 0, tY0, W, tH, 9, 0.16);
      folds(g, 0, RS.y0, W, RS.y1 - RS.y0, 5, 0.12);
      // baggy shorts: double side stripes + fold shading
      g.fillStyle = hex(trim); g.fillRect(W * 0.5 - 15, RP.y0, 9, RP.y1 - RP.y0); g.fillRect(W * 0.5 + 6, RP.y0, 9, RP.y1 - RP.y0);
      folds(g, 0, RP.y0, W, RP.y1 - RP.y0, 6, 0.14);
    } else if (design === 'hoody' || design === 'hoodydown' || design === 'hoodie') {
      // kangaroo pocket
      var py = tY0 + tH - 120;
      g.fillStyle = hex(shade(shirt, 0.9));
      g.beginPath();
      g.moveTo(FRONT - 78, py + 92); g.lineTo(FRONT - 62, py); g.lineTo(FRONT + 62, py); g.lineTo(FRONT + 78, py + 92); g.closePath(); g.fill();
      g.strokeStyle = hex(shade(shirt, 0.62)); g.lineWidth = 3; g.setLineDash && g.setLineDash([6, 4]);
      g.stroke(); g.setLineDash && g.setLineDash([]);
      g.lineWidth = 4; g.strokeStyle = hex(shade(shirt, 0.55));
      g.beginPath(); g.moveTo(FRONT - 66, py + 12); g.lineTo(FRONT - 76, py + 88); g.stroke();
      g.beginPath(); g.moveTo(FRONT + 66, py + 12); g.lineTo(FRONT + 76, py + 88); g.stroke();
      // chest print
      if (design !== 'hoodie') {
        g.save(); g.font = '900 22px "Arial Black", Arial, sans-serif'; g.textAlign = 'center';
        g.fillStyle = hex(trim); g.fillText('BLACKOUT', FRONT, tY0 + 92); g.restore();
        numberText(g, num, BACK, tY0 + 130, 100, trim, dark);
      }
      folds(g, 0, tY0, W, tH, 6, 0.1);
      g.fillStyle = hex(trim); g.fillRect(W * 0.5 - 6, RP.y0, 12, RP.y1 - RP.y0);
    } else if (design === 'track' || design === 'jacket') {
      // zip + two-tone yoke
      g.fillStyle = hex(dark); g.fillRect(0, tY0, W, 60);
      g.fillStyle = hex(trim); g.fillRect(FRONT - 3, tY0, 6, tH);
      g.fillStyle = '#c9c9c9'; g.fillRect(FRONT - 6, tY0 + 6, 12, 20);
      if (design === 'track') {
        // three stripes down the sleeves and the shorts
        for (var k = -1; k <= 1; k++) {
          g.fillStyle = hex(trim); g.fillRect(W * 0.5 + k * 16 - 5, RS.y0, 10, RS.y1 - RS.y0);
          g.fillRect(W * 0.5 + k * 14 - 4, RP.y0, 8, RP.y1 - RP.y0);
        }
        g.fillStyle = hex(trim); g.fillRect(LSIDE - 4, tY0 + 60, 8, tH - 60); g.fillRect(W - 4, tY0 + 60, 8, tH - 60); g.fillRect(0, tY0 + 60, 4, tH - 60);
        crest(g, tx(0.45), tY0 + 82, 11, dark, trim);
        numberText(g, num, BACK, tY0 + 140, 96, trim, dark);
      } else {
        folds(g, 0, tY0, W, tH, 7, 0.12);
        g.fillStyle = hex(shade(shirt, 0.6)); g.fillRect(FRONT - 70, tY0 + tH - 100, 40, 4); g.fillRect(FRONT + 30, tY0 + tH - 100, 40, 4);
      }
    } else if (design === 'windbreaker') {
      // two-tone shoulder yoke (old box body: the trim band across the shoulders)
      g.fillStyle = hex(trim); g.fillRect(0, tY0, W, 96);
      g.fillStyle = hex(dark); g.fillRect(0, tY0 + 96, W, 6);
      g.fillStyle = hex(trim); g.fillRect(0, RS.y0, W, 28);
      g.fillStyle = hex(shade(shirt, 0.5)); g.fillRect(FRONT - 2, tY0, 4, tH);
      g.fillStyle = hex(shade(trim, 0.5)); g.fillRect(FRONT - 2, tY0, 4, 96);
      // reflective strip + chest pocket
      g.fillStyle = '#e8e8e8'; g.fillRect(0, tY0 + 182, W, 6);
      g.fillStyle = hex(shade(shirt, 0.82)); g.fillRect(tx(0.5) - 24, tY0 + 120, 48, 34);
      numberText(g, num, BACK, tY0 + 170, 88, shirt === trim ? 0xffffff : trim, dark);
      folds(g, 0, tY0 + 100, W, tH - 100, 6, 0.1);
      g.fillStyle = hex(trim); g.fillRect(W * 0.5 - 6, RP.y0, 12, RP.y1 - RP.y0);
    } else if (design === 'longsleeve') {
      // compression top: flat-lock seam lines + mesh side panels
      g.strokeStyle = hex(shade(shirt, 0.7)); g.lineWidth = 2;
      [LSIDE, RSIDE, W].forEach(function (x) { g.strokeRect(x - 30, tY0 + 30, 60, tH); });
      g.beginPath(); g.moveTo(FRONT - 90, tY0 + 20); g.quadraticCurveTo(FRONT, tY0 + 150, FRONT + 90, tY0 + 20); g.stroke();
      g.fillStyle = hex(trim); g.fillRect(0, RS.y0 + 6, W, 4);
      crest(g, tx(0.42), tY0 + 70, 11, dark, trim);
      numberText(g, num, BACK, tY0 + 130, 100, trim, dark);
      g.fillStyle = hex(trim); g.fillRect(W * 0.5 - 6, RP.y0, 12, RP.y1 - RP.y0);
    } else if (design === 'pinnie') {
      // the tee under the bib is the trim colour
      g.fillStyle = hex(trim === 0xffffff ? 0xe6e6e1 : trim); g.fillRect(0, RT.y0, W, RS.y1 - RT.y0);
      g.fillStyle = hex(shirt); g.fillRect(0, RS.y1 - 12, W, 8);
      g.fillStyle = hex(trim); g.fillRect(W * 0.5 - 6, RP.y0, 12, RP.y1 - RP.y0);
    } else if (design === 'tee') {
      g.fillStyle = hex(shade(shirt, 1.3));
      g.save(); g.font = '900 30px Arial, sans-serif'; g.textAlign = 'center';
      g.fillText(['NYC', 'LDN', '★', 'SK8', 'LAGOS', 'PARIS'][num % 6], FRONT, tY0 + 120); g.restore();
      folds(g, 0, tY0, W, tH, 5, 0.1);
    } else if (design === 'tank') {
      g.fillStyle = hex(trim); g.fillRect(0, tY0 + 70, W, 10);
    }

    // jeans / trousers detail
    if (S.legs === 'trousers') {
      g.strokeStyle = hex(shade(pants, 1.35)); g.lineWidth = 2;
      g.setLineDash && g.setLineDash([5, 4]);
      g.beginPath(); g.moveTo(W * 0.5, RP.y0); g.lineTo(W * 0.5, RP.y1); g.stroke();
      g.beginPath(); g.moveTo(0, RP.y0 + 14); g.lineTo(W, RP.y0 + 14); g.stroke();
      g.setLineDash && g.setLineDash([]);
      folds(g, 0, RP.y0, W, RP.y1 - RP.y0, 8, 0.12);
    }

    grain(g, 0, 0, W, PATCH_Y - 16, 0.045, (shirt ^ num) >>> 0);

    // ---- solid patches (collars, cuffs, ribbing, hood, strings) ----
    var patches = [trim, rib, shade(pants, 0.7), shirt, shade(shirt, 0.55), 0x1c1c20, pants, 0xefefea];
    for (var c = 0; c < 8; c++) {
      g.fillStyle = hex(patches[c]); g.fillRect(c * 64, PATCH_Y - 16, 64, 32);
      if (c === P.RIB || c === P.PRIB) {     // ribbing lines
        g.fillStyle = 'rgba(0,0,0,0.18)';
        for (var r = 0; r < 64; r += 6) g.fillRect(c * 64 + r, PATCH_Y - 16, 2, 32);
      }
    }

    var tex = new THREE.CanvasTexture(cv.c);
    tex.flipY = false;
    tex.wrapS = THREE.RepeatWrapping;
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    TEXCACHE[key] = tex;
    return tex;
  }

  // the pinnie's mesh bib: team colour, see-through mesh holes, numbers
  function paintBib(pal, num) {
    var key = 'bib:' + pal.shirt + ':' + num;
    if (TEXCACHE[key]) return TEXCACHE[key];
    var cv = canvas(W, H);
    if (!cv) return null;
    var g = cv.g;
    g.clearRect(0, 0, W, H);
    g.fillStyle = hex(pal.shirt); g.fillRect(0, 0, W, RT.y1 + 4);
    // mesh holes
    g.globalCompositeOperation = 'destination-out';
    for (var y = 6; y < RT.y1; y += 7) for (var x = (y / 7) % 2 ? 3 : 6; x < W; x += 7) g.fillRect(x, y, 3, 3);
    g.globalCompositeOperation = 'source-over';
    // hem + edge binding
    g.fillStyle = hex(shade(pal.shirt, 0.6)); g.fillRect(0, RT.y1 - 8, W, 12); g.fillRect(0, 0, W, 8);
    numberText(g, num, FRONT, 120, 84, 0xffffff, shade(pal.shirt, 0.5));
    numberText(g, num, BACK, 130, 110, 0xffffff, shade(pal.shirt, 0.5));
    var tex = new THREE.CanvasTexture(cv.c);
    tex.flipY = false; tex.wrapS = THREE.RepeatWrapping;
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    TEXCACHE[key] = tex;
    return tex;
  }

  var MATCACHE = {};
  function material(tex, shiny, alpha) {
    var k = (tex ? tex.uuid : 'none') + ':' + !!shiny + ':' + !!alpha;
    if (MATCACHE[k]) return MATCACHE[k];
    var m = new THREE.MeshStandardMaterial({
      map: tex, roughness: shiny ? 0.42 : 0.86, metalness: 0,
      side: THREE.DoubleSide,
    });
    if (alpha) { m.alphaTest = 0.5; m.transparent = false; }
    MATCACHE[k] = m;
    return m;
  }

  // ---------------- public ----------------
  // dress(clone, meta, palette, design, number, {lean}) -> { meshes, hood, design } | null
  function dress(clone, M, pal, design, num, opts) {
    if (!SPECS[design]) design = 'jersey';
    var meshes = [];
    clone.traverse(function (o) { if (o.isSkinnedMesh && !o.userData.garment) meshes.push(o); });
    if (!meshes.length) return null;
    var G = GEOCACHE[design] || (GEOCACHE[design] = buildGeometry(meshes, M, design));
    if (!G || !G.main) return null;
    var tex = paint(design, pal, num == null ? 0 : num);
    var made = [];
    var base = meshes[0];
    // the garment is authored in the REST pose, so it binds with rest inverses
    var skel = M.restInv ? new THREE.Skeleton(base.skeleton.bones, M.restInv) : base.skeleton;
    function add(geo, mat) {
      var sm = new THREE.SkinnedMesh(geo, mat);
      sm.bind(skel, new THREE.Matrix4());
      sm.frustumCulled = false;
      sm.castShadow = true;
      sm.receiveShadow = false;
      sm.userData.garment = design;
      sm.name = 'garment_' + design;
      base.parent.add(sm);
      made.push(sm);
    }
    // cull body triangles that are fully under the cloth (one shared index
    // per design and body mesh). The colour pass already gave every clone
    // its own geometry object that shares the attributes, so setIndex is
    // per clone and cheap.
    // lean: also drop the finger-joint rings (~7k tiny knuckle triangles)
    // for far-away people and on MEDIUM/LOW quality
    var lean = !!(opts && opts.lean);
    var kk = lean ? 'keepLean' : 'keep';
    if (!G[kk]) {
      G[kk] = meshes.map(function (m, mi) {
        var n = m.geometry.attributes.position.count, h = {}, list = G.hidden[mi] || [];
        for (var q = 0; q < list.length; q++) h[list[q]] = 1;
        var pm = M.perMesh[mi];
        if (lean && pm && pm.joints) {
          for (var f = 0; f + 2 < n; f += 3) if (/thumb|index|middle|ring_|pinky/.test(pm.dom[f] || '')) h[f] = 1;
        }
        var idx = [];
        for (var t2 = 0; t2 + 2 < n; t2 += 3) if (!h[t2]) idx.push(t2, t2 + 1, t2 + 2);
        return new THREE.BufferAttribute(n > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1);
      });
    }
    var culled = 0;
    meshes.forEach(function (m, mi) {
      if (!G[kk][mi] || m.geometry.index) return;
      m.geometry.setIndex(G[kk][mi]);
      culled += (m.geometry.attributes.position.count - G[kk][mi].count) / 3;
    });
    add(G.main, material(tex, SPECS[design].shiny, false));
    if (G.bib) add(G.bib, material(paintBib(pal, num == null ? 0 : num), false, true));
    return { meshes: made, hood: SPECS[design].hood === 'up', design: design, tris: G.tris, culled: culled };
  }

  return {
    dress: dress,
    designs: function () { return Object.keys(SPECS); },
    street: STREET.slice(),
    spec: function (d) { return SPECS[d] || null; },
    // for probes: how many triangles a design's shell has once built
    stats: function () {
      var o = {};
      Object.keys(GEOCACHE).forEach(function (k) { o[k] = GEOCACHE[k] ? GEOCACHE[k].tris : 0; });
      return { designs: o, textures: Object.keys(TEXCACHE).length };
    },
  };
})();
