import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Object3D,
} from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const SUPPORTED_EXTENSIONS = ['stl', 'obj', 'ply', '3mf', 'glb', 'gltf'] as const;

export interface LoadedModel {
  geometry: BufferGeometry;
  fileName: string;
  triangles: number;
}

/**
 * Оставляет в геометрии только position и normal: CSG работает
 * с фиксированным набором атрибутов, лишние (uv, color, skin*) ему мешают.
 */
export function sanitizeGeometry(input: BufferGeometry): BufferGeometry {
  const geometry = input.index ? input.toNonIndexed() : input.clone();

  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
  }
  geometry.clearGroups();
  geometry.morphAttributes = {};

  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  // Нормали могут прийти как non-float или с неверным itemSize — пересчитываем.
  const normal = geometry.getAttribute('normal');
  if (normal.itemSize !== 3 || !(normal.array instanceof Float32Array)) {
    geometry.deleteAttribute('normal');
    geometry.computeVertexNormals();
  }

  const position = geometry.getAttribute('position');
  if (!(position.array instanceof Float32Array)) {
    geometry.setAttribute('position', new Float32BufferAttribute(Array.from(position.array), 3));
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Собирает все меши иерархии в одну геометрию с применёнными трансформациями. */
function flatten(root: Object3D): BufferGeometry {
  root.updateMatrixWorld(true);

  const pieces: BufferGeometry[] = [];
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = sanitizeGeometry(mesh.geometry as BufferGeometry);
    g.applyMatrix4(mesh.matrixWorld);
    pieces.push(g);
  });

  if (pieces.length === 0) throw new Error('В файле не найдено ни одной полигональной сетки');
  if (pieces.length === 1) return pieces[0];

  const merged = mergeGeometries(pieces, false);
  if (!merged) throw new Error('Не удалось объединить сетки модели');
  pieces.forEach((p) => p.dispose());
  return sanitizeGeometry(merged);
}

function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

/** Загружает модель из файла, выбранного пользователем. */
export async function loadModelFile(file: File): Promise<LoadedModel> {
  const ext = extensionOf(file.name);
  const buffer = await file.arrayBuffer();

  let geometry: BufferGeometry;

  switch (ext) {
    case 'stl':
      geometry = sanitizeGeometry(new STLLoader().parse(buffer));
      break;

    case 'ply':
      geometry = sanitizeGeometry(new PLYLoader().parse(buffer));
      break;

    case 'obj':
      geometry = flatten(new OBJLoader().parse(new TextDecoder().decode(buffer)));
      break;

    case '3mf':
      geometry = flatten(new ThreeMFLoader().parse(buffer));
      break;

    case 'glb':
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(
        ext === 'gltf' ? new TextDecoder().decode(buffer) : buffer,
        '',
      );
      geometry = flatten(gltf.scene);
      break;
    }

    default:
      throw new Error(
        `Формат «${ext || 'без расширения'}» не поддерживается. Доступны: ${SUPPORTED_EXTENSIONS.join(', ').toUpperCase()}`,
      );
  }

  const triangles = geometry.getAttribute('position').count / 3;
  if (triangles < 4) throw new Error('Модель пустая или содержит слишком мало полигонов');

  return { geometry, fileName: file.name, triangles: Math.floor(triangles) };
}

/**
 * Ставит модель в рабочую систему координат: центр по X/Y, низ на Z = 0,
 * с учётом заданного масштаба. Возвращает новую геометрию.
 */
export function normalizeModel(source: BufferGeometry, scale: number): BufferGeometry {
  const geometry = source.clone();
  if (scale !== 1) geometry.scale(scale, scale, scale);

  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  geometry.translate(
    -(box.min.x + box.max.x) / 2,
    -(box.min.y + box.max.y) / 2,
    -box.min.z,
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
