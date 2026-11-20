// ============================================================
// BATCH (Build 7) — merge the static street into a few draw calls.
// The arena is ~550 separate meshes (buildings, windows, fences,
// posts, kerbs, benches…), so a phone paid ~550 draw calls and ~300
// shadow-map draws every frame for things that never move. This walks
// a built group once, buckets every static mesh by (material, shadow
// flags, attribute layout), bakes each bucket into ONE mesh in the
// group's space, and hides the originals (kept in place, so code that
// looks things up by index or toggles materials still works — the
// merged mesh shares the very same material object).
// Skipped: skinned / instanced meshes, multi-material meshes,
// transparent materials, anything under an excluded subtree, anything
// with userData.dynamic, and buckets of one.
// ============================================================
var LG = window.LG = window.LG || {};

LG.Batch = (function () {
  function attrSig(g) {
    var names = Object.keys(g.attributes).filter(function (n) { return n === 'position' || n === 'normal' || n === 'uv' || n === 'color'; }).sort();
    return names.map(function (n) { return n + g.attributes[n].itemSize; }).join(',');
  }

  function mergeStatic(root, exclude) {
    if (!root || !window.THREE) return { before: 0, after: 0 };
    exclude = exclude || [];
    var skip = new Set();
    exclude.forEach(function (o) { if (o) o.traverse(function (c) { skip.add(c); }); });
    root.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    var buckets = {}, before = 0;
    root.traverse(function (o) {
      if (!o.isMesh) return;
      before++;
      if (skip.has(o) || o.isSkinnedMesh || o.isInstancedMesh || !o.visible || (o.userData && o.userData.dynamic)) return;
      var m = o.material;
      if (!m || Array.isArray(m) || m.transparent || !o.geometry || !o.geometry.attributes.position) return;
      // a hidden ancestor means the mesh is not drawn now — leave it alone
      for (var p = o.parent; p && p !== root; p = p.parent) if (!p.visible) return;
      var key = m.uuid + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0) + '|' + attrSig(o.geometry);
      (buckets[key] = buckets[key] || []).push(o);
    });
    var after = before, merged = 0;
    var tmp = new THREE.Matrix4();
    Object.keys(buckets).forEach(function (key) {
      var list = buckets[key];
      if (list.length < 2) return;
      var names = attrSig(list[0].geometry).split(',').map(function (s) { return s.replace(/[0-9]+$/, ''); });
      var total = 0, parts = [];
      for (var i = 0; i < list.length; i++) {
        var g = list[i].geometry.index ? list[i].geometry.toNonIndexed() : list[i].geometry.clone();
        tmp.multiplyMatrices(inv, list[i].matrixWorld);
        g.applyMatrix4(tmp);
        parts.push(g);
        total += g.attributes.position.count;
      }
      var out = new THREE.BufferGeometry();
      names.forEach(function (n) {
        var size = parts[0].attributes[n].itemSize, arr = new Float32Array(total * size), off = 0;
        for (var j = 0; j < parts.length; j++) {
          var a = parts[j].attributes[n];
          arr.set(a.array.length === a.count * size ? a.array : Float32Array.from(a.array).slice(0, a.count * size), off);
          off += a.count * size;
        }
        out.setAttribute(n, new THREE.BufferAttribute(arr, size));
      });
      parts.forEach(function (g) { g.dispose(); });
      out.computeBoundingSphere();
      var mesh = new THREE.Mesh(out, list[0].material);
      mesh.castShadow = list[0].castShadow;
      mesh.receiveShadow = list[0].receiveShadow;
      mesh.name = 'batched';
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
      for (var k = 0; k < list.length; k++) list[k].visible = false;
      after -= list.length - 1;
      merged += list.length;
    });
    return { before: before, after: after, merged: merged };
  }

  // Second pass: plain coloured materials (no texture, no glow) that only
  // differ by colour become ONE material with the colour baked into the
  // vertices. 100 one-off MeshStandardMaterials -> a handful of draws.
  function mergeByColor(root, exclude) {
    if (!root || !window.THREE) return { merged: 0 };
    var skip = new Set();
    (exclude || []).forEach(function (o) { if (o) o.traverse(function (c) { skip.add(c); }); });
    root.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    var buckets = {};
    root.traverse(function (o) {
      if (!o.isMesh || skip.has(o) || o.isSkinnedMesh || o.isInstancedMesh || !o.visible || (o.userData && o.userData.dynamic)) return;
      for (var p = o.parent; p && p !== root; p = p.parent) if (!p.visible) return;
      var m = o.material;
      if (!m || Array.isArray(m) || m.transparent || m.map || m.vertexColors || m.alphaMap || m.normalMap) return;
      if (!(m.isMeshStandardMaterial || m.isMeshLambertMaterial)) return;
      if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.001) return;   // glow is driven per material
      if (!o.geometry || !o.geometry.attributes.normal) return;
      var key = m.type + '|' + (m.isMeshStandardMaterial ? (Math.round(m.roughness * 10) + '/' + Math.round(m.metalness * 10)) : '') + '|' + m.side + '|' +
        (m.flatShading ? 1 : 0) + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0);
      (buckets[key] = buckets[key] || []).push(o);
    });
    var merged = 0, tmp = new THREE.Matrix4();
    Object.keys(buckets).forEach(function (key) {
      var list = buckets[key];
      if (list.length < 3) return;
      var total = 0, parts = [];
      for (var i = 0; i < list.length; i++) {
        var g = list[i].geometry.index ? list[i].geometry.toNonIndexed() : list[i].geometry.clone();
        tmp.multiplyMatrices(inv, list[i].matrixWorld);
        g.applyMatrix4(tmp);
        parts.push({ g: g, c: list[i].material.color });
        total += g.attributes.position.count;
      }
      var pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3), off = 0;
      parts.forEach(function (pt) {
        var n = pt.g.attributes.position.count;
        pos.set(pt.g.attributes.position.array.subarray(0, n * 3), off * 3);
        nor.set(pt.g.attributes.normal.array.subarray(0, n * 3), off * 3);
        for (var v = 0; v < n; v++) { col[(off + v) * 3] = pt.c.r; col[(off + v) * 3 + 1] = pt.c.g; col[(off + v) * 3 + 2] = pt.c.b; }
        off += n;
        pt.g.dispose();
      });
      var out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      out.setAttribute('color', new THREE.BufferAttribute(col, 3));
      out.computeBoundingSphere();
      var src = list[0].material;
      var mat = src.clone();
      mat.color.setRGB(1, 1, 1);
      mat.vertexColors = true;
      mat.userData = { batched: true, noWet: true };
      var mesh = new THREE.Mesh(out, mat);
      mesh.castShadow = list[0].castShadow; mesh.receiveShadow = list[0].receiveShadow;
      mesh.name = 'batchedColour'; mesh.matrixAutoUpdate = false;
      root.add(mesh);
      list.forEach(function (o) { o.visible = false; });
      merged += list.length;
    });
    return { merged: merged };
  }

  return { mergeStatic: mergeStatic, mergeByColor: mergeByColor };
})();
