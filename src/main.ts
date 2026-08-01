import type { BufferGeometry } from 'three';
import './style.css';
import {
  analyzeSection,
  buildRayGrid,
  clearanceAt,
  depthUnderFootprint,
  findBestSplit,
  type RayGrid,
  type SplitRequirements,
} from './core/analysis';
import { downloadArchive, downloadPart } from './core/export';
import { loadModelFile, normalizeModel } from './core/import';
import { MECHANISMS, cavityOuterRadius, getMechanism } from './core/mechanisms';
import { generateClicker } from './core/split';
import type { Axis, ClickerOptions, ClickerResult, Mechanism } from './core/types';
import { bool, button, el, input, num, on, select, setHidden, setText, throttleFrame } from './ui/dom';
import { Viewer } from './viewer/viewer';

const viewer = new Viewer(el('viewport'));

const state: {
  source: BufferGeometry | null;
  normalized: BufferGeometry | null;
  grid: RayGrid | null;
  fileName: string;
  triangles: number;
  result: ClickerResult | null;
} = {
  source: null,
  normalized: null,
  grid: null,
  fileName: '',
  triangles: 0,
  result: null,
};

// ---------------------------------------------------------------- механизмы

function fillMechanisms(): void {
  const node = select('mech');
  node.innerHTML = '';
  for (const mechanism of MECHANISMS) {
    const option = document.createElement('option');
    option.value = mechanism.id;
    option.textContent = mechanism.name;
    node.append(option);
  }
  node.value = 'dog-clicker';
}

function currentMechanism(): Mechanism {
  const mechanism = getMechanism(select('mech').value);
  if (!mechanism.editable) return mechanism;

  const shape = select('cav-shape').value as 'box' | 'cylinder';
  mechanism.cavity = {
    shape,
    height: num('cav-h', 8),
    ...(shape === 'cylinder'
      ? { diameter: num('cav-dia', 12) }
      : { width: num('cav-w', 15), depth: num('cav-d', 15) }),
  };
  mechanism.plunger = {
    diameter: num('plg-dia', 7),
    travel: num('plg-travel', 1),
    engage: num('plg-engage', 3),
  };
  mechanism.minWall = num('cav-wall', 1.6);
  mechanism.wireChannel = bool('cav-wires');
  return mechanism;
}

function syncMechanismUi(): void {
  const mechanism = getMechanism(select('mech').value);
  setText('mech-hint', mechanism.hint);
  setHidden('custom-dims', !mechanism.editable);
  if (mechanism.editable) {
    const cylinder = select('cav-shape').value === 'cylinder';
    setHidden('cav-cyl', !cylinder);
    setHidden('cav-box', cylinder);
  }
}

// ------------------------------------------------------------------ опции

function collectOptions(): ClickerOptions {
  return {
    axis: select('axis').value as Axis,
    splitAt: num('split', 35) / 100,
    mechanism: currentMechanism(),
    clearance: num('clearance', 0.3),
    floor: num('floor', 1.6),
    centerOffset: { u: num('offset-u', 0), v: num('offset-v', 0) },
    pins: {
      enabled: bool('pins-enabled'),
      count: Math.round(num('pins-count', 3)),
      diameter: num('pins-dia', 3),
      height: num('pins-height', 4),
      fit: num('pins-fit', 0.25),
    },
    magnets: {
      enabled: bool('magnets-enabled'),
      count: Math.round(num('magnets-count', 2)),
      diameter: num('magnets-dia', 5),
      height: num('magnets-height', 2),
    },
    plungerMode: select('plunger-mode').value as ClickerOptions['plungerMode'],
    membrane: num('membrane', 1.2),
    makeButton: bool('make-button'),
    printLayout: bool('print-layout'),
  };
}

// ------------------------------------------------------------------ статус

function showStatus(text: string): void {
  setText('status-text', text);
  setHidden('status', false);
}

function hideStatus(): void {
  setHidden('status', true);
}

function showMessages(messages: string[], isError = false): void {
  const box = el('warnings');
  box.innerHTML = '';
  for (const message of messages) {
    const p = document.createElement('p');
    p.textContent = message;
    if (isError) p.classList.add('is-error');
    box.append(p);
  }
  if (messages.length > 0) setHidden('results', false);
}

// ------------------------------------------------------------- пересчёты

function splitCoord(grid: RayGrid): number {
  return grid.wMin + (grid.wMax - grid.wMin) * (num('split', 35) / 100);
}

/** Требования механизма к сечению реза. */
function requirements(): SplitRequirements {
  const options = collectOptions();
  const mechanism = options.mechanism;
  const footprintRadius = cavityOuterRadius(mechanism, options.clearance);
  const socket = mechanism.plunger.engage + mechanism.plunger.travel;
  return {
    radius: footprintRadius + mechanism.minWall,
    footprintRadius,
    depthBelow: mechanism.cavity.height + options.clearance + options.floor,
    depthAbove:
      options.plungerMode === 'blind' ? socket + options.membrane : Math.max(socket, mechanism.minWall),
  };
}

function updateSectionInfo(): void {
  setText('split-value', `${Math.round(num('split', 35))}%`);
  const grid = state.grid;
  if (!grid || !state.normalized) return;

  const w = splitCoord(grid);
  viewer.showSplitPlane(grid.axis, w, state.normalized.boundingBox);

  const section = analyzeSection(grid, w);
  const options = collectOptions();
  const need = requirements();

  if (section.inscribedRadius <= 0) {
    setText('section-info', 'На этой высоте модель не пересекается плоскостью реза.');
    return;
  }

  const center = {
    u: section.center.u + options.centerOffset.u,
    v: section.center.v + options.centerOffset.v,
  };
  const available = clearanceAt(grid, section.dist, center.u, center.v);
  const depth = depthUnderFootprint(grid, w, center, need.footprintRadius);
  const fits = available >= need.radius && depth >= need.depthBelow;

  setText(
    'section-info',
    `Сечение: помещается ⌀${(available * 2).toFixed(1)} мм, под резом ${depth.toFixed(1)} мм материала. ` +
      `Механизму нужно ⌀${(need.radius * 2).toFixed(1)} мм и ${need.depthBelow.toFixed(1)} мм. ` +
      (fits ? '✓ помещается' : '✗ не помещается — увеличьте масштаб или сдвиньте рез'),
  );
}

const updateSectionInfoThrottled = throttleFrame(updateSectionInfo);

function rebuildGrid(): void {
  if (!state.normalized) return;
  const axis = select('axis').value as Axis;
  const resolution = state.triangles > 250_000 ? 96 : 128;
  state.grid = buildRayGrid(state.normalized, axis, resolution);
  updateSectionInfo();
}

function rebuildModel(): void {
  if (!state.source) return;
  showStatus('Пересчёт модели');

  // Даём браузеру отрисовать статус перед синхронной работой.
  requestAnimationFrame(() => {
    try {
      state.normalized?.dispose();
      state.normalized = normalizeModel(state.source!, num('scale', 1));
      viewer.showSource(state.normalized);

      const box = state.normalized.boundingBox!;
      setText(
        'model-size',
        `${(box.max.x - box.min.x).toFixed(1)} × ${(box.max.y - box.min.y).toFixed(1)} × ${(box.max.z - box.min.z).toFixed(1)} мм`,
      );

      rebuildGrid();
      // Сразу подводим рез туда, где механизм помещается, — чтобы модель
      // открывалась готовой к генерации, а не с заведомо плохим сечением.
      autoSplit(true);
      state.result = null;
      setHidden('results', true);
      button('generate').disabled = false;
    } catch (error) {
      showMessages([(error as Error).message], true);
    } finally {
      hideStatus();
    }
  });
}

// ------------------------------------------------------------- загрузка

async function handleFile(file: File): Promise<void> {
  showStatus(`Загрузка ${file.name}`);
  showMessages([]);
  try {
    const model = await loadModelFile(file);
    state.source?.dispose();
    state.source = model.geometry;
    state.fileName = model.fileName;
    state.triangles = model.triangles;

    setHidden('model-facts', false);
    setText('model-name', model.fileName);
    setText('model-tris', model.triangles.toLocaleString('ru-RU'));

    if (model.triangles > 400_000) {
      showMessages([
        `В модели ${model.triangles.toLocaleString('ru-RU')} полигонов — генерация займёт заметное время. ` +
          'Если что-то пойдёт не так, упростите сетку в редакторе.',
      ]);
    }

    rebuildModel();
  } catch (error) {
    hideStatus();
    showMessages([(error as Error).message], true);
  }
}

function setupDropZone(): void {
  const drop = el('drop');
  drop.addEventListener('click', () => input('file').click());

  on('file', 'change', () => {
    const file = input('file').files?.[0];
    if (file) void handleFile(file);
  });

  for (const type of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop'] as const) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  // Файл можно бросить в любое место окна.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });
}

// ------------------------------------------------------------- генерация

function renderParts(result: ClickerResult): void {
  const list = el('parts');
  list.innerHTML = '';
  for (const part of result.parts) {
    const item = document.createElement('li');
    const label = document.createElement('div');
    label.innerHTML = `${part.name}<small>${part.fileName} · ${(part.volume / 1000).toFixed(1)} см³</small>`;

    const download = document.createElement('button');
    download.className = 'btn btn--ghost btn--sm';
    download.type = 'button';
    download.textContent = 'STL';
    download.addEventListener('click', () => downloadPart(part));

    item.append(label, download);
    list.append(item);
  }
}

async function generate(): Promise<void> {
  if (!state.normalized || !state.grid) return;

  const options = collectOptions();
  button('generate').disabled = true;
  showMessages([]);

  try {
    const result = await generateClicker(state.normalized, state.grid, options, showStatus);
    state.result = result;

    viewer.hideSplitPlane();
    viewer.showParts(result.parts, options.axis);
    input('explode').value = '0';
    input('vis-bottom').checked = true;
    input('vis-top').checked = true;

    setHidden('results', false);
    renderParts(result);
    showMessages(result.warnings);
  } catch (error) {
    showMessages([(error as Error).message], true);
  } finally {
    hideStatus();
    button('generate').disabled = false;
  }
}

// ------------------------------------------------------------- автоподбор

function autoScale(): void {
  if (!state.grid) return;
  const grid = state.grid;
  const w = splitCoord(grid);
  const section = analyzeSection(grid, w);
  const need = requirements();

  const available = clearanceAt(grid, section.dist, section.center.u, section.center.v);
  const depth = depthUnderFootprint(grid, w, section.center, need.footprintRadius);
  if (available <= 0 || depth <= 0) {
    showMessages(['На этой высоте нечего масштабировать — сдвиньте рез.'], true);
    return;
  }

  const factor = Math.max(need.radius / available, need.depthBelow / depth) * 1.08;
  if (factor <= 1) {
    showMessages(['Механизм и так помещается — масштабировать не нужно.']);
    return;
  }

  input('scale').value = (num('scale', 1) * factor).toFixed(3);
  rebuildModel();
}

function autoSplit(silent = false): void {
  if (!state.grid) return;
  const fraction = findBestSplit(state.grid, requirements());
  if (fraction === null) {
    if (!silent) {
      showMessages(['Не нашлось сечения, в которое помещается механизм. Увеличьте масштаб модели.'], true);
    }
    return;
  }
  input('split').value = String(Math.round(fraction * 100));
  updateSectionInfo();
}

// ------------------------------------------------------------------ старт

function bindEvents(): void {
  on('mech', 'change', () => {
    syncMechanismUi();
    updateSectionInfo();
  });
  on('cav-shape', 'change', () => {
    syncMechanismUi();
    updateSectionInfo();
  });

  for (const id of ['clearance', 'floor', 'cav-h', 'cav-w', 'cav-d', 'cav-dia', 'cav-wall', 'offset-u', 'offset-v']) {
    on(id, 'input', updateSectionInfoThrottled);
  }

  on('axis', 'change', () => {
    showStatus('Анализ модели');
    requestAnimationFrame(() => {
      rebuildGrid();
      hideStatus();
    });
  });

  on('split', 'input', updateSectionInfoThrottled);
  on('split-auto', 'click', () => autoSplit());
  on('scale', 'change', rebuildModel);
  on('scale-fit', 'click', autoScale);
  on('scale-reset', 'click', () => {
    input('scale').value = '1';
    rebuildModel();
  });

  on('generate', 'click', () => void generate());
  on('export-zip', 'click', () => {
    if (state.result) void downloadArchive(state.result, collectOptions(), state.fileName);
  });

  on('explode', 'input', () => viewer.setExplode(num('explode', 0)));
  on('wireframe', 'change', () => viewer.setWireframe(bool('wireframe')));
  on('vis-bottom', 'change', () => viewer.setPartVisible('bottom', bool('vis-bottom')));
  on('vis-top', 'change', () => viewer.setPartVisible('top', bool('vis-top')));
  on('fit-view', 'click', () => viewer.frameContent());
}

fillMechanisms();
syncMechanismUi();
setupDropZone();
bindEvents();
