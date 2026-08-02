/**
 * Печатает срез детали из STL прямо в терминал — быстрый способ убедиться,
 * что полость получилась той формы, что задумана.
 *
 * npm run slice -- файл.stl [высота среза, мм] [ширина окна, мм] [центр U] [центр V]
 */
import { Vector3 } from 'three';
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
const size = box.getSize(new Vector3());

const level = box.min.z + Number(process.argv[3] ?? 1);
// По умолчанию показываем деталь целиком, а не окошко у начала координат.
const width = Number(process.argv[4] ?? Math.max(size.x, size.y) * 1.02);
const centerU = Number(process.argv[5] ?? (box.min.x + box.max.x) / 2);
const centerV = Number(process.argv[6] ?? (box.min.y + box.max.y) / 2);

const COLUMNS = 78;
const step = width / COLUMNS;
const grid = buildRayGrid(geometry, 'z', 260);

console.log(
  `Срез на ${(level - box.min.z).toFixed(2)} мм от низа детали, окно ${width.toFixed(1)} мм ` +
    '(█ пластик, · пустота)\n',
);

// Шаг по вертикали вдвое крупнее: знакоместо в терминале выше, чем шире.
for (let v = centerV + width / 2; v >= centerV - width / 2; v -= step * 2) {
  let line = '';
  for (let u = centerU - width / 2; u <= centerU + width / 2; u += step) {
    const index = cellIndexAt(grid, u, v);
    line += index >= 0 && isSolidAt(grid, index, level) ? '█' : '·';
  }
  console.log(line);
}
