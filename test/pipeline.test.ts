/**
 * Проверка геометрического конвейера без браузера.
 * Запуск: npm test
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { BoxGeometry, BufferGeometry, CapsuleGeometry, SphereGeometry, TorusGeometry } from 'three';
import { computeMeshVolume } from 'three-bvh-csg';
import {
  analyzeSection,
  buildRayGrid,
  cellIndexAt,
  findBestSplit,
  isSolidAt,
  type SplitRequirements,
} from '../src/core/analysis';
import { partToStl } from '../src/core/export';
import { normalizeModel, sanitizeGeometry } from '../src/core/import';
import {
  cavityDepthBelow,
  cavityOuterRadius,
  getMechanism,
  requiredDepthAbove,
} from '../src/core/mechanisms';
import { generateClicker } from '../src/core/split';
import type { ClickerOptions, Mechanism } from '../src/core/types';

const OUT_DIR = new URL('../.test-output/', import.meta.url).pathname;

let failures = 0;

function check(condition: boolean, label: string, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function baseOptions(mechanism: Mechanism): ClickerOptions {
  return {
    axis: 'z',
    splitAt: 0.4,
    mechanism,
    clearance: 0.3,
    floor: 1.6,
    centerOffset: { u: 0, v: 0 },
    pins: { enabled: true, count: 3, diameter: 3, height: 4, fit: 0.25 },
    magnets: { enabled: false, count: 2, diameter: 5, height: 2 },
    plungerMode: 'blind',
    membrane: 1.2,
    makeButton: false,
    printLayout: false,
  };
}

/** Те же требования к сечению, что считает интерфейс. */
function requirementsFor(options: ClickerOptions): SplitRequirements {
  const m = options.mechanism;
  const footprintRadius = cavityOuterRadius(m, options.clearance);
  return {
    radius: footprintRadius + m.minWall,
    footprintRadius,
    depthBelow: cavityDepthBelow(m, options.clearance) + options.floor,
    depthAbove: requiredDepthAbove(m, options.clearance, options.plungerMode, options.membrane),
  };
}

function triangleCount(geometry: BufferGeometry): number {
  return (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
}

async function runCase(
  name: string,
  raw: BufferGeometry,
  scale: number,
  overrides: Partial<ClickerOptions> = {},
): Promise<void> {
  console.log(`\n▸ ${name}`);

  const source = normalizeModel(sanitizeGeometry(raw), scale);
  const sourceVolume = computeMeshVolume(source);

  const grid = buildRayGrid(source, overrides.axis ?? 'z', 128);
  const mechanism = overrides.mechanism ?? getMechanism('dog-clicker');
  const options = { ...baseOptions(mechanism), ...overrides };

  // Автоподбор реза должен находить сечение, вмещающее механизм.
  const auto = findBestSplit(grid, requirementsFor(options));
  check(auto !== null, 'автоподбор реза вернул положение', auto === null ? '' : `${(auto * 100).toFixed(0)}%`);
  if (auto !== null) options.splitAt = auto;

  const section = analyzeSection(grid, grid.wMin + (grid.wMax - grid.wMin) * options.splitAt);
  check(section.inscribedRadius > 0, 'сечение реза непустое', `R=${section.inscribedRadius.toFixed(1)} мм`);

  const result = await generateClicker(source, grid, options);

  check(result.parts.length >= 2, 'получены обе половины', `деталей: ${result.parts.length}`);
  check(
    result.report.pinPositions.length >= 2,
    'штифты совмещения расставлены',
    `${result.report.pinPositions.length} шт.${result.report.pinRing ? ` на R≈${result.report.pinRing.toFixed(1)} мм` : ''}`,
  );

  let totalVolume = 0;
  for (const part of result.parts) {
    const triangles = triangleCount(part.geometry);
    check(triangles > 20, `деталь «${part.id}» непустая`, `${Math.round(triangles)} треугольников`);
    check(part.volume > 0, `объём «${part.id}» положительный`, `${(part.volume / 1000).toFixed(2)} см³`);
    totalVolume += part.volume;

    const stl = partToStl(part);
    const expected = 84 + Math.round(triangles) * 50;
    check(stl.byteLength === expected, `STL «${part.id}» корректного размера`, `${stl.byteLength} Б`);
    writeFileSync(`${OUT_DIR}${name.replace(/[^\wа-яё-]+/gi, '_')}-${part.id}.stl`, Buffer.from(stl));
  }

  // Половины вместе должны быть легче исходника: из них вычтен карман.
  const shellVolume = result.parts
    .filter((p) => p.id !== 'button')
    .reduce((sum, p) => sum + p.volume, 0);
  check(
    shellVolume < sourceVolume,
    'из модели вырезан материал под механизм',
    `${(sourceVolume / 1000).toFixed(1)} → ${(shellVolume / 1000).toFixed(1)} см³`,
  );
  check(
    shellVolume > sourceVolume * 0.5,
    'вырезано не слишком много',
    `осталось ${((shellVolume / sourceVolume) * 100).toFixed(0)}%`,
  );
  check(totalVolume > 0, 'суммарный объём положителен');

  for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
}

/**
 * Проверяет не размеры файлов, а саму геометрию: перетрассирует готовые детали
 * и смотрит, где в них есть материал, а где его быть не должно.
 */
async function verifyGeometry(): Promise<void> {
  console.log('\n▸ Проверка геометрии результата');

  const source = normalizeModel(sanitizeGeometry(new SphereGeometry(28, 64, 48)), 1);
  const grid = buildRayGrid(source, 'z', 128);
  const options: ClickerOptions = {
    ...baseOptions(getMechanism('snap-dome')),
    splitAt: 0.5,
    printLayout: false,
  };

  const result = await generateClicker(source, grid, options);
  const bottom = result.parts.find((p) => p.id === 'bottom')!;
  const top = result.parts.find((p) => p.id === 'top')!;

  const wSplit = result.report.splitCoord;
  const center = result.report.cavityCenter;
  const cavityMid = wSplit - cavityDepthBelow(options.mechanism, options.clearance) / 2;

  const bottomGrid = buildRayGrid(bottom.geometry, 'z', 128);
  const topGrid = buildRayGrid(top.geometry, 'z', 128);

  const solidIn = (g: typeof grid, u: number, v: number, w: number): boolean => {
    const index = cellIndexAt(g, u, v);
    return index >= 0 && isSolidAt(g, index, w);
  };

  check(solidIn(grid, center.u, center.v, cavityMid), 'в исходной модели на месте кармана был материал');
  check(!solidIn(bottomGrid, center.u, center.v, cavityMid), 'карман под механизм вырезан насквозь');

  const cavityRadius = (options.mechanism.cavity.diameter! + options.clearance * 2) / 2;
  check(
    solidIn(bottomGrid, center.u + cavityRadius + 3, center.v, cavityMid),
    'стенка вокруг кармана осталась на месте',
  );
  const cavityBottom = wSplit - cavityDepthBelow(options.mechanism, options.clearance);
  check(solidIn(bottomGrid, center.u, center.v, cavityBottom - 0.5), 'под карманом осталось дно');

  const pins = result.report.pinPositions;
  check(pins.length >= 2, 'штифты размещены', `${pins.length} шт.`);

  const pinTop = wSplit + options.pins.height * 0.6;
  const allPinsStand = pins.every((p) => solidIn(bottomGrid, p.u, p.v, pinTop));
  check(allPinsStand, 'все штифты торчат над плоскостью реза в корпусе');

  const allHolesDrilled = pins.every((p) => !solidIn(topGrid, p.u, p.v, wSplit + 0.6));
  check(allHolesDrilled, 'в крышке под каждым штифтом есть отверстие');

  // Щупаем по касательной: радиально можно промахнуться мимо самой модели.
  const holeWall = pins.every((p) => {
    const du = p.u - center.u;
    const dv = p.v - center.v;
    const length = Math.hypot(du, dv) || 1;
    const offset = options.pins.diameter / 2 + options.pins.fit + 1;
    const tu = (-dv / length) * offset;
    const tv = (du / length) * offset;
    return (
      solidIn(topGrid, p.u + tu, p.v + tv, wSplit + 0.6) &&
      solidIn(topGrid, p.u - tu, p.v - tv, wSplit + 0.6)
    );
  });
  check(holeWall, 'вокруг отверстий в крышке остался материал');

  const socket = solidIn(topGrid, center.u, center.v, wSplit + 0.4);
  check(!socket, 'канал толкателя в крышке прорезан');

  // Половины должны стыковаться ровно по плоскости реза,
  // а корпус — выступать над ней ровно на высоту штифтов.
  const bottomBox = bottom.geometry.boundingBox!;
  const topBox = top.geometry.boundingBox!;
  check(
    Math.abs(topBox.min.z - wSplit) < 0.05,
    'крышка начинается на плоскости реза',
    `${topBox.min.z.toFixed(2)} vs ${wSplit.toFixed(2)}`,
  );
  check(
    Math.abs(bottomBox.max.z - (wSplit + options.pins.height)) < 0.05,
    'штифты выступают ровно на заданную высоту',
    `${(bottomBox.max.z - wSplit).toFixed(2)} мм при заданных ${options.pins.height} мм`,
  );

  // Раскладка для печати не должна менять геометрию — только матрицу экспорта.
  const layouted = await generateClicker(source, grid, { ...options, printLayout: true });
  check(
    layouted.parts.every((p) => p.printMatrix !== undefined),
    'для печати посчитаны матрицы разворота',
  );
  check(
    layouted.parts.every((p) => {
      const box = p.geometry.boundingBox!.clone().applyMatrix4(p.printMatrix!);
      return Math.abs(box.min.z) < 0.01;
    }),
    'все детали в раскладке лежат на столе (z = 0)',
  );
  check(
    layouted.parts.every((p, i) => {
      const before = result.parts[i].geometry.boundingBox!;
      const after = p.geometry.boundingBox!;
      return before.min.distanceTo(after.min) < 0.01 && before.max.distanceTo(after.max) < 0.01;
    }),
    'сама геометрия при раскладке осталась в координатах сборки',
  );
}

/** Кладёт исходную модель в STL — её использует браузерный смоук-тест. */
function writeSampleSource(): void {
  const geometry = normalizeModel(sanitizeGeometry(new CapsuleGeometry(16, 34, 8, 32)), 1);
  const stl = partToStl({
    id: 'sample',
    name: 'sample',
    fileName: 'sample.stl',
    geometry,
    volume: 0,
  });
  writeFileSync(`${OUT_DIR}sample-source.stl`, Buffer.from(stl));
}

/**
 * Клавиатурный свич держится защёлками за планку с квадратным вырезом.
 * Проверяем, что планка реально осталась: узкий вырез сверху, широкая
 * камера под ним, и между ними — кольцо материала.
 */
async function verifyPlateMount(): Promise<void> {
  console.log('\n▸ Посадка клавиатурного свича на планку');

  const mechanism = getMechanism('mx-switch');
  const plate = mechanism.plate!;

  // Модель должна быть достаточно крупной: свич MX сам по себе высокий.
  const source = normalizeModel(sanitizeGeometry(new BoxGeometry(44, 44, 40)), 1);
  const grid = buildRayGrid(source, 'z', 128);
  const options: ClickerOptions = {
    ...baseOptions(mechanism),
    plungerMode: 'through',
    makeButton: true,
    printLayout: false,
  };

  const auto = findBestSplit(grid, requirementsFor(options));
  check(auto !== null, 'нашлось сечение под свич MX', auto === null ? '' : `${(auto * 100).toFixed(0)}%`);
  if (auto !== null) options.splitAt = auto;

  const result = await generateClicker(source, grid, options);
  for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);

  const bottom = result.parts.find((p) => p.id === 'bottom')!;
  const top = result.parts.find((p) => p.id === 'top')!;
  const button = result.parts.find((p) => p.id === 'button');

  const wSplit = result.report.splitCoord;
  const center = result.report.cavityCenter;
  const bottomGrid = buildRayGrid(bottom.geometry, 'z', 128);
  const topGrid = buildRayGrid(top.geometry, 'z', 128);

  const solidIn = (g: typeof grid, u: number, v: number, w: number): boolean => {
    const index = cellIndexAt(g, u, v);
    return index >= 0 && isSolidAt(g, index, w);
  };

  // Точка между краем выреза (14/2 = 7) и краем камеры (15.6/2 = 7.8):
  // на уровне планки там обязан быть материал, ниже — пустота.
  const ledgeProbe = (plate.aperture / 2 + plate.housing / 2) / 2;
  const plateLevel = wSplit - plate.thickness / 2;
  const chamberLevel = wSplit - plate.thickness - plate.bodyDepth / 2;

  check(!solidIn(bottomGrid, center.u, center.v, plateLevel), 'вырез под защёлки прорезан насквозь');
  check(
    solidIn(bottomGrid, center.u + ledgeProbe, center.v, plateLevel),
    'планка под защёлки осталась',
    `проба на ${ledgeProbe.toFixed(1)} мм от центра`,
  );
  check(
    !solidIn(bottomGrid, center.u + ledgeProbe, center.v, chamberLevel),
    'под планкой камера шире выреза — защёлкам есть куда выйти',
  );
  check(
    solidIn(bottomGrid, center.u, center.v, wSplit - cavityDepthBelow(mechanism, options.clearance) - 0.5),
    'под свичем осталось дно',
  );

  // Верхняя часть корпуса свича уходит в крышку.
  const recessLevel = wSplit + plate.topHeight / 2;
  check(!solidIn(topGrid, center.u, center.v, recessLevel), 'в крышке выбрано место под верх свича');
  check(
    !solidIn(topGrid, center.u + plate.housing / 2 - 1, center.v, recessLevel),
    'выборка в крышке шире корпуса свича',
  );
  check(
    solidIn(topGrid, center.u + plate.housing / 2 + 2, center.v, recessLevel),
    'вокруг выборки в крышке остался материал',
  );

  check(button !== undefined, 'толкатель сгенерирован отдельной деталью');
  if (button) {
    const height = button.geometry.boundingBox!.max.z - button.geometry.boundingBox!.min.z;
    check(height > plate.topHeight, 'толкатель достаёт до штока свича', `длина ${height.toFixed(1)} мм`);
  }

  for (const part of result.parts) {
    writeFileSync(`${OUT_DIR}mx-${part.id}.stl`, Buffer.from(partToStl(part)));
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  writeSampleSource();

  await runCase('Шар', new SphereGeometry(25, 48, 32), 1);
  await runCase('Капсула', new CapsuleGeometry(16, 34, 8, 32), 1);
  await runCase('Коробка', new BoxGeometry(44, 32, 55), 1);

  // Мелкая модель: механизм не помещается, генератор обязан предупредить, а не упасть.
  console.log('\n▸ Мелкий шар (ожидаем предупреждения)');
  const small = normalizeModel(sanitizeGeometry(new SphereGeometry(6, 32, 24)), 1);
  const smallGrid = buildRayGrid(small, 'z', 128);
  const smallResult = await generateClicker(small, smallGrid, baseOptions(getMechanism('tact-12')));
  check(smallResult.warnings.length > 0, 'выдано предупреждение о нехватке места');
  check(smallResult.parts.length === 2, 'детали всё равно построены');

  // Тор: сечение — кольцо, места под механизм нет вовсе.
  console.log('\n▸ Тор (сложное сечение)');
  const torus = normalizeModel(sanitizeGeometry(new TorusGeometry(30, 9, 24, 64)), 1);
  const torusGrid = buildRayGrid(torus, 'z', 128);
  const torusResult = await generateClicker(torus, torusGrid, baseOptions(getMechanism('snap-dome')));
  check(torusResult.parts.length === 2, 'тор разрезан без падения');
  check(torusResult.warnings.length > 0, 'тор помечен предупреждением');

  // Сквозной канал + печатная кнопка + раскладка для печати.
  await runCase('Капсула с кнопкой', new CapsuleGeometry(16, 34, 8, 32), 1, {
    plungerMode: 'through',
    makeButton: true,
    printLayout: true,
    mechanism: getMechanism('microswitch'),
  });

  // Рез по другой оси.
  await runCase('Шар по оси X', new SphereGeometry(25, 48, 32), 1, { axis: 'x' });

  await verifyGeometry();
  await verifyPlateMount();

  console.log(
    failures === 0 ? '\n✅ Все проверки пройдены' : `\n❌ Проверок не пройдено: ${failures}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
