import { readFileSync } from 'node:fs';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { buildRayGrid, cellIndexAt, isSolidAt } from '../src/core/analysis';
import { sanitizeGeometry } from '../src/core/import';

const buf = readFileSync(process.argv[2]);
const geometry = sanitizeGeometry(
  new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer),
);
geometry.computeBoundingBox();
const box = geometry.boundingBox!;
const grid = buildRayGrid(geometry, 'z', 220);
const level = box.min.z + Number(process.argv[3] ?? 1.8);

console.log(`Срез на ${(level - box.min.z).toFixed(2)} мм от низа детали (█ пластик, · пустота)\n`);
const half = 4.2;
for (let v = half; v >= -half; v -= 0.3) {
  let line = '';
  for (let u = -half; u <= half; u += 0.15) {
    const i = cellIndexAt(grid, u, v);
    line += i >= 0 && isSolidAt(grid, i, level) ? '█' : '·';
  }
  console.log(line);
}
