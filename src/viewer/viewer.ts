import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeVector } from '../core/analysis';
import type { Axis, GeneratedPart } from '../core/types';

const PART_COLORS: Record<string, number> = {
  bottom: 0x4f8dfd,
  top: 0xf2a33c,
  button: 0x5fd39a,
  source: 0xb9c2d0,
};

export class Viewer {
  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private controls: OrbitControls;
  private content = new Group();
  private planeHelper: Mesh;
  private meshes: { part: GeneratedPart; mesh: Mesh }[] = [];
  private explodeAxis: Axis = 'z';
  private explodeAmount = 0;
  private disposables: (BufferGeometry | MeshStandardMaterial)[] = [];

  constructor(private container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = new Color(0x14181f);

    this.camera = new PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(90, -120, 80);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new HemisphereLight(0xdfe9ff, 0x20242c, 1.1));
    this.scene.add(new AmbientLight(0xffffff, 0.35));

    const key = new DirectionalLight(0xffffff, 2.0);
    key.position.set(60, -80, 120);
    this.scene.add(key);
    const fill = new DirectionalLight(0xa8c0ff, 0.9);
    fill.position.set(-90, 60, 40);
    this.scene.add(fill);

    const grid = new GridHelper(400, 40, 0x3a4352, 0x252b35);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    this.planeHelper = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshStandardMaterial({
        color: 0xff5f7a,
        transparent: true,
        opacity: 0.18,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    this.planeHelper.visible = false;
    this.scene.add(this.planeHelper);

    this.scene.add(this.content);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private tick(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  }

  private clearContent(): void {
    this.content.clear();
    this.meshes = [];
    for (const item of this.disposables) item.dispose();
    this.disposables = [];
  }

  private makeMesh(geometry: BufferGeometry, colorKey: string, opacity = 1): Mesh {
    const material = new MeshStandardMaterial({
      color: PART_COLORS[colorKey] ?? 0x9aa4b2,
      roughness: 0.45,
      metalness: 0.05,
      side: DoubleSide,
      transparent: opacity < 1,
      opacity,
      flatShading: false,
    });
    this.disposables.push(material);
    return new Mesh(geometry, material);
  }

  /** Показывает исходную модель до генерации. */
  showSource(geometry: BufferGeometry): void {
    this.clearContent();
    this.content.add(this.makeMesh(geometry, 'source'));
    this.frameContent();
  }

  /** Показывает готовые детали кликера. */
  showParts(parts: GeneratedPart[], axis: Axis): void {
    this.clearContent();
    this.explodeAxis = axis;
    for (const part of parts) {
      const mesh = this.makeMesh(part.geometry, part.id);
      this.meshes.push({ part, mesh });
      this.content.add(mesh);
    }
    this.setExplode(this.explodeAmount);
    this.frameContent();
  }

  setPartVisible(id: string, visible: boolean): void {
    for (const item of this.meshes) {
      if (item.part.id === id) item.mesh.visible = visible;
    }
  }

  setWireframe(enabled: boolean): void {
    this.content.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh) (mesh.material as MeshStandardMaterial).wireframe = enabled;
    });
  }

  /** Разносит половины вдоль оси нажатия, мм. */
  setExplode(amount: number): void {
    this.explodeAmount = amount;
    const direction = makeVector(this.explodeAxis, 0, 0, 1);
    for (const { part, mesh } of this.meshes) {
      const sign = part.id === 'top' ? 1 : part.id === 'bottom' ? -1 : 1.6;
      mesh.position.copy(direction).multiplyScalar((sign * amount) / 2);
    }
  }

  /** Рисует полупрозрачную плоскость будущего реза. */
  showSplitPlane(axis: Axis, coord: number, box: Box3 | null): void {
    if (!box) {
      this.planeHelper.visible = false;
      return;
    }
    const size = box.getSize(new Vector3());
    const extent = Math.max(size.x, size.y, size.z) * 1.25;

    this.planeHelper.geometry.dispose();
    this.planeHelper.geometry = new PlaneGeometry(extent, extent);
    this.planeHelper.rotation.set(0, 0, 0);
    if (axis === 'x') this.planeHelper.rotation.y = Math.PI / 2;
    else if (axis === 'y') this.planeHelper.rotation.x = Math.PI / 2;

    const center = box.getCenter(new Vector3());
    const position = makeVector(axis, 0, 0, coord);
    if (axis === 'x') position.set(coord, center.y, center.z);
    else if (axis === 'y') position.set(center.x, coord, center.z);
    else position.set(center.x, center.y, coord);

    this.planeHelper.position.copy(position);
    this.planeHelper.visible = true;
  }

  hideSplitPlane(): void {
    this.planeHelper.visible = false;
  }

  /** Подгоняет камеру под содержимое сцены. */
  frameContent(): void {
    const box = new Box3().setFromObject(this.content);
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new Sphere());
    const distance = (sphere.radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15;

    const direction = new Vector3(0.75, -1, 0.6).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.camera.near = Math.max(0.05, distance / 500);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(sphere.center);
    this.controls.update();
  }
}
