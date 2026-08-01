import { Box3, BufferGeometry, Matrix4 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  ADDITION,
  Brush,
  Evaluator,
  INTERSECTION,
  SUBTRACTION,
  computeMeshVolume,
} from 'three-bvh-csg';
import {
  analyzeSection,
  cellIndexAt,
  chooseCavityCenter,
  clearanceAt,
  depthUnderFootprint,
  solidDepthAbove,
  type RayGrid,
  type SectionAnalysis,
} from './analysis';
import {
  capRecessHeight,
  cavityDepthBelow,
  channelRadius,
  requiredDepthAbove,
  cavityFootprint,
  cavityOuterRadius,
  distanceToCavity,
  plateOf,
} from './mechanisms';
import { boxSolid, cylinderSolid, halfSpaceSolid } from './solids';
import type { ClickerOptions, ClickerResult, GeneratedPart } from './types';

/** Перекрытие инструментов резки, чтобы не оставалось плёнок нулевой толщины. */
const OVERSHOOT = 0.05;
/** Ширина и высота канала для проводов. */
const WIRE_CHANNEL = { width: 3.2, height: 2.6 };

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = false;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Отдаёт управление браузеру между тяжёлыми шагами, чтобы не морозить вкладку. */
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function csg(a: Brush, b: BufferGeometry, operation: typeof SUBTRACTION): Brush {
  const tool = new Brush(b);
  tool.updateMatrixWorld();
  const result = evaluator.evaluate(a, tool, operation);
  // evaluate() возвращает новый Brush; исходники больше не нужны.
  tool.geometry.dispose();
  return result;
}

function isEmpty(geometry: BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  return !position || position.count < 3;
}

/** Позиция крепёжного элемента на кольце вокруг механизма. */
interface RingSlot {
  u: number;
  v: number;
}

/**
 * Расставляет крепёжные элементы вокруг механизма.
 *
 * Радиус подбирается для каждого элемента отдельно: у прямоугольного кармана
 * сбоку места меньше, чем с торца, и общее кольцо одного радиуса заставило бы
 * отказаться от штифтов там, где они на самом деле помещаются.
 */
function placeFeatures(
  grid: RayGrid,
  section: SectionAnalysis,
  center: { u: number; v: number },
  count: number,
  featureRadius: number,
  wall: number,
  needAbove: number,
  cavityClearance: (u: number, v: number) => number,
): RingSlot[] | null {
  const available = clearanceAt(grid, section.dist, center.u, center.v);
  const need = featureRadius + wall;
  if (available < need) return null;

  const step = Math.max(0.25, grid.cell);
  const angleSteps = 16;

  for (let a = 0; a < angleSteps; a++) {
    const offset = (a / angleSteps) * ((2 * Math.PI) / count);
    const slots: RingSlot[] = [];

    for (let i = 0; i < count; i++) {
      const theta = offset + (i / count) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);

      // От края сечения к центру: чем дальше элементы разнесены, тем точнее посадка.
      for (let radius = available; radius >= need; radius -= step) {
        const u = center.u + cos * radius;
        const v = center.v + sin * radius;

        // Не залезаем в карман механизма...
        if (cavityClearance(u, v) < need) continue;
        // ...не вылезаем за контур сечения...
        if (clearanceAt(grid, section.dist, u, v) < need) continue;
        // ...и в крышке над элементом есть куда углубить отверстие.
        const index = cellIndexAt(grid, u, v);
        if (index < 0 || solidDepthAbove(grid, index, section.w) < needAbove) continue;

        slots.push({ u, v });
        break;
      }

      if (slots.length !== i + 1) break;
    }

    if (slots.length === count) return slots;
  }

  return null;
}

/** Средний радиус расстановки — для отчёта и инструкции. */
function meanRadius(slots: RingSlot[], center: { u: number; v: number }): number {
  if (slots.length === 0) return 0;
  const sum = slots.reduce((acc, s) => acc + Math.hypot(s.u - center.u, s.v - center.v), 0);
  return sum / slots.length;
}

function mergeAll(pieces: BufferGeometry[]): BufferGeometry | null {
  if (pieces.length === 0) return null;
  if (pieces.length === 1) return pieces[0];
  const merged = mergeGeometries(pieces, false);
  pieces.forEach((p) => p.dispose());
  return merged;
}

/**
 * Считает разворот каждой детали плоскостью реза на стол и раскладывает их
 * в ряд. Геометрия не трогается: матрица применяется только при экспорте,
 * поэтому в 3D модель остаётся собранной и её можно осмотреть.
 */
function computePrintLayout(parts: GeneratedPart[], axis: ClickerOptions['axis']): void {
  const flipBottom = new Matrix4();
  const alignTop = new Matrix4();

  if (axis === 'z') {
    alignTop.identity();
    flipBottom.makeRotationX(Math.PI);
  } else if (axis === 'y') {
    alignTop.makeRotationX(Math.PI / 2);
    flipBottom.makeRotationX(-Math.PI / 2);
  } else {
    alignTop.makeRotationY(-Math.PI / 2);
    flipBottom.makeRotationY(Math.PI / 2);
  }

  const placed: { part: GeneratedPart; rotation: Matrix4; box: Box3 }[] = [];
  let width = 0;

  for (const part of parts) {
    const rotation = part.id === 'bottom' ? flipBottom : alignTop;
    part.geometry.computeBoundingBox();
    const box = part.geometry.boundingBox!.clone().applyMatrix4(rotation);
    placed.push({ part, rotation, box });
    width += box.max.x - box.min.x + 8;
  }

  let cursor = -width / 2;
  for (const { part, rotation, box } of placed) {
    const move = new Matrix4().makeTranslation(
      cursor - box.min.x,
      -(box.min.y + box.max.y) / 2,
      -box.min.z,
    );
    part.printMatrix = move.multiply(rotation);
    cursor += box.max.x - box.min.x + 8;
  }
}

export interface GenerateProgress {
  (stage: string): void;
}

/**
 * Превращает модель в кликер: режет её на две части, вырезает карман под
 * механизм щелчка, канал толкателя и добавляет штифты совмещения.
 */
export async function generateClicker(
  source: BufferGeometry,
  grid: RayGrid,
  options: ClickerOptions,
  onProgress: GenerateProgress = () => {},
): Promise<ClickerResult> {
  const warnings: string[] = [];
  const { axis, mechanism, clearance } = options;

  const span = Math.max(
    grid.box.max.x - grid.box.min.x,
    grid.box.max.y - grid.box.min.y,
    grid.box.max.z - grid.box.min.z,
  ) + 20;

  const wSplit = grid.wMin + (grid.wMax - grid.wMin) * clamp(options.splitAt, 0.02, 0.98);

  onProgress('Анализ сечения');
  await nextFrame();

  const section = analyzeSection(grid, wSplit);
  if (section.inscribedRadius <= 0) {
    throw new Error('Плоскость реза не пересекает модель — сдвиньте её ползунком «Положение реза».');
  }

  const footprint = cavityFootprint(mechanism, clearance);
  const outerRadius = cavityOuterRadius(mechanism, clearance);
  const requiredRadius = outerRadius + mechanism.minWall;

  const auto = chooseCavityCenter(grid, section, {
    radius: requiredRadius,
    footprintRadius: outerRadius,
    depthBelow: cavityDepthBelow(mechanism, clearance) + options.floor,
    depthAbove: requiredDepthAbove(mechanism, clearance, options.plungerMode, options.membrane),
    channelRadius: channelRadius(mechanism, clearance),
  });
  const center = {
    u: auto.u + options.centerOffset.u,
    v: auto.v + options.centerOffset.v,
  };

  const availableRadius = clearanceAt(grid, section.dist, center.u, center.v);
  if (availableRadius < requiredRadius) {
    warnings.push(
      `В сечении реза помещается окружность радиусом ${availableRadius.toFixed(1)} мм, ` +
        `а механизму со стенкой нужно ${requiredRadius.toFixed(1)} мм. ` +
        'Увеличьте масштаб модели, сдвиньте рез или выберите механизм поменьше.',
    );
  }

  const cavityHeight = cavityDepthBelow(mechanism, clearance);
  const capRecess = capRecessHeight(mechanism, clearance);

  const availableDepth = depthUnderFootprint(grid, wSplit, center, outerRadius);
  if (availableDepth < cavityHeight + options.floor) {
    warnings.push(
      `Под карманом всего ${availableDepth.toFixed(1)} мм материала, ` +
        `а нужно ${(cavityHeight + options.floor).toFixed(1)} мм (карман + дно). ` +
        'Поднимите плоскость реза или увеличьте масштаб.',
    );

    // Под резом есть высота, а материала нет — верный признак пустой оболочки.
    const spaceBelow = wSplit - grid.wMin;
    if (spaceBelow > 5 && availableDepth < spaceBelow / 3) {
      warnings.push(
        `Под резом ${spaceBelow.toFixed(1)} мм высоты, но материала лишь ${availableDepth.toFixed(1)} мм — ` +
          'похоже, модель пустая внутри (обычное дело для скачанных моделей). Из оболочки карман не ' +
          'вырезать: сделайте модель сплошной перед загрузкой.',
      );
    }
  }

  if (capRecess > 0) {
    const availableAbove = solidDepthAbove(grid, auto.index, wSplit);
    if (availableAbove < capRecess + mechanism.minWall) {
      warnings.push(
        `Над резом всего ${availableAbove.toFixed(1)} мм материала, а верхняя часть свича ` +
          `займёт в крышке ${capRecess.toFixed(1)} мм. Опустите плоскость реза или увеличьте масштаб.`,
      );
    }
  }

  // ---- Рез на две половины -------------------------------------------------
  onProgress('Рез модели');
  await nextFrame();

  const modelBrush = new Brush(source.clone());
  modelBrush.updateMatrixWorld();

  let bottom = csg(modelBrush, halfSpaceSolid(axis, wSplit, -1, span), INTERSECTION);
  await nextFrame();
  let top = csg(modelBrush, halfSpaceSolid(axis, wSplit, 1, span), INTERSECTION);
  modelBrush.geometry.dispose();

  if (isEmpty(bottom.geometry) || isEmpty(top.geometry)) {
    throw new Error('После реза одна из половин получилась пустой — сдвиньте плоскость реза.');
  }

  // ---- Карман под механизм -------------------------------------------------
  onProgress('Карман под механизм');
  await nextFrame();

  if (mechanism.cavity.shape === 'plate') {
    // Ступенчатая посадка: сверху узкий вырез под защёлки, ниже — широкая
    // камера под корпус. Между ними остаётся планка, за которую свич цепляется.
    const p = plateOf(mechanism);
    const aperture = p.aperture + clearance * 2;

    const apertureDepth = p.thickness;
    const chamberDepth = cavityHeight - apertureDepth;

    const apertureCut = boxSolid(
      axis,
      aperture,
      aperture,
      apertureDepth + OVERSHOOT,
      center.u,
      center.v,
      wSplit + OVERSHOOT / 2 - apertureDepth / 2,
    );
    const chamberCut = boxSolid(
      axis,
      footprint.u,
      footprint.v,
      chamberDepth + OVERSHOOT,
      center.u,
      center.v,
      wSplit - apertureDepth - chamberDepth / 2 + OVERSHOOT / 2,
    );

    bottom = csg(bottom, apertureCut, SUBTRACTION);
    await nextFrame();
    bottom = csg(bottom, chamberCut, SUBTRACTION);
    await nextFrame();
  } else {
    const cavityCenterW = wSplit + OVERSHOOT / 2 - cavityHeight / 2;
    const cavity =
      mechanism.cavity.shape === 'cylinder'
        ? cylinderSolid(axis, footprint.u / 2, cavityHeight + OVERSHOOT, center.u, center.v, cavityCenterW, {
            segments: 48,
          })
        : boxSolid(axis, footprint.u, footprint.v, cavityHeight + OVERSHOOT, center.u, center.v, cavityCenterW);

    bottom = csg(bottom, cavity, SUBTRACTION);
    await nextFrame();
  }

  // Верхняя часть корпуса свича уходит в крышку — освобождаем ей место.
  if (capRecess > 0) {
    const recessCut = boxSolid(
      axis,
      footprint.u,
      footprint.v,
      capRecess + OVERSHOOT,
      center.u,
      center.v,
      wSplit - OVERSHOOT / 2 + capRecess / 2,
    );
    top = csg(top, recessCut, SUBTRACTION);
    await nextFrame();
  }

  if (mechanism.wireChannel) {
    const minU = axis === 'x' ? grid.box.min.y : grid.box.min.x;
    const outerU = minU - 5;
    const length = center.u - outerU;
    const channel = boxSolid(
      axis,
      length,
      WIRE_CHANNEL.width,
      WIRE_CHANNEL.height,
      center.u - length / 2,
      center.v,
      // По дну кармана: выводы у всех этих механизмов снизу.
      wSplit - cavityHeight + WIRE_CHANNEL.height / 2 + 0.2,
    );
    bottom = csg(bottom, channel, SUBTRACTION);
    await nextFrame();
  }

  // ---- Канал толкателя в верхней части -------------------------------------
  //
  // В глухом режиме нажимают на саму крышку, поэтому она обязана стоять НА
  // толкателе с зазором до корпуса — иначе она упрётся в корпус и механизм
  // не сработает вовсе. Гнездо делается мельче вылета толкателя ровно на
  // столько, сколько нужно хода.
  const socketDepth = Math.max(0.6, mechanism.plunger.engage - mechanism.plunger.travel);
  const restGap = options.plungerMode === 'blind' ? mechanism.plunger.engage - socketDepth : 0;
  const plungerRadius = mechanism.plunger.diameter / 2 + clearance;

  if (options.plungerMode === 'blind' && restGap < mechanism.plunger.travel - 0.05) {
    warnings.push(
      `Толкатель выступает всего на ${mechanism.plunger.engage.toFixed(1)} мм, поэтому крышка ` +
        `сможет пройти ${restGap.toFixed(1)} мм из ${mechanism.plunger.travel.toFixed(1)} мм хода. ` +
        'Механизм сработает, если ему хватает неполного хода; иначе выберите сквозной канал с кнопкой.',
    );
  }

  if (options.plungerMode === 'blind' && options.pins.enabled && options.pins.height < restGap + 1.5) {
    warnings.push(
      `Крышка стоит с зазором ${restGap.toFixed(1)} мм, а штифты всего ${options.pins.height} мм — ` +
        `при нажатии они почти выходят из отверстий. Сделайте штифты выше ${(restGap + 2).toFixed(1)} мм.`,
    );
  }

  if (options.plungerMode === 'blind' && mechanism.cavity.shape === 'plate') {
    warnings.push(
      'Для клавиатурного свича глухой канал — плохой выбор: крышка встанет с заметным зазором, ' +
        'а верх свича будет видно. Переключите канал на «Насквозь» и напечатайте кнопку.',
    );
  }

  if (options.plungerMode !== 'none') {
    onProgress('Канал толкателя');
    await nextFrame();

    // Канал начинается там, где кончается выборка под корпус механизма.
    const channelStart = wSplit + capRecess;
    const topThickness = solidDepthAbove(grid, auto.index, wSplit) - capRecess;
    let channelLength: number;

    if (options.plungerMode === 'through') {
      // До первой поверхности над механизмом, а не до верха габарита: иначе
      // канал прошьёт насквозь всё, что стоит выше — башни, крышу, ручку.
      channelLength = Math.max(1, topThickness) + OVERSHOOT;
    } else {
      channelLength = Math.min(socketDepth, Math.max(0.5, topThickness - options.membrane));
      if (topThickness - options.membrane < socketDepth) {
        warnings.push(
          `Над каналом только ${Math.max(0, topThickness).toFixed(1)} мм материала: ` +
            `гнездо толкателя укорочено до ${channelLength.toFixed(1)} мм ` +
            `вместо ${socketDepth.toFixed(1)} мм. Переключите канал в режим «Насквозь».`,
        );
      }
    }

    const channel = cylinderSolid(
      axis,
      plungerRadius,
      channelLength + OVERSHOOT,
      center.u,
      center.v,
      channelStart - OVERSHOOT / 2 + channelLength / 2,
      { segments: 40 },
    );
    top = csg(top, channel, SUBTRACTION);
    await nextFrame();
  }

  // ---- Штифты и магниты ----------------------------------------------------
  const pinRadius = options.pins.diameter / 2;
  const magnetRadius = options.magnets.diameter / 2;
  const featureCount =
    (options.pins.enabled ? options.pins.count : 0) + (options.magnets.enabled ? options.magnets.count : 0);

  // Крышка ходит по штифтам, поэтому отверстия глубже ровно на её зазор.
  const holeDepth = options.pins.height + restGap + 0.4;

  let pinRing: number | null = null;
  const pinSlots: RingSlot[] = [];
  const magnetSlots: RingSlot[] = [];

  if (featureCount > 0) {
    onProgress('Штифты совмещения');
    await nextFrame();

    const featureRadius = Math.max(
      options.pins.enabled ? pinRadius : 0,
      options.magnets.enabled ? magnetRadius : 0,
    );
    const wall = Math.max(1.2, mechanism.minWall * 0.75);
    const needAbove = Math.max(
      options.pins.enabled ? holeDepth + 0.8 : 0,
      options.magnets.enabled ? options.magnets.height + 0.9 : 0,
    );
    const cavityClearance = (u: number, v: number) =>
      distanceToCavity(mechanism, clearance, center, u, v);

    // Если запрошенное количество не помещается — ставим столько, сколько влезает.
    let placed: RingSlot[] | null = null;
    let placedCount = 0;
    for (let count = featureCount; count >= 2; count--) {
      placed = placeFeatures(grid, section, center, count, featureRadius, wall, needAbove, cavityClearance);
      if (placed) {
        placedCount = count;
        break;
      }
    }

    if (!placed) {
      warnings.push(
        'Не нашлось места для штифтов и магнитов: в сечении реза слишком мало материала вокруг механизма. ' +
          'Половины придётся склеить.',
      );
    } else {
      if (placedCount < featureCount) {
        warnings.push(
          `Вокруг механизма поместилось ${placedCount} крепёжных элементов из ${featureCount} — ` +
            'остальные пришлось убрать. Уменьшите их диаметр или увеличьте масштаб модели.',
        );
      }

      // Чередуем штифты и магниты, чтобы они не сходились рядом.
      let pinsLeft = options.pins.enabled ? Math.min(options.pins.count, placedCount) : 0;
      let magnetsLeft = options.magnets.enabled ? placedCount - pinsLeft : 0;
      for (const slot of placed) {
        const takePin = pinsLeft > 0 && (magnetsLeft === 0 || pinSlots.length <= magnetSlots.length);
        if (takePin) {
          pinSlots.push(slot);
          pinsLeft--;
        } else if (magnetsLeft > 0) {
          magnetSlots.push(slot);
          magnetsLeft--;
        }
      }

      pinRing = pinSlots.length > 0 ? meanRadius(pinSlots, center) : null;
    }
  }

  if (pinSlots.length > 0) {
    const pins = mergeAll(
      pinSlots.map((slot) =>
        cylinderSolid(axis, pinRadius, options.pins.height, slot.u, slot.v, wSplit + options.pins.height / 2, {
          radiusTop: Math.max(0.4, pinRadius - 0.35),
          segments: 32,
        }),
      ),
    );
    const holes = mergeAll(
      pinSlots.map((slot) =>
        cylinderSolid(
          axis,
          pinRadius + options.pins.fit / 2,
          holeDepth + OVERSHOOT,
          slot.u,
          slot.v,
          wSplit - OVERSHOOT / 2 + holeDepth / 2,
          { segments: 32 },
        ),
      ),
    );

    if (pins) {
      bottom = csg(bottom, pins, ADDITION);
      await nextFrame();
    }
    if (holes) {
      top = csg(top, holes, SUBTRACTION);
      await nextFrame();
    }
  }

  if (magnetSlots.length > 0) {
    onProgress('Карманы под магниты');
    await nextFrame();

    const depth = options.magnets.height + 0.15;
    const radius = magnetRadius + 0.1;

    const lower = mergeAll(
      magnetSlots.map((slot) =>
        cylinderSolid(axis, radius, depth + OVERSHOOT, slot.u, slot.v, wSplit + OVERSHOOT / 2 - depth / 2, {
          segments: 32,
        }),
      ),
    );
    const upper = mergeAll(
      magnetSlots.map((slot) =>
        cylinderSolid(axis, radius, depth + OVERSHOOT, slot.u, slot.v, wSplit - OVERSHOOT / 2 + depth / 2, {
          segments: 32,
        }),
      ),
    );

    if (lower) {
      bottom = csg(bottom, lower, SUBTRACTION);
      await nextFrame();
    }
    if (upper) {
      top = csg(top, upper, SUBTRACTION);
      await nextFrame();
    }
  }

  // ---- Сборка результата ---------------------------------------------------
  onProgress('Подготовка деталей');
  await nextFrame();

  const parts: GeneratedPart[] = [
    {
      id: 'bottom',
      name: 'Корпус (нижняя часть с карманом)',
      fileName: 'clicker-corpus.stl',
      geometry: bottom.geometry,
      volume: computeMeshVolume(bottom.geometry),
    },
    {
      id: 'top',
      name: 'Крышка (верхняя часть)',
      fileName: 'clicker-cap.stl',
      geometry: top.geometry,
      volume: computeMeshVolume(top.geometry),
    },
  ];

  let buttonLift: number | null = null;

  if (options.makeButton && options.plungerMode === 'through') {
    const outerThickness = solidDepthAbove(grid, auto.index, wSplit);
    const shaftRadius = Math.max(0.8, plungerRadius - options.pins.fit / 2);
    const headRadius = shaftRadius + 1.8;
    const headHeight = 2;
    // Шляпка шире канала, поэтому при нажатии упрётся в модель. Приподнимаем её
    // над поверхностью на полный ход плюс запас — иначе кнопку некуда нажимать.
    const headLift = mechanism.plunger.travel + 0.4;

    let button: BufferGeometry;
    buttonLift = headLift;

    if (mechanism.cavity.shape === 'plate') {
      // Колпачок клавиши: снизу трубка с крестообразным гнездом. Крест держит
      // кнопку на штоке — иначе пружина свича вытолкнет её из канала, — а трубка
      // входит в колодец свича, поэтому кнопка проходит полный ход нажатия.
      const s = plateOf(mechanism).stem;
      const socketDepth = s.height;
      // Трубка длиннее гнезда: этот выступ и не даёт кнопке сесть на корпус свича.
      const tubeLength = socketDepth + 1;
      const restBottom = capRecess - clearance + s.height + (tubeLength - socketDepth);
      const shaftLength = outerThickness - restBottom + headLift;

      if (shaftLength < 1) {
        warnings.push(
          `Над свичем всего ${outerThickness.toFixed(1)} мм: кнопке не хватает длины. ` +
            'Опустите плоскость реза или увеличьте масштаб модели.',
        );
      }

      const body = Math.max(1, shaftLength);
      const tube = cylinderSolid(axis, s.tube / 2, tubeLength, 0, 0, tubeLength / 2, { segments: 32 });
      const shaft = cylinderSolid(axis, shaftRadius, body, 0, 0, tubeLength + body / 2, { segments: 40 });
      const head = cylinderSolid(axis, headRadius, headHeight, 0, 0, tubeLength + body + headHeight / 2, {
        radiusTop: headRadius - 0.6,
        segments: 40,
      });

      let brush = new Brush(tube);
      brush.updateMatrixWorld();
      brush = csg(brush, shaft, ADDITION);
      brush = csg(brush, head, ADDITION);
      await nextFrame();

      // Гнездо-крест: два скрещённых паза от торца трубки вверх.
      const armLong = s.length + s.fit;
      const armShort = s.width + s.fit;
      const cross = mergeAll([
        boxSolid(axis, armLong, armShort, socketDepth + OVERSHOOT, 0, 0, socketDepth / 2 - OVERSHOOT / 2),
        boxSolid(axis, armShort, armLong, socketDepth + OVERSHOOT, 0, 0, socketDepth / 2 - OVERSHOOT / 2),
      ])!;
      brush = csg(brush, cross, SUBTRACTION);
      await nextFrame();

      button = brush.geometry;
    } else {
      // Кнопка стоит на толкателе механизма, торчащем над резом на engage.
      const shaftLength = outerThickness - mechanism.plunger.engage + headLift;
      const shaft = cylinderSolid(axis, shaftRadius, shaftLength, 0, 0, shaftLength / 2, { segments: 40 });
      const head = cylinderSolid(axis, headRadius, headHeight, 0, 0, shaftLength + headHeight / 2 - 0.01, {
        radiusTop: headRadius - 0.6,
        segments: 40,
      });
      button = mergeAll([shaft, head])!;
    }

    button.computeBoundingBox();

    parts.push({
      id: 'button',
      name:
        mechanism.cavity.shape === 'plate'
          ? 'Кнопка на шток свича (с крестовиной)'
          : 'Толкатель (печатная кнопка)',
      fileName: 'clicker-button.stl',
      geometry: button,
      volume: computeMeshVolume(button),
    });
  } else if (options.makeButton) {
    warnings.push('Печатный толкатель делается только для сквозного канала — переключите режим канала.');
  }

  if (options.printLayout) computePrintLayout(parts, axis);

  for (const part of parts) {
    part.geometry.computeBoundingBox();
    part.geometry.computeBoundingSphere();
  }

  return {
    parts,
    warnings,
    report: {
      axis,
      splitCoord: wSplit,
      modelSize: {
        x: grid.box.max.x - grid.box.min.x,
        y: grid.box.max.y - grid.box.min.y,
        z: grid.box.max.z - grid.box.min.z,
      },
      cavityCenter: center,
      inscribedRadius: availableRadius,
      requiredRadius,
      pinRing,
      restGap,
      buttonLift,
      pinPositions: pinSlots,
      magnetPositions: magnetSlots,
      mechanism,
    },
  };
}
