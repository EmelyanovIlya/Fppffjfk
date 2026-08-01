import { Box3, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Axis } from './types';

/** Индексы координат: w — вдоль оси реза, u/v — в плоскости сечения. */
export function axisIndices(axis: Axis): { u: 0 | 1 | 2; v: 0 | 1 | 2; w: 0 | 1 | 2 } {
  switch (axis) {
    case 'x':
      return { w: 0, u: 1, v: 2 };
    case 'y':
      return { w: 1, u: 0, v: 2 };
    case 'z':
      return { w: 2, u: 0, v: 1 };
  }
}

/** Собирает мировой вектор из координат сечения. */
export function makeVector(axis: Axis, u: number, v: number, w: number, target = new Vector3()): Vector3 {
  const idx = axisIndices(axis);
  const out: [number, number, number] = [0, 0, 0];
  out[idx.u] = u;
  out[idx.v] = v;
  out[idx.w] = w;
  return target.set(out[0], out[1], out[2]);
}

/**
 * Растровая карта модели: из каждой ячейки сетки (u, v) пускается луч вдоль
 * оси реза и запоминаются все пересечения с поверхностью. Дальше любое сечение
 * получается из этих пересечений по чётности — без повторной трассировки.
 */
export interface RayGrid {
  axis: Axis;
  /** Размер ячейки, мм. */
  cell: number;
  nu: number;
  nv: number;
  /** Координаты центра ячейки (0, 0). */
  originU: number;
  originV: number;
  wMin: number;
  wMax: number;
  /** Отсортированные координаты пересечений вдоль оси для каждой ячейки. */
  crossings: Float32Array[];
  box: Box3;
}

export function buildRayGrid(geometry: BufferGeometry, axis: Axis, resolution = 128): RayGrid {
  const bvh = new MeshBVH(geometry);
  const box = geometry.boundingBox ?? new Box3().setFromBufferAttribute(geometry.getAttribute('position') as never);

  const idx = axisIndices(axis);
  const min = box.min.toArray();
  const max = box.max.toArray();

  const extU = max[idx.u] - min[idx.u];
  const extV = max[idx.v] - min[idx.v];
  const cell = Math.max(extU, extV) / resolution;

  const nu = Math.max(2, Math.ceil(extU / cell) + 1);
  const nv = Math.max(2, Math.ceil(extV / cell) + 1);
  const originU = min[idx.u] + (extU - (nu - 1) * cell) / 2;
  const originV = min[idx.v] + (extV - (nv - 1) * cell) / 2;

  const wMin = min[idx.w];
  const wMax = max[idx.w];
  const start = wMin - Math.max(1, (wMax - wMin) * 0.01);

  const direction = makeVector(axis, 0, 0, 1);
  const origin = new Vector3();
  const ray = new Ray();
  const crossings: Float32Array[] = new Array(nu * nv);

  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      makeVector(axis, originU + iu * cell, originV + iv * cell, start, origin);
      ray.set(origin, direction);

      const hits = bvh.raycast(ray, DoubleSide);
      if (hits.length === 0) {
        crossings[iu + iv * nu] = EMPTY;
        continue;
      }

      const values = hits.map((hit) => start + hit.distance).sort((a, b) => a - b);
      // Совпадающие пересечения на рёбрах ломают проверку по чётности.
      const unique: number[] = [];
      for (const value of values) {
        if (unique.length === 0 || value - unique[unique.length - 1] > 1e-5) unique.push(value);
      }
      crossings[iu + iv * nu] = new Float32Array(unique);
    }
  }

  return { axis, cell, nu, nv, originU, originV, wMin, wMax, crossings, box };
}

const EMPTY = new Float32Array(0);

/** Внутри ли модели точка ячейки на высоте w (по чётности пересечений). */
export function isSolidAt(grid: RayGrid, index: number, w: number): boolean {
  const list = grid.crossings[index];
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] < w) count++;
    else break;
  }
  return (count & 1) === 1;
}

/** Толщина сплошного материала вниз от w до ближайшей поверхности. */
export function solidDepthBelow(grid: RayGrid, index: number, w: number): number {
  const list = grid.crossings[index];
  let below = grid.wMin;
  for (let i = 0; i < list.length; i++) {
    if (list[i] < w) below = list[i];
    else break;
  }
  return w - below;
}

/** Толщина сплошного материала вверх от w до ближайшей поверхности. */
export function solidDepthAbove(grid: RayGrid, index: number, w: number): number {
  const list = grid.crossings[index];
  for (let i = 0; i < list.length; i++) {
    if (list[i] > w) return list[i] - w;
  }
  return grid.wMax - w;
}

export function sectionMask(grid: RayGrid, w: number): Uint8Array {
  const mask = new Uint8Array(grid.nu * grid.nv);
  for (let i = 0; i < mask.length; i++) mask[i] = isSolidAt(grid, i, w) ? 1 : 0;
  return mask;
}

/**
 * Расстояние от каждой заполненной ячейки до ближайшей пустой, в мм.
 * Двухпроходный chamfer 3×3 — быстро и достаточно точно для поиска
 * места под механизм.
 */
export function distanceTransform(mask: Uint8Array, nu: number, nv: number, cell: number): Float32Array {
  const INF = 1e9;
  const dist = new Float32Array(nu * nv);
  const d1 = 1;
  const d2 = Math.SQRT2;

  for (let i = 0; i < dist.length; i++) dist[i] = mask[i] ? INF : 0;

  const at = (u: number, v: number) => (u < 0 || v < 0 || u >= nu || v >= nv ? 0 : dist[u + v * nu]);

  for (let v = 0; v < nv; v++) {
    for (let u = 0; u < nu; u++) {
      const i = u + v * nu;
      if (dist[i] === 0) continue;
      dist[i] = Math.min(
        dist[i],
        at(u - 1, v) + d1,
        at(u, v - 1) + d1,
        at(u - 1, v - 1) + d2,
        at(u + 1, v - 1) + d2,
      );
    }
  }

  for (let v = nv - 1; v >= 0; v--) {
    for (let u = nu - 1; u >= 0; u--) {
      const i = u + v * nu;
      if (dist[i] === 0) continue;
      dist[i] = Math.min(
        dist[i],
        at(u + 1, v) + d1,
        at(u, v + 1) + d1,
        at(u + 1, v + 1) + d2,
        at(u - 1, v + 1) + d2,
      );
    }
  }

  for (let i = 0; i < dist.length; i++) dist[i] = Math.min(dist[i], INF) * cell;
  return dist;
}

export interface SectionAnalysis {
  w: number;
  mask: Uint8Array;
  dist: Float32Array;
  /** Центр самой «толстой» области сечения. */
  center: { u: number; v: number; index: number };
  /** Радиус наибольшей окружности, вписанной в сечение, мм. */
  inscribedRadius: number;
  /** Площадь сечения, мм². */
  area: number;
}

export function analyzeSection(grid: RayGrid, w: number): SectionAnalysis {
  const mask = sectionMask(grid, w);
  const dist = distanceTransform(mask, grid.nu, grid.nv, grid.cell);

  let best = 0;
  let filled = 0;
  for (let i = 0; i < dist.length; i++) {
    if (mask[i]) filled++;
    if (dist[i] > best) best = dist[i];
  }

  // Одинаково удачных точек обычно целое плато: у вытянутого сечения это
  // отрезок вдоль длинной стороны. Брать из него первую попавшуюся нельзя —
  // механизм уедет к краю. Берём точку плато, ближайшую к его середине.
  const tolerance = Math.max(1e-6, grid.cell * 0.5);
  let sumU = 0;
  let sumV = 0;
  let count = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] < best - tolerance) continue;
    sumU += i % grid.nu;
    sumV += Math.floor(i / grid.nu);
    count++;
  }

  let bestIndex = 0;
  if (count > 0) {
    const midU = sumU / count;
    const midV = sumV / count;
    let closest = Infinity;
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] < best - tolerance) continue;
      const du = (i % grid.nu) - midU;
      const dv = Math.floor(i / grid.nu) - midV;
      const d = du * du + dv * dv;
      if (d < closest) {
        closest = d;
        bestIndex = i;
      }
    }
  }

  return {
    w,
    mask,
    dist,
    center: {
      u: grid.originU + (bestIndex % grid.nu) * grid.cell,
      v: grid.originV + Math.floor(bestIndex / grid.nu) * grid.cell,
      index: bestIndex,
    },
    inscribedRadius: best,
    area: filled * grid.cell * grid.cell,
  };
}

/**
 * Выбирает точку под механизм.
 *
 * Самая «толстая» точка сечения не годится сама по себе: над ней может не быть
 * материала — у модели здания это, например, двор между корпусами, и каналу
 * толкателя некуда идти. Поэтому среди точек, куда механизм влезает вширь,
 * берётся та, над которой больше всего материала, а при равенстве — та, где
 * запас по ширине больше.
 */
export function chooseCavityCenter(
  grid: RayGrid,
  section: SectionAnalysis,
  need: SplitRequirements,
): { u: number; v: number; index: number } {
  // Где над сечением достаточно материала на канал толкателя.
  const roofed = new Uint8Array(section.mask.length);
  for (let i = 0; i < roofed.length; i++) {
    roofed[i] = section.mask[i] && solidDepthAbove(grid, i, section.w) >= need.depthAbove ? 1 : 0;
  }

  // Мало попасть в массив краем: канал должен целиком уйти под него,
  // иначе он выйдет наружу сбоку. Меряем запас до границы этой области.
  const roofedDist = distanceTransform(roofed, grid.nu, grid.nv, grid.cell);

  const pick = (fits: (i: number) => boolean, score: (i: number) => number) => {
    let bestIndex = -1;
    let best = -Infinity;
    for (let i = 0; i < section.dist.length; i++) {
      if (!fits(i)) continue;
      const value = score(i);
      if (value > best) {
        best = value;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  const wide = (i: number) => section.dist[i] >= need.radius;
  const roofedEnough = (i: number) => roofedDist[i] >= need.channelRadius;

  // Идеальный вариант: механизм влезает вширь и канал целиком под массивом.
  let index = pick(
    (i) => wide(i) && roofedEnough(i),
    (i) => Math.min(section.dist[i] / need.radius, roofedDist[i] / need.channelRadius),
  );

  // Иначе — хотя бы влезает вширь, а канал ставим где материала над ним больше.
  if (index < 0) index = pick(wide, (i) => roofedDist[i]);

  // Совсем никак: оставляем середину самого широкого места.
  if (index < 0) return section.center;

  return {
    u: grid.originU + (index % grid.nu) * grid.cell,
    v: grid.originV + Math.floor(index / grid.nu) * grid.cell,
    index,
  };
}

/** Индекс ячейки по координатам сечения; -1, если вне сетки. */
export function cellIndexAt(grid: RayGrid, u: number, v: number): number {
  const iu = Math.round((u - grid.originU) / grid.cell);
  const iv = Math.round((v - grid.originV) / grid.cell);
  if (iu < 0 || iv < 0 || iu >= grid.nu || iv >= grid.nv) return -1;
  return iu + iv * grid.nu;
}

/** Свободный радиус вокруг точки — сколько материала вокруг неё в сечении. */
export function clearanceAt(grid: RayGrid, dist: Float32Array, u: number, v: number): number {
  const index = cellIndexAt(grid, u, v);
  return index < 0 ? 0 : dist[index];
}

/**
 * Наименьшая толщина материала под сечением в пределах пятна кармана —
 * именно она определяет, поместится ли механизм, а не толщина под центром.
 */
export function depthUnderFootprint(
  grid: RayGrid,
  w: number,
  center: { u: number; v: number },
  radius: number,
): number {
  let min = Infinity;
  const step = grid.cell;
  for (let du = -radius; du <= radius; du += step) {
    for (let dv = -radius; dv <= radius; dv += step) {
      if (du * du + dv * dv > radius * radius) continue;
      const index = cellIndexAt(grid, center.u + du, center.v + dv);
      if (index < 0) return 0;
      min = Math.min(min, solidDepthBelow(grid, index, w));
    }
  }
  return min === Infinity ? 0 : min;
}

export interface SplitRequirements {
  /** Радиус, который должно вмещать сечение реза. */
  radius: number;
  /** Радиус пятна кармана — в его пределах проверяется толщина материала. */
  footprintRadius: number;
  /** Нужная толщина материала под резом (карман + дно). */
  depthBelow: number;
  /** Нужная толщина материала над резом (канал толкателя + мембрана). */
  depthAbove: number;
  /** Радиус канала толкателя — он должен целиком уйти под материал. */
  channelRadius: number;
}

/** Результат подбора реза. */
export interface SplitChoice {
  /** Доля 0..1 вдоль оси. */
  fraction: number;
  /** Выполнены ли все требования механизма. */
  satisfied: boolean;
  /** Что именно не сошлось, если satisfied === false. */
  shortfall?: {
    /** Лучший найденный радиус сечения и лучшая толщина материала. */
    radius: number;
    depthBelow: number;
    depthAbove: number;
  };
}

/**
 * Подбирает положение реза: самое низкое сечение, в которое механизм
 * помещается со стенкой и вокруг которого хватает материала.
 *
 * Если подходящего сечения нет, возвращает самое широкое с пометкой
 * satisfied === false — молча отдавать заведомо негодный рез нельзя.
 */
export function findBestSplit(grid: RayGrid, need: SplitRequirements, samples = 40): SplitChoice | null {
  const height = grid.wMax - grid.wMin;
  let fallback:
    | { fraction: number; score: number; radius: number; depthBelow: number; depthAbove: number }
    | null = null;

  const ratio = (have: number, want: number) => (want > 0 ? have / want : 1);

  for (let i = 1; i < samples; i++) {
    const fraction = i / samples;
    const w = grid.wMin + height * fraction;
    const section = analyzeSection(grid, w);
    if (section.inscribedRadius <= 0) continue;

    const center = chooseCavityCenter(grid, section, need);
    const depthBelow = depthUnderFootprint(grid, w, center, need.footprintRadius);
    const depthAbove = solidDepthAbove(grid, center.index, w);

    // Запасной вариант выбираем по самому слабому из требований, а не по
    // ширине сечения: самое широкое место часто у самого дна, где под резом
    // нет материала, и подогнать масштаб оттуда получается только абсурдным.
    const score = Math.min(
      ratio(section.inscribedRadius, need.radius),
      ratio(depthBelow, need.depthBelow),
      ratio(depthAbove, need.depthAbove),
    );
    if (!fallback || score > fallback.score) {
      fallback = { fraction, score, radius: section.inscribedRadius, depthBelow, depthAbove };
    }

    if (section.inscribedRadius < need.radius) continue;
    if (depthBelow < need.depthBelow) continue;
    if (depthAbove < need.depthAbove) continue;
    return { fraction, satisfied: true };
  }

  if (!fallback) return null;
  return {
    fraction: fallback.fraction,
    satisfied: false,
    shortfall: {
      radius: fallback.radius,
      depthBelow: fallback.depthBelow,
      depthAbove: fallback.depthAbove,
    },
  };
}
