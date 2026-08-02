import { Mesh, MeshBasicMaterial } from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import JSZip from 'jszip';
import type { ClickerOptions, ClickerResult, GeneratedPart } from './types';

const exporter = new STLExporter();
const exportMaterial = new MeshBasicMaterial();

/**
 * STL детали. Если генератор посчитал раскладку для печати, она применяется
 * здесь — в файл деталь попадает уже развёрнутой плоскостью реза на стол.
 */
export function partToStl(part: GeneratedPart): ArrayBuffer {
  const mesh = new Mesh(part.geometry, exportMaterial);
  if (part.printMatrix) mesh.applyMatrix4(part.printMatrix);
  mesh.updateMatrixWorld();
  const data = exporter.parse(mesh, { binary: true }) as unknown as DataView;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadPart(part: GeneratedPart): void {
  triggerDownload(new Blob([partToStl(part)], { type: 'model/stl' }), part.fileName);
}

const mm = (value: number) => `${value.toFixed(1)} мм`;

/** Инструкция по сборке — кладётся в архив рядом с моделями. */
export function buildInstructions(result: ClickerResult, options: ClickerOptions, sourceName: string): string {
  const { report } = result;
  const m = report.mechanism;
  const cavity =
    m.cavity.shape === 'cylinder'
      ? `цилиндр ⌀${m.cavity.diameter} × ${m.cavity.height} мм`
      : m.cavity.shape === 'plate'
        ? `вырез ${m.plate!.aperture} × ${m.plate!.aperture} мм в планке ${m.plate!.thickness} мм, ` +
          `камера ${m.plate!.housing} × ${m.plate!.housing} мм`
        : `${m.cavity.width} × ${m.cavity.depth} × ${m.cavity.height} мм`;

  const mounting =
    m.cavity.shape === 'plate'
      ? [
          '',
          '## Посадка свича',
          '',
          `Свич вставляется **сверху**, со стороны реза: продавите его в вырез ${m.plate!.aperture} × ${m.plate!.aperture} мм,`,
          `пока защёлки не выйдут под планкой толщиной ${m.plate!.thickness} мм и не щёлкнут.`,
          `Верхняя часть корпуса (${m.plate!.topHeight} мм) уходит в ответную выборку в крышке —`,
          'поэтому крышка садится только после того, как свич защёлкнут.',
          'Клей не нужен: свич держат защёлки.',
        ]
      : [];

  const lines: string[] = [
    '# Кликер из модели ' + sourceName,
    '',
    'Файлы сгенерированы приложением «Генератор кликеров».',
    '',
    '## Что печатать',
    '',
    ...result.parts.map(
      (p) => `- \`${p.fileName}\` — ${p.name}, объём ${(p.volume / 1000).toFixed(1)} см³`,
    ),
    '',
    '## Механическая часть',
    '',
    `- Механизм: **${m.name}**`,
    `- ${m.hint}`,
    `- Посадочное место: ${cavity} + зазор ${mm(options.clearance)} на сторону`,
    `- Ход толкателя: ${mm(m.plunger.travel)}, канал ⌀${(m.plunger.diameter + options.clearance * 2).toFixed(1)} мм`,
    m.wireChannel ? '- Для выводов прорезан канал наружу — заведите в него провода.' : '',
    '',
    '## Геометрия',
    '',
    `- Габариты модели: ${report.modelSize.x.toFixed(1)} × ${report.modelSize.y.toFixed(1)} × ${report.modelSize.z.toFixed(1)} мм`,
    `- Ось нажатия: ${report.axis.toUpperCase()}, рез на отметке ${mm(report.splitCoord)}`,
    `- Свободный радиус в сечении: ${mm(report.inscribedRadius)} (механизму нужно ${mm(report.requiredRadius)})`,
    report.pinRing !== null
      ? `- Штифты: ${report.pinPositions.length} шт. ⌀${options.pins.diameter} мм на радиусе ≈${mm(report.pinRing)}, посадка ${options.pins.fit} мм`
      : '- Штифты не поставлены — половины нужно склеить или стянуть иначе.',
    report.buttonLift !== null
      ? `- Кнопка выступает над поверхностью на ${mm(report.buttonLift)} — это её ход, так и должно быть`
      : '',
    report.restGap > 0.05
      ? `- Крышка садится с зазором ${mm(report.restGap)} — это и есть ход нажатия, так и должно быть`
      : '',
    report.magnetPositions.length > 0
      ? `- Карманы под магниты: ${report.magnetPositions.length} шт. ⌀${options.magnets.diameter} × ${options.magnets.height} мм`
      : '',
    ...mounting,
    '',
    '## Сборка',
    '',
    '1. Напечатайте детали. Плоскостью реза вниз, без поддержек внутри кармана.',
    '2. Прочистите карман и отверстия под штифты — при необходимости пройдите сверлом.',
    m.cavity.shape === 'plate'
      ? '3. Защёлкните свич в вырез корпуса — до щелчка, без клея.'
      : '3. Вложите механизм в карман корпуса до упора в дно.',
    m.wireChannel ? '4. Выведите провода через боковой канал.' : '',
    `${m.wireChannel ? 5 : 4}. Наденьте крышку на штифты. Проверьте щелчок: толкатель должен нажимать механизм без заедания.`,
    `${m.wireChannel ? 6 : 5}. Если ход тугой — увеличьте зазор и перегенерируйте; если люфтит — уменьшите посадку штифтов.`,
    '',
  ];

  if (result.warnings.length > 0) {
    lines.push('## Предупреждения генератора', '');
    lines.push(...result.warnings.map((w) => `- ${w}`));
    lines.push('');
  }

  return lines.filter((line) => line !== '').join('\n') + '\n';
}

export async function downloadArchive(
  result: ClickerResult,
  options: ClickerOptions,
  sourceName: string,
): Promise<void> {
  const zip = new JSZip();
  for (const part of result.parts) zip.file(part.fileName, partToStl(part));
  zip.file('СБОРКА.md', buildInstructions(result, options, sourceName));

  // Быстрое сжатие: STL с тяжёлой сетки весит десятки мегабайт, и обычный
  // уровень DEFLATE заставляет браузер считать архив дольше, чем сам кликер.
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  });
  const base = sourceName.replace(/\.[^.]+$/, '') || 'clicker';
  triggerDownload(blob, `${base}-clicker.zip`);
}
