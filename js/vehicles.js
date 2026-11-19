// ============================================================
// VEHICLES — Phase 11: car-shaped cars.
//
// One builder shared by the moving traffic (js/living.js) and the parked
// cars (js/arena.js). Every body is a real side profile (sedan, hatchback,
// van, taxi) extruded to width with a bevel, with a glass band, four
// wheels (tyre + rim, the front pair steerable), head/tail lights and a
// brake-light material the traffic can switch on. Geometry is built once
// per body type and shared; only paint materials are per colour.
//
// Returns { group, wheels:[{node, front}], brake: material, body: node,
//           length, width } — callers move the group and spin the wheels.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Vehicles = (function () {
  // side profiles (x = along the car, front = +x; y = height). Units: metres.
  var PROFILES = {
    sedan: { len: 4.2, w: 1.76, wheelR: 0.33, axle: 1.32, body: [
      [-2.1, 0.30], [-2.12, 0.72], [-1.95, 0.86], [-1.25, 0.92], [-0.85, 1.36], [0.35, 1.40],
      [0.95, 0.96], [1.95, 0.80], [2.1, 0.62], [2.08, 0.30]],
      glass: [[-1.18, 0.95], [-0.82, 1.31], [0.32, 1.35], [0.88, 0.98]] },
    hatch: { len: 3.8, w: 1.72, wheelR: 0.32, axle: 1.2, body: [
      [-1.9, 0.30], [-1.94, 0.78], [-1.8, 1.32], [0.3, 1.40], [0.92, 0.96], [1.8, 0.80],
      [1.92, 0.6], [1.9, 0.30]],
      glass: [[-1.78, 0.98], [-1.68, 1.28], [0.27, 1.35], [0.85, 0.99]] },
    van: { len: 4.8, w: 1.9, wheelR: 0.36, axle: 1.6, body: [
      [-2.4, 0.32], [-2.42, 1.95], [1.25, 1.98], [1.95, 1.05], [2.38, 0.88], [2.4, 0.32]],
      glass: [[0.6, 1.12], [0.62, 1.82], [1.22, 1.84], [1.85, 1.1]] },
  };
  var PAINT = [0xf2f2ef, 0x15161a, 0xa8adb3, 0x1e3a66, 0x8c1c1c, 0x2f4a36, 0x5a5f66, 0xd9d2c3, 0x0f5c8c, 0x7a1f3d];

  var geoCache = {}, matCache = {};
  function mat(key, make) { return matCache[key] || (matCache[key] = make()); }

  function shapeOf(pts) {
    var s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.lineTo(pts[0][0], pts[0][1]);
    return s;
  }

  // extrude a side profile across the car's width, centred, long axis -> z
  function extrude(pts, width, bevel) {
    var g = new THREE.ExtrudeGeometry(shapeOf(pts), {
      depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
      bevelSegments: 2, curveSegments: 1, steps: 1,
    });
    g.translate(0, 0, -(width - bevel * 2) / 2);
    g.rotateY(-Math.PI / 2);          // profile x (front) -> world +z
    g.computeVertexNormals();
    return g;
  }

  function geos(type) {
    if (geoCache[type]) return geoCache[type];
    var P = PROFILES[type] || PROFILES.sedan;
    var out = {
      body: extrude(P.body, P.w, 0.07),
      glass: extrude(P.glass, P.w + 0.03, 0.0),
      tyre: new THREE.CylinderGeometry(P.wheelR, P.wheelR, 0.24, 18),
      rim: new THREE.CylinderGeometry(P.wheelR * 0.62, P.wheelR * 0.62, 0.25, 10),
      light: new THREE.BoxGeometry(0.34, 0.11, 0.05),
      plate: new THREE.BoxGeometry(0.46, 0.13, 0.02),
      bumper: new THREE.BoxGeometry(P.w - 0.06, 0.16, 0.12),
      sign: new THREE.BoxGeometry(0.55, 0.16, 0.22),
    };
    out.tyre.rotateZ(Math.PI / 2);
    out.rim.rotateZ(Math.PI / 2);
    return (geoCache[type] = out);
  }

  // ---- merge helper: bake parts (geometry + local transform + colour) into
  // ONE non-indexed geometry with vertex colours, so a car costs a few
  // draws instead of ~20
  var _m4 = new THREE.Matrix4(), _n3 = new THREE.Matrix3(), _c = new THREE.Color();
  function bake(parts) {
    var pos = [], nor = [], col = [];
    for (var i = 0; i < parts.length; i++) {
      var pt = parts[i];
      var g = pt.geo.index ? pt.geo.toNonIndexed() : pt.geo;
      _m4.compose(pt.p || new THREE.Vector3(), pt.q || new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      _n3.getNormalMatrix(_m4);
      _c.setHex(pt.hex);
      var P = g.attributes.position, N = g.attributes.normal, v = new THREE.Vector3();
      for (var k = 0; k < P.count; k++) {
        v.fromBufferAttribute(P, k).applyMatrix4(_m4); pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(N, k).applyMatrix3(_n3).normalize(); nor.push(v.x, v.y, v.z);
        col.push(_c.r, _c.g, _c.b);
      }
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out.computeBoundingSphere();
    return out;
  }
  function at(x, y, z) { return new THREE.Vector3(x, y, z); }

  var bakedCache = {};
  // make(type, colour, opts) -> car record. opts.parked bakes the wheels in
  // too (a parked car is 3 draws: body, headlights, tail lights)
  function make(type, colour, opts) {
    opts = opts || {};
    type = PROFILES[type] ? type : 'sedan';
    var P = PROFILES[type], G = geos(type);
    var taxi = !!opts.taxi, parked = !!opts.parked || !!opts.shareTail;
    var paintHex = taxi ? 0xf2c21b : (colour != null ? colour : PAINT[0]);
    var half = P.len / 2;
    var hx = P.w / 2 - 0.3, hy = type === 'van' ? 0.95 : 0.7, ty = type === 'van' ? 0.95 : 0.76;
    var wheelPos = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(function (c) {
      return { x: c[0] * (P.w / 2 - 0.1), y: P.wheelR, z: c[1] * P.axle, front: c[1] > 0 };
    });

    var bodyM = mat('carBody', function () { return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.16 }); });
    var headM = mat('head', function () { return new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0xfff1c8, emissiveIntensity: 0.55, roughness: 0.2 }); });
    var wheelM = mat('wheel', function () { return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.25 }); });
    var tail = parked
      ? mat('tail', function () { return new THREE.MeshStandardMaterial({ color: 0x8a0f0f, emissive: 0xff1a1a, emissiveIntensity: 0.25, roughness: 0.3 }); })
      : new THREE.MeshStandardMaterial({ color: 0x8a0f0f, emissive: 0xff1a1a, emissiveIntensity: 0.25, roughness: 0.3 });

    // body geometry: shared per (type, paint, taxi, parked)
    var key = type + ':' + paintHex + ':' + (taxi ? 1 : 0) + ':' + (parked ? 1 : 0);
    var baked = bakedCache[key];
    if (!baked) {
      var parts = [
        { geo: G.body, hex: paintHex },
        { geo: G.glass, hex: 0x1b2833 },
        { geo: G.bumper, p: at(0, 0.38, half + 0.02), hex: 0x1d1f22 },
        { geo: G.bumper, p: at(0, 0.38, -half - 0.02), hex: 0x1d1f22 },
        { geo: G.plate, p: at(0, 0.5, half + 0.09), hex: 0xe9e6da },
        { geo: G.plate, p: at(0, 0.55, -half - 0.09), hex: 0xe9e6da },
      ];
      if (taxi) parts.push({ geo: G.sign, p: at(0, 1.48, -0.25), hex: 0xffe27a });
      if (parked) wheelPos.forEach(function (w) {
        parts.push({ geo: G.tyre, p: at(w.x, w.y, w.z), hex: 0x141416 });
        parts.push({ geo: G.rim, p: at(w.x, w.y, w.z), hex: 0xb9bec4 });
      });
      baked = bakedCache[key] = {
        body: bake(parts),
        head: bake([{ geo: G.light, p: at(-hx, hy, half + 0.01), hex: 0xffffff }, { geo: G.light, p: at(hx, hy, half + 0.01), hex: 0xffffff }]),
        tail: bake([{ geo: G.light, p: at(-hx, ty, -half - 0.01), hex: 0xffffff }, { geo: G.light, p: at(hx, ty, -half - 0.01), hex: 0xffffff }]),
      };
    }
    var wheelGeo = bakedCache['wheel:' + type] || (bakedCache['wheel:' + type] = bake([{ geo: G.tyre, hex: 0x141416 }, { geo: G.rim, hex: 0xb9bec4 }]));

    var group = new THREE.Group();
    var body = new THREE.Group();     // rolls / pitches on its springs
    group.add(body);
    var shell = new THREE.Mesh(baked.body, bodyM); shell.castShadow = true; shell.receiveShadow = true;
    body.add(shell, new THREE.Mesh(baked.head, headM), new THREE.Mesh(baked.tail, tail));
    var wheels = [];
    if (!parked) wheelPos.forEach(function (w) {
      var hub = new THREE.Group();     // steer pivot
      hub.position.set(w.x, w.y, w.z);
      var spin = new THREE.Mesh(wheelGeo, wheelM);
      spin.castShadow = true;
      hub.add(spin);
      group.add(hub);
      wheels.push({ hub: hub, spin: spin, front: w.front });
    });
    return { group: group, body: body, wheels: wheels, brake: tail, length: P.len, width: P.w, wheelR: P.wheelR, type: type };
  }

  // a deterministic mixed fleet: realistic paint, the odd taxi and van
  function fleet(i) {
    var types = ['sedan', 'hatch', 'sedan', 'van', 'hatch', 'sedan'];
    return { type: types[i % types.length], colour: PAINT[(i * 7 + 3) % PAINT.length], taxi: i % 5 === 2 };
  }

  // night: headlights + taxi signs glow brighter (shared materials)
  var night = null;
  function setNight(on) {
    on = !!on;
    if (night === on) return;
    night = on;
    if (matCache.head) matCache.head.emissiveIntensity = on ? 2.2 : 0.55;
    if (matCache.sign) matCache.sign.emissiveIntensity = on ? 1.4 : 0.4;
  }

  return { make: make, fleet: fleet, setNight: setNight, PAINT: PAINT, PROFILES: PROFILES };
})();
