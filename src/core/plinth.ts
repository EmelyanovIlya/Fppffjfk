import { Box3, BufferGeometry, Vector3 } from 'three';
import { ADDITION, Brush, Evaluator } from 'three-bvh-csg';
import { boxSolid } from './solids';

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = false;

export interface PlinthOptions {
  /** Насколько нарастить основание вниз, мм. */
  height: number;
  /** Утопить цоколь относительно контура низа модели, мм. */
  inset: number;
}

/**
 * Габариты низа модели: берём только вершины из нижнего слоя, а не весь
 * габаритный ящик. У модели с широкой шляпкой и узким основанием цоколь
 * должен повторять основание, а не шляпку.
 */
function bottomFootprint(geometry: BufferGeometry): Box3 {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const position = geometry.getAttribute('position');
  const bandTop = box.min.z + Math.max(0.5, (box.max.z - box.min.z) * 0.05);

  const footprint = new Box3();
  const point = new Vector3();
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    if (z > bandTop) continue;
    footprint.expandByPoint(point.set(position.getX(i), position.getY(i), z));
  }

  return footprint.isEmpty() ? box.clone() : footprint;
}

/**
 * Наращивает основание модели вниз прямоугольным цоколем.
 *
 * Нужно, когда модель сама по себе подходит, но её подставка слишком тонкая:
 * механизму некуда уйти вглубь. Цоколь заходит в модель с перекрытием и
 * приваривается булевой операцией — на выходе одно сплошное тело.
 * Результат опускается на ноль, как и остальные модели в приложении.
 */
export function addPlinth(source: BufferGeometry, options: PlinthOptions): BufferGeometry {
  if (options.height <= 0) return source;

  const footprint = bottomFootprint(source);
  const size = footprint.getSize(new Vector3());
  const center = footprint.getCenter(new Vector3());

  const sizeU = Math.max(1, size.x - options.inset * 2);
  const sizeV = Math.max(1, size.y - options.inset * 2);

  // Перекрытие с моделью, чтобы объединение шло по объёму, а не по касанию.
  const overlap = 1;
  const total = options.height + overlap;

  const plinth = boxSolid(
    'z',
    sizeU,
    sizeV,
    total,
    center.x,
    center.y,
    // Низ цоколя ровно на height ниже модели, верх заходит внутрь на overlap.
    footprint.min.z + overlap - total / 2,
  );

  const model = new Brush(source.clone());
  model.updateMatrixWorld();
  const tool = new Brush(plinth);
  tool.updateMatrixWorld();

  const result = evaluator.evaluate(model, tool, ADDITION);
  const geometry = result.geometry;

  model.geometry.dispose();
  tool.geometry.dispose();

  geometry.computeBoundingBox();
  geometry.translate(0, 0, -geometry.boundingBox!.min.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
