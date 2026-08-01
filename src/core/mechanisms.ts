import type { Mechanism, PlateMount } from './types';

/**
 * Библиотека готовых механизмов щелчка.
 * Размеры взяты по типовым китайским/промышленным компонентам; перед печатью
 * стоит проверить штангенциркулем свою конкретную железку и при необходимости
 * поправить размеры в режиме «Свои размеры».
 */
export const MECHANISMS: Mechanism[] = [
  {
    id: 'mx-switch',
    name: 'Клавиатурный свич Cherry MX',
    hint:
      'Обычный свич от механической клавиатуры: Cherry MX и совместимые — Gateron, Kailh, Outemu. ' +
      'Для щелчка берите синие или зелёные (clicky). Свич защёлкивается в планку с вырезом 14×14 мм, ' +
      'его верхняя часть уходит в крышку, а на шток давит печатная кнопка.',
    cavity: { shape: 'plate', height: 0 },
    plate: {
      aperture: 14,
      thickness: 1.5,
      housing: 15.6,
      topHeight: 6.6,
      bodyDepth: 5,
      pinDepth: 4,
      stem: { length: 4.1, width: 1.4, height: 3.6, tube: 5.4, fit: 0.1 },
    },
    // Шток выступает над корпусом свича и утапливается на полный ход MX.
    plunger: { diameter: 8, travel: 4, engage: 3.5 },
    wireChannel: true,
    minWall: 2,
  },
  {
    id: 'dog-clicker',
    name: 'Пластина кликера (дрессировочный)',
    hint: 'Пружинная стальная пластина 20×12×0,3 мм из дрессировочного кликера. Самый громкий и «настоящий» щелчок.',
    cavity: { shape: 'box', width: 22, depth: 14, height: 5 },
    plunger: { diameter: 10, travel: 1.6, engage: 2 },
    wireChannel: false,
    minWall: 1.6,
  },
  {
    id: 'snap-dome',
    name: 'Металлический купол (snap dome) ⌀12',
    hint: 'Тактильный купол ⌀12×0,5 мм из пультов и клавиатур. Тихий чёткий щелчок, нужна ровная площадка под ним.',
    cavity: { shape: 'cylinder', diameter: 13, height: 3 },
    plunger: { diameter: 6, travel: 0.6, engage: 2 },
    wireChannel: false,
    minWall: 1.4,
  },
  {
    id: 'pen-click',
    name: 'Кнопочный механизм шариковой ручки',
    hint: 'Кулачковый узел из автоматической ручки: сам фиксируется в двух положениях. Щелчок при нажатии и при отпускании.',
    cavity: { shape: 'cylinder', diameter: 10.5, height: 22 },
    plunger: { diameter: 5.5, travel: 3, engage: 4 },
    wireChannel: false,
    minWall: 1.8,
  },
  {
    id: 'tact-12',
    name: 'Тактовая кнопка 12×12 мм',
    hint: 'Кнопка 12×12×7,3 мм с толкателем. Ставится на плату или на клей, выводы — в канал для проводов.',
    cavity: { shape: 'box', width: 12.6, depth: 12.6, height: 8 },
    plunger: { diameter: 7, travel: 0.5, engage: 3 },
    wireChannel: true,
    minWall: 1.6,
  },
  {
    id: 'tact-6',
    name: 'Тактовая кнопка 6×6 мм',
    hint: 'Мелкая кнопка 6×6×5 мм. Подходит для маленьких моделей, щелчок негромкий.',
    cavity: { shape: 'box', width: 6.6, depth: 6.6, height: 5.5 },
    plunger: { diameter: 3.5, travel: 0.4, engage: 2.5 },
    wireChannel: true,
    minWall: 1.2,
  },
  {
    id: 'microswitch',
    name: 'Микропереключатель мыши (D2FC / Kailh)',
    hint: 'Микрик 12,8×6,0×6,5 мм от компьютерной мыши. Громкий щелчок и большой ресурс.',
    cavity: { shape: 'box', width: 13.4, depth: 6.6, height: 7 },
    plunger: { diameter: 6, travel: 0.8, engage: 3 },
    wireChannel: true,
    minWall: 1.6,
  },
  {
    id: 'custom',
    name: 'Свои размеры',
    hint: 'Задайте габариты своего механизма вручную — карман и толкатель построятся по ним.',
    cavity: { shape: 'box', width: 15, depth: 15, height: 8 },
    plunger: { diameter: 7, travel: 1, engage: 3 },
    wireChannel: false,
    minWall: 1.6,
    editable: true,
  },
];

export function getMechanism(id: string): Mechanism {
  const found = MECHANISMS.find((m) => m.id === id);
  if (!found) throw new Error(`Неизвестный механизм: ${id}`);
  // Копия, чтобы правки размеров в интерфейсе не портили библиотеку.
  return structuredClone(found);
}

/**
 * Габариты кармана в плоскости реза (u, v) с учётом зазора.
 * Для цилиндра ширина и глубина равны диаметру.
 */
export function cavityFootprint(m: Mechanism, clearance: number): { u: number; v: number } {
  if (m.cavity.shape === 'cylinder') {
    const d = (m.cavity.diameter ?? 10) + clearance * 2;
    return { u: d, v: d };
  }
  if (m.cavity.shape === 'plate') {
    // Самое широкое место посадки — камера под корпус свича.
    const d = plateOf(m).housing + clearance * 2;
    return { u: d, v: d };
  }
  return {
    u: (m.cavity.width ?? 10) + clearance * 2,
    v: (m.cavity.depth ?? 10) + clearance * 2,
  };
}

export function plateOf(m: Mechanism): PlateMount {
  if (!m.plate) throw new Error(`У механизма «${m.name}» не заданы размеры планки`);
  return m.plate;
}

/**
 * Глубина выборки под плоскостью реза, без учёта дна.
 * У посадки на планку это планка + нижняя часть корпуса + место под выводы;
 * верхняя часть свича сюда не входит — она уходит в крышку.
 */
export function cavityDepthBelow(m: Mechanism, clearance: number): number {
  if (m.cavity.shape === 'plate') {
    const p = plateOf(m);
    return p.thickness + p.bodyDepth + p.pinDepth + clearance;
  }
  return m.cavity.height + clearance;
}

/**
 * Высота выборки в крышке под верхнюю часть механизма.
 * Ненулевая только у посадки на планку: у остальных механизмов над резом
 * идёт сразу канал толкателя.
 */
export function capRecessHeight(m: Mechanism, clearance: number): number {
  return m.cavity.shape === 'plate' ? plateOf(m).topHeight + clearance : 0;
}

/** Сколько материала нужно над резом, чтобы механизм и толкатель поместились. */
export function requiredDepthAbove(
  m: Mechanism,
  clearance: number,
  plungerMode: 'through' | 'blind' | 'none',
  membrane: number,
): number {
  const socket = m.plunger.engage + m.plunger.travel;
  const recess = capRecessHeight(m, clearance);
  if (plungerMode === 'blind') return recess + socket + membrane;
  if (plungerMode === 'none') return recess + m.minWall;
  return recess + Math.max(socket, m.minWall);
}

/**
 * Радиус описанной окружности кармана — минимальный радиус,
 * который сечение реза обязано вместить вместе со стенкой.
 */
export function cavityOuterRadius(m: Mechanism, clearance: number): number {
  const fp = cavityFootprint(m, clearance);
  if (m.cavity.shape === 'cylinder') return fp.u / 2;
  return Math.hypot(fp.u, fp.v) / 2;
}

/** Механизмы, которые сами держатся в корпусе, не нужно сажать на клей. */
export function isSelfRetaining(m: Mechanism): boolean {
  return m.cavity.shape === 'plate';
}

/**
 * Расстояние от точки сечения до стенки кармана: положительное снаружи,
 * отрицательное внутри. По нему штифты ставятся вплотную к длинной стороне
 * прямоугольного кармана, а не за его описанной окружностью.
 */
export function distanceToCavity(
  m: Mechanism,
  clearance: number,
  center: { u: number; v: number },
  u: number,
  v: number,
): number {
  const fp = cavityFootprint(m, clearance);
  const du = u - center.u;
  const dv = v - center.v;

  if (m.cavity.shape === 'cylinder') return Math.hypot(du, dv) - fp.u / 2;

  const ou = Math.abs(du) - fp.u / 2;
  const ov = Math.abs(dv) - fp.v / 2;
  if (ou > 0 && ov > 0) return Math.hypot(ou, ov);
  return Math.max(ou, ov);
}
