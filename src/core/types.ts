import type { BufferGeometry, Matrix4 } from 'three';

/** Ось, вдоль которой модель режется и вдоль которой происходит нажатие. */
export type Axis = 'x' | 'y' | 'z';

/**
 * Форма посадочного места механизма.
 * `plate` — ступенчатая посадка клавиатурного свича: он защёлкивается
 * за планку с квадратным вырезом, поэтому одной коробкой не обойтись.
 */
export type CavityShape = 'cylinder' | 'box' | 'plate';

/**
 * Посадка свича на планку, как в клавиатуре.
 *
 * Свич продавливается сверху в квадратный вырез: верхняя часть корпуса
 * ложится на планку, защёлки на нижней части выходят под ней и держат свич.
 * Планкой служит верхний слой корпуса, прямо под плоскостью реза.
 */
export interface PlateMount {
  /** Сторона квадратного выреза под защёлки. */
  aperture: number;
  /** Толщина планки — за неё цепляются защёлки. */
  thickness: number;
  /** Габарит корпуса свича: по нему делаются камеры сверху и снизу планки. */
  housing: number;
  /** Высота корпуса над планкой — эта часть уходит в крышку. */
  topHeight: number;
  /** Высота корпуса под планкой, где расходятся защёлки. */
  bodyDepth: number;
  /** Запас под выводы и ножки под корпусом. */
  pinDepth: number;
}

/**
 * Описание механической части, которая и делает щелчок.
 * Все размеры — в миллиметрах, без учёта зазоров: зазор добавляется при генерации.
 */
export interface Mechanism {
  id: string;
  name: string;
  /** Короткое пояснение: что это за железка и где её взять. */
  hint: string;
  /** Посадочное место (карман) под механизм в нижней части. */
  cavity: {
    shape: CavityShape;
    /** Диаметр для cylinder. */
    diameter?: number;
    /** Габариты по осям сечения для box. */
    width?: number;
    depth?: number;
    /** Высота кармана вдоль оси нажатия. Для plate считается из размеров планки. */
    height: number;
  };
  /** Размеры посадки на планку — только для cavity.shape === 'plate'. */
  plate?: PlateMount;
  /** Толкатель: канал в верхней части, через который давят на механизм. */
  plunger: {
    diameter: number;
    /** Ход толкателя — насколько он утапливается при щелчке. */
    travel: number;
    /** Насколько толкатель заходит внутрь верхней части. */
    engage: number;
  };
  /** Нужен ли канал для проводов наружу (для механизмов с контактами). */
  wireChannel: boolean;
  /** Рекомендуемая минимальная толщина стенки вокруг механизма. */
  minWall: number;
  /** Можно ли редактировать размеры в интерфейсе. */
  editable?: boolean;
}

/** Настройки генерации кликера. */
export interface ClickerOptions {
  /** Ось реза / нажатия. */
  axis: Axis;
  /** Положение плоскости реза, доля 0..1 от габарита вдоль оси. */
  splitAt: number;
  /** Механизм, под который делается полость. */
  mechanism: Mechanism;
  /** Технологический зазор вокруг механизма. */
  clearance: number;
  /** Толщина дна под карманом механизма. */
  floor: number;
  /** Ручное смещение центра механизма относительно найденного автоматически. */
  centerOffset: { u: number; v: number };

  /** Штифты совмещения. */
  pins: {
    enabled: boolean;
    count: number;
    diameter: number;
    height: number;
    /** Посадочный зазор штифт/отверстие на диаметр. */
    fit: number;
  };

  /** Карманы под неодимовые магниты в обеих половинах. */
  magnets: {
    enabled: boolean;
    count: number;
    diameter: number;
    height: number;
  };

  /** Канал толкателя в верхней части. */
  plungerMode: 'through' | 'blind' | 'none';
  /** Толщина мембраны над глухим каналом. */
  membrane: number;

  /** Генерировать отдельную печатную кнопку-толкатель. */
  makeButton: boolean;

  /** Развернуть части плоскостью реза вниз и разнести для печати. */
  printLayout: boolean;
}

/** Одна деталь на выходе. */
export interface GeneratedPart {
  id: string;
  name: string;
  fileName: string;
  /** Геометрия в координатах сборки — так деталь и показывается в 3D. */
  geometry: BufferGeometry;
  /**
   * Разворот детали плоскостью реза на стол для печати.
   * Применяется только при экспорте, чтобы просмотр оставался «в сборе».
   */
  printMatrix?: Matrix4;
  /** Объём детали в мм³ — для оценки расхода пластика. */
  volume: number;
}

/** Результат генерации. */
export interface ClickerResult {
  parts: GeneratedPart[];
  warnings: string[];
  /** Отчёт о геометрии для инструкции по сборке. */
  report: {
    axis: Axis;
    splitCoord: number;
    modelSize: { x: number; y: number; z: number };
    cavityCenter: { u: number; v: number };
    /** Максимальный радиус окружности, вписанной в сечение реза. */
    inscribedRadius: number;
    /** Радиус, необходимый механизму со стенкой. */
    requiredRadius: number;
    pinRing: number | null;
    /** Зазор между половинами в собранном виде — ход крышки при нажатии. */
    restGap: number;
    /** Координаты реально размещённых штифтов и магнитов в плоскости реза. */
    pinPositions: { u: number; v: number }[];
    magnetPositions: { u: number; v: number }[];
    mechanism: Mechanism;
  };
}
