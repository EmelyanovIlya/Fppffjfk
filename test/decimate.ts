/**
 * Прореживание сетки склейкой вершин по сетке заданного шага.
 * npm run decimate -- вход.stl выход.stl [шаг, мм]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { computeMeshVolume } from 'three-bvh-csg';
import { sanitizeGeometry } from '../src/core/import';

const buf = readFileSync(process.argv[2]);
const source = sanitizeGeometry(
  new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer),
);
const step = Number(process.argv[4] ?? 0.15);
const pos = source.getAttribute('position');

// Каждая ячейка сетки схлопывается в одну вершину — среднюю по попавшим в неё.
const sums = new Map<string, { x: number; y: number; z: number; n: number; id: number }>();
const keys = new Int32Array(pos.count);
let next = 0;
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
  const key = `${Math.round(x / step)},${Math.round(y / step)},${Math.round(z / step)}`;
  let cell = sums.get(key);
  if (!cell) { cell = { x: 0, y: 0, z: 0, n: 0, id: next++ }; sums.set(key, cell); }
  cell.x += x; cell.y += y; cell.z += z; cell.n++;
  keys[i] = cell.id;
}
const verts = new Float32Array(next * 3);
for (const c of sums.values()) {
  verts[c.id * 3] = c.x / c.n; verts[c.id * 3 + 1] = c.y / c.n; verts[c.id * 3 + 2] = c.z / c.n;
}

// Треугольники, у которых две вершины схлопнулись в одну, вырождаются — убираем.
const out: number[] = [];
let dropped = 0;
for (let t = 0; t < pos.count / 3; t++) {
  const a = keys[t * 3], b = keys[t * 3 + 1], c = keys[t * 3 + 2];
  if (a === b || b === c || a === c) { dropped++; continue; }
  for (const v of [a, b, c]) out.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
}

const result = new BufferGeometry();
result.setAttribute('position', new Float32BufferAttribute(out, 3));
result.computeVertexNormals();
result.computeBoundingBox();

const before = Math.round(pos.count / 3), after = out.length / 9;
console.log(`шаг склейки: ${step} мм`);
console.log(`треугольников: ${before.toLocaleString('ru-RU')} → ${after.toLocaleString('ru-RU')} (${((after / before) * 100).toFixed(1)}%), вырожденных отброшено ${dropped.toLocaleString('ru-RU')}`);
console.log(`объём: ${(computeMeshVolume(source) / 1000).toFixed(2)} → ${(computeMeshVolume(result) / 1000).toFixed(2)} см³`);
const b0 = source.boundingBox!, b1 = result.boundingBox!;
console.log(`габарит: ${(b0.max.x-b0.min.x).toFixed(2)}×${(b0.max.y-b0.min.y).toFixed(2)}×${(b0.max.z-b0.min.z).toFixed(2)} → ${(b1.max.x-b1.min.x).toFixed(2)}×${(b1.max.y-b1.min.y).toFixed(2)}×${(b1.max.z-b1.min.z).toFixed(2)} мм`);

const mesh = new Mesh(result, new MeshBasicMaterial());
mesh.updateMatrixWorld();
const data = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView;
writeFileSync(process.argv[3], Buffer.from(data.buffer, data.byteOffset, data.byteLength));
