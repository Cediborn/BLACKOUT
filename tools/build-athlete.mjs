// ============================================================
// tools/build-athlete.mjs — builds 3d/athlete.glb from Quaternius's CC0
// Universal Animation Library 1 + 2 (mannequin body + chosen clips).
//
// Source packs (CC0 1.0, by Quaternius):
//   UAL1.glb  "Universal Animation Library" (Unreal-Godot export)
//   UAL2.glb  "Universal Animation Library 2" (Unreal-Godot export)
// Both share the same 65-bone humanoid skeleton (identical node names), so
// UAL2 clips are copied onto UAL1's skeleton by bone name.
//
//   npm i @gltf-transform/core@4 @gltf-transform/functions@4 @gltf-transform/extensions@4
//   node tools/build-athlete.mjs path/to/UAL1.glb path/to/UAL2.glb 3d/athlete.glb
// ============================================================
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, resample, quantize } from '@gltf-transform/functions';

const [, , SRC1, SRC2, OUT] = process.argv;
if (!SRC1 || !SRC2 || !OUT) { console.error('usage: node build-athlete.mjs UAL1.glb UAL2.glb out.glb'); process.exit(2); }

// game clip name  <-  [source pack, source clip]
const CLIPS = {
  idle:        [1, 'Idle_Loop'],
  idle_look:   [1, 'Idle_LookAround_Loop'],
  tired:       [1, 'Idle_Tired_Loop'],
  walk:        [1, 'Walk_Loop'],
  jog:         [1, 'Jog_Fwd_Loop'],
  jog_lean_l:  [1, 'Jog_Fwd_LeanL_Loop'],
  jog_lean_r:  [1, 'Jog_Fwd_LeanR_Loop'],
  jog_back:    [1, 'Jog_Bwd_Loop'],
  jog_left:    [1, 'Jog_Left_Loop'],
  jog_right:   [1, 'Jog_Right_Loop'],
  sprint:      [1, 'Sprint_Loop'],
  kick:        [1, 'Kick'],
  push:        [1, 'Push_Enter'],
  hit_chest:   [1, 'Hit_Chest'],
  hit_stomach: [1, 'Hit_Stomach'],
  dodge_l:     [1, 'Dodge_Left'],
  dodge_r:     [1, 'Dodge_Right'],
  jump_start:  [1, 'Jump_Start'],
  jump_land:   [1, 'Jump_Land'],
  roll:        [1, 'Roll'],
  celebrate:   [1, 'Celebration'],
  dance:       [1, 'Dance_Loop'],
  backflip:    [1, 'BackFlip'],
  crying:      [1, 'Crying'],
  slide_start: [2, 'Slide_Start'],
  slide_loop:  [2, 'Slide_Loop'],
  slide_exit:  [2, 'Slide_Exit'],
  knockback:   [2, 'Hit_Knockback'],
  lay:         [2, 'IdleToLay'],
  getup:       [2, 'LayToIdle'],
  kipup:       [2, 'KipUp'],
  yes:         [2, 'Yes'],
  surprise:    [2, 'Surprise'],
  no:          [2, 'Idle_No_Loop'],
  fold_arms:   [2, 'Idle_FoldArms_Loop'],
  turn_l:      [2, 'Turn180_L'],
  turn_r:      [2, 'Turn180_R'],
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC1);
const doc2 = await io.read(SRC2);
const root = doc.getRoot();
const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
const buffer = root.listBuffers()[0];

function findAnim(d, name) {
  return d.getRoot().listAnimations().find((a) => a.getName() === name) || null;
}

// copy a UAL2 animation onto UAL1's skeleton
function copyAnim(src, outName) {
  const a = doc.createAnimation(outName);
  for (const ch of src.listChannels()) {
    const target = ch.getTargetNode();
    const dst = target && byName.get(target.getName());
    if (!dst) continue;
    const s = ch.getSampler();
    const inp = doc.createAccessor().setType(s.getInput().getType()).setArray(s.getInput().getArray().slice()).setBuffer(buffer);
    const out = doc.createAccessor().setType(s.getOutput().getType()).setArray(s.getOutput().getArray().slice()).setBuffer(buffer);
    const smp = doc.createAnimationSampler().setInput(inp).setOutput(out).setInterpolation(s.getInterpolation());
    a.addSampler(smp);
    a.addChannel(doc.createAnimationChannel().setTargetNode(dst).setTargetPath(ch.getTargetPath()).setSampler(smp));
  }
  return a;
}

const keep = new Set();
for (const [game, [pack, srcName]] of Object.entries(CLIPS)) {
  if (pack === 1) {
    const a = findAnim(doc, srcName);
    if (!a) throw new Error('missing UAL1 clip ' + srcName);
    a.setName(game);
    keep.add(a);
  } else {
    const a2 = findAnim(doc2, srcName);
    if (!a2) throw new Error('missing UAL2 clip ' + srcName);
    keep.add(copyAnim(a2, game));
  }
}
function disposeAnim(a) {
  for (const s of a.listSamplers()) {
    const acc = [s.getInput(), s.getOutput()];
    s.dispose();
    for (const x of acc) if (x && !x.listParents().some((p) => p.propertyType !== 'Root')) x.dispose();
  }
  a.dispose();
}
for (const a of root.listAnimations()) if (!keep.has(a)) disposeAnim(a);

// drop scale tracks (the rig never scales) and translation tracks on every
// bone except the pelvis/root: the clips are in-place and those keys only
// add bytes
for (const a of root.listAnimations()) {
  for (const ch of a.listChannels()) {
    const n = ch.getTargetNode() && ch.getTargetNode().getName();
    const path = ch.getTargetPath();
    if (path === 'scale' || (path === 'translation' && n !== 'pelvis' && n !== 'root')) {
      const s = ch.getSampler();
      ch.dispose();
      if (s && !s.listParents().some((p) => p.propertyType === 'AnimationChannel')) {
        const acc = [s.getInput(), s.getOutput()];
        s.dispose();
        for (const x of acc) if (x && !x.listParents().some((p) => p.propertyType !== 'Root')) x.dispose();
      }
    }
  }
}

await doc.transform(
  resample({ tolerance: 1e-4 }),
  dedup(),
  prune(),
  quantize({ pattern: /^(POSITION|NORMAL|TEXCOORD_0)$/ }),
);
root.getAsset().generator = 'BLACKOUT build-athlete (glTF-Transform) from Quaternius UAL1+UAL2 (CC0)';
await io.write(OUT, doc);
const anims = root.listAnimations().map((a) => a.getName());
console.log('wrote ' + OUT + ' clips=' + anims.length + ': ' + anims.join(','));
