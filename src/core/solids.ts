import { BoxGeometry, BufferGeometry, CylinderGeometry } from 'three';
import { makeVector } from './analysis';
import type { Axis } from './types';

/** Разворачивает Y-ориентированный примитив вдоль заданной оси. */
function orientToAxis(geometry: BufferGeometry, axis: Axis): BufferGeometry {
  if (axis === 'z') geometry.rotateX(Math.PI / 2);
  else if (axis === 'x') geometry.rotateZ(-Math.PI / 2);
  return geometry;
}

function place(geometry: BufferGeometry, axis: Axis, u: number, v: number, w: number): BufferGeometry {
  const offset = makeVector(axis, u, v, w);
  geometry.translate(offset.x, offset.y, offset.z);
  return geometry;
}

/** Параллелепипед: sizeU × sizeV в плоскости сечения, sizeW вдоль оси. */
export function boxSolid(
  axis: Axis,
  sizeU: number,
  sizeV: number,
  sizeW: number,
  u: number,
  v: number,
  w: number,
): BufferGeometry {
  const geometry = orientToAxis(new BoxGeometry(sizeU, sizeW, sizeV), axis);
  return place(geometry, axis, u, v, w);
}

/** Цилиндр вдоль оси реза; radiusTop < radius даёт фаску для печати. */
export function cylinderSolid(
  axis: Axis,
  radius: number,
  height: number,
  u: number,
  v: number,
  w: number,
  options: { radiusTop?: number; segments?: number } = {},
): BufferGeometry {
  const { radiusTop = radius, segments = 40 } = options;
  const geometry = orientToAxis(new CylinderGeometry(radiusTop, radius, height, segments), axis);
  return place(geometry, axis, u, v, w);
}

/**
 * Полупространство в виде большой коробки — режущий инструмент.
 * `side` = -1 — всё ниже плоскости, +1 — всё выше.
 */
export function halfSpaceSolid(axis: Axis, w: number, side: -1 | 1, span: number): BufferGeometry {
  return boxSolid(axis, span * 4, span * 4, span * 2, 0, 0, w + side * span);
}
