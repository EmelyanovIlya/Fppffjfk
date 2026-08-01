import { readFileSync } from 'node:fs';
import { computeMeshVolume } from 'three-bvh-csg';
import { buildRayGrid, analyzeSection, depthUnderFootprint, solidDepthAbove } from '../src/core/analysis';
import { normalizeModel } from '../src/core/import';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { Mesh, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sanitizeGeometry } from '../src/core/import';

const buf = readFileSync(process.argv[2]);
const scene = new ThreeMFLoader().parse(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
);
scene.updateMatrixWorld(true);
const pieces: BufferGeometry[] = [];
scene.traverse((c) => {
  const m = c as Mesh;
  if (!m.isMesh || !m.geometry) return;
  const g = sanitizeGeometry(m.geometry as BufferGeometry);
  g.applyMatrix4(m.matrixWorld);
  pieces.push(g);
});
console.log('мешей:', pieces.length);
const g = sanitizeGeometry(pieces.length === 1 ? pieces[0] : mergeGeometries(pieces, false)!);
const model = normalizeModel(g, 1);
const box = model.boundingBox!;
const tris = model.getAttribute('position').count / 3;
console.log('полигонов:', Math.round(tris).toLocaleString('ru-RU'));
console.log('габариты, мм:',
  (box.max.x - box.min.x).toFixed(1), '×', (box.max.y - box.min.y).toFixed(1), '×', (box.max.z - box.min.z).toFixed(1));
console.log('объём, см³:', (computeMeshVolume(model) / 1000).toFixed(1));
const bboxVol = (box.max.x-box.min.x)*(box.max.y-box.min.y)*(box.max.z-box.min.z);
console.log('заполненность габарита:', ((computeMeshVolume(model)/bboxVol)*100).toFixed(1) + '%');

const grid = buildRayGrid(model, 'z', 128);
console.log('\nвысота  R сечения  материал вниз  материал вверх');
for (const f of [0.02, 0.05, 0.08, 0.12, 0.16, 0.2, 0.3, 0.5]) {
  const w = grid.wMin + (grid.wMax - grid.wMin) * f;
  const s = analyzeSection(grid, w);
  const below = depthUnderFootprint(grid, w, s.center, 11.5);
  const above = solidDepthAbove(grid, s.center.index, w);
  console.log(
    `${w.toFixed(1).padStart(6)}  ${s.inscribedRadius.toFixed(1).padStart(9)}  ` +
    `${below.toFixed(1).padStart(13)}  ${above.toFixed(1).padStart(14)}`,
  );
}
