// ============================================================
// FANBODY — realistic body parts for the instanced crowd (Build 3).
//
// The crowd draws ~100 spectators with a handful of InstancedMeshes (one
// per body part), which is why they were capsules and boxes. This module
// cuts the real athlete body (the same CC0 mannequin the players use) into
// those same rigid parts — legs, hips, torso, head, hair, upper arms,
// forearms + hands, shoes — in the REST pose, hangs the arms down from the
// shoulders, simplifies each part by vertex clustering (a few hundred
// triangles per fan instead of ~13k) and re-expresses it around the crowd's
// pivots. The crowd keeps its 1-matrix-per-part animation.
//
// Output frame (same as LG.Crowd): origin = "hip" placement point, feet at
// y = -0.74, +z forward. Returned pivots let the crowd move its anchors.
// ============================================================
var LG = window.LG = window.LG || {};

LG.FanBody = (function () {
  var cache = {};

  function partOf(dom, x) {
    if (/thumb|index|middle|ring_|pinky|hand|lowerarm/.test(dom)) return x > 0 ? 'hand' : null;
    if (/upperarm/.test(dom)) return x > 0 ? 'arm' : null;
    if (/clavicle/.test(dom)) return 'torso';
    if (/foot|ball/.test(dom)) return 'feet';
    if (/thigh|calf/.test(dom)) return 'legs';
    if (/pelvis/.test(dom)) return 'hip';
    if (/spine/.test(dom)) return 'torso';
    if (/neck|Head/.test(dom)) return 'head';
    return null;
  }

  // vertex clustering: snap to a grid, average each cell, drop triangles
  // that collapse. Smooth normals are averaged per cell.
  function cluster(tris, cell) {
    var cells = {}, list = [];
    function key(x, y, z) { return Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell); }
    for (var i = 0; i < tris.length; i += 3) {
      var k = key(tris[i], tris[i + 1], tris[i + 2]);
      var c = cells[k];
      if (!c) { c = cells[k] = { x: 0, y: 0, z: 0, n: 0, nx: 0, ny: 0, nz: 0, id: list.length }; list.push(c); }
      c.x += tris[i]; c.y += tris[i + 1]; c.z += tris[i + 2]; c.n++;
    }
    list.forEach(function (c) { c.x /= c.n; c.y /= c.n; c.z /= c.n; });
    var idx = [];
    var seen = {};
    for (i = 0; i < tris.length; i += 9) {
      var a = cells[key(tris[i], tris[i + 1], tris[i + 2])];
      var b = cells[key(tris[i + 3], tris[i + 4], tris[i + 5])];
      var d = cells[key(tris[i + 6], tris[i + 7], tris[i + 8])];
      if (a === b || b === d || a === d) continue;
      var sk = [a.id, b.id, d.id].sort().join('_');
      if (seen[sk]) continue;
      seen[sk] = 1;
      // face normal into each cell
      var ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = d.x - a.x, vy = d.y - a.y, vz = d.z - a.z;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      [a, b, d].forEach(function (c) { c.nx += nx; c.ny += ny; c.nz += nz; });
      idx.push(a.id, b.id, d.id);
    }
    var pos = new Float32Array(list.length * 3), nor = new Float32Array(list.length * 3);
    list.forEach(function (c, j) {
      pos[j * 3] = c.x; pos[j * 3 + 1] = c.y; pos[j * 3 + 2] = c.z;
      var l = Math.sqrt(c.nx * c.nx + c.ny * c.ny + c.nz * c.nz) || 1;
      nor[j * 3] = c.nx / l; nor[j * 3 + 1] = c.ny / l; nor[j * 3 + 2] = c.nz / l;
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  // make(cell) -> { geos: {legs,hip,torso,head,hair,arm,hand,feet,scarf}, pivots, tris }
  function make(cell) {
    cell = cell || 0.026;
    if (cache[cell]) return cache[cell];
    if (!LG.Athlete || !LG.Athlete.meta || !LG.Athlete.meta()) return null;
    var M = LG.Athlete.meta(), J = M.J;
    var S = 0.93;                                     // ~1.70 m fan
    var FY = -0.74;                                   // feet in the crowd frame
    function fy(y) { return y * S + FY; }
    var piv = {
      hip: new THREE.Vector3(0, fy(J.pelvis.y), 0),
      waist: new THREE.Vector3(0, fy(J.spine_02.y - 0.12), 0),
      neck: new THREE.Vector3(0, fy(J.neck_01.y), 0),
      shL: new THREE.Vector3(J.upperarm_l.x * S, fy(J.upperarm_l.y), 0),
      shR: new THREE.Vector3(-J.upperarm_l.x * S, fy(J.upperarm_l.y), 0),
    };
    var raw = { legs: [], hip: [], torso: [], head: [], hair: [], arm: [], hand: [], feet: [] };
    var shx = J.upperarm_l.x, shy = J.upperarm_l.y, shz = J.upperarm_l.z;
    var hairY = M.eyeY + 0.02;
    M.perMesh.forEach(function (pm) {
      var P = pm.P;
      for (var t = 0; t + 2 < pm.n; t += 3) {
        var cx = (P[t * 3] + P[t * 3 + 3] + P[t * 3 + 6]) / 3;
        var cy = (P[t * 3 + 1] + P[t * 3 + 4] + P[t * 3 + 7]) / 3;
        var cz = (P[t * 3 + 2] + P[t * 3 + 5] + P[t * 3 + 8]) / 3;
        var part = partOf(pm.dom[t] || '', cx);
        if (!part) continue;
        var dst = raw[part];
        var hairToo = part === 'head' && cy > hairY && !(cz > J.Head.z + 0.06 && cy < M.eyeY + 0.07);
        for (var q = 0; q < 3; q++) {
          var x = P[(t + q) * 3], y = P[(t + q) * 3 + 1], z = P[(t + q) * 3 + 2];
          var X, Y, Z;
          if (part === 'arm' || part === 'hand') {
            // T-pose arm (+x) hangs down from the shoulder: rotate -90 deg about z
            var lx = x - shx, ly = y - shy;
            X = ly * S; Y = -lx * S; Z = (z - shz) * S;
            X += 0; // relative to the shoulder pivot already
          } else {
            X = x * S; Y = fy(y); Z = z * S;
            var pv = part === 'legs' || part === 'feet' || part === 'hip' ? piv.hip
              : part === 'torso' ? piv.waist : piv.neck;
            X -= pv.x; Y -= pv.y; Z -= pv.z;
          }
          dst.push(X, Y, Z);
          if (hairToo) {
            // hair: the cranium pushed out a little
            var nx = x - 0, ny = y - (M.eyeY - 0.01), nz = z - (J.Head.z - 0.01);
            var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1, o = 0.012;
            raw.hair.push((x + nx / l * o) * S - piv.neck.x, fy(y + ny / l * o) - piv.neck.y, (z + nz / l * o) * S - piv.neck.z);
          }
        }
      }
    });
    var geos = {}, tris = 0;
    Object.keys(raw).forEach(function (k) {
      if (!raw[k].length) return;
      geos[k] = cluster(raw[k], k === 'head' || k === 'hair' || k === 'hand' ? cell * 0.7 : cell);
      tris += geos[k].index.count / 3 * (k === 'arm' || k === 'hand' ? 2 : 1);
    });
    // team scarf around the neck (relative to the waist pivot)
    var sc = new THREE.TorusGeometry(0.085, 0.032, 4, 10);
    sc.rotateX(Math.PI / 2);
    sc.translate(0, piv.neck.y - piv.waist.y - 0.035, J.neck_01.z * S + 0.005);
    var tail = new THREE.BoxGeometry(0.07, 0.24, 0.02);
    tail.translate(0.045, piv.neck.y - piv.waist.y - 0.17, J.neck_01.z * S + 0.13);
    geos.scarf = mergeTwo(sc, tail);
    tris += geos.scarf.index.count / 3;
    var out = { geos: geos, pivots: piv, tris: tris, scale: S };
    cache[cell] = out;
    return out;
  }

  function mergeTwo(a, b) {
    var A = a.index ? a.toNonIndexed() : a, B = b.index ? b.toNonIndexed() : b;
    var pa = A.attributes.position.array, pb = B.attributes.position.array;
    var na = A.attributes.normal.array, nb = B.attributes.normal.array;
    var pos = new Float32Array(pa.length + pb.length); pos.set(pa); pos.set(pb, pa.length);
    var nor = new Float32Array(na.length + nb.length); nor.set(na); nor.set(nb, na.length);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    var idx = []; for (var i = 0; i < pos.length / 3; i++) idx.push(i);
    g.setIndex(idx);
    return g;
  }

  return { make: make };
})();
