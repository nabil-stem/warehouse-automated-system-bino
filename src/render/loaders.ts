import { Group, Box3, Vector3, Mesh, Material } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

let cachedModel: Group | null = null;
let cachedReferenceModel: Group | null = null;
let currentObjectUrl: string | null = null;
let currentReferenceObjectUrl: string | null = null;
const loader = new GLTFLoader();

export type ModelLoadResult = {
  status: "loaded" | "failed";
  error?: string;
};

export async function loadRobotModel(file: File, scale: number): Promise<ModelLoadResult> {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  cachedModel = null;

  const url = URL.createObjectURL(file);
  currentObjectUrl = url;

  try {
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;
    const box = new Box3().setFromObject(model);
    const size = new Vector3();
    box.getSize(size);
    const center = new Vector3();
    box.getCenter(center);
    model.position.sub(center);
    model.position.y += size.y / 2;
    model.scale.setScalar(scale);
    cachedModel = model;
    return { status: "loaded" };
  } catch (e) {
    URL.revokeObjectURL(url);
    currentObjectUrl = null;
    return { status: "failed", error: String(e) };
  }
}

export function getCachedModel(): Group | null {
  return cachedModel;
}

export function cloneRobotModel(scale: number): Group | null {
  if (!cachedModel) return null;
  const clone = cachedModel.clone(true);
  clone.scale.setScalar(scale);
  return clone;
}

export function clearRobotModel() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  cachedModel = null;
}

export function hasCustomModel(): boolean {
  return cachedModel !== null;
}

export async function loadReferenceWarehouseModel(file: File, scale: number): Promise<ModelLoadResult> {
  if (currentReferenceObjectUrl) {
    URL.revokeObjectURL(currentReferenceObjectUrl);
    currentReferenceObjectUrl = null;
  }
  cachedReferenceModel = null;

  const url = URL.createObjectURL(file);
  currentReferenceObjectUrl = url;

  try {
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;
    centerModelOnFloor(model);
    model.scale.setScalar(scale);
    cachedReferenceModel = model;
    return { status: "loaded" };
  } catch (e) {
    URL.revokeObjectURL(url);
    currentReferenceObjectUrl = null;
    return { status: "failed", error: String(e) };
  }
}

export async function loadReferenceWarehouseModelFromUrl(url: string, scale: number): Promise<ModelLoadResult> {
  if (currentReferenceObjectUrl) {
    URL.revokeObjectURL(currentReferenceObjectUrl);
    currentReferenceObjectUrl = null;
  }
  cachedReferenceModel = null;

  try {
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;
    centerModelOnFloor(model);
    model.scale.setScalar(scale);
    cachedReferenceModel = model;
    return { status: "loaded" };
  } catch (e) {
    return { status: "failed", error: String(e) };
  }
}

export function cloneReferenceWarehouseModel(scale: number): Group | null {
  if (!cachedReferenceModel) return null;
  const clone = cachedReferenceModel.clone(true);
  clone.scale.setScalar(scale);
  return clone;
}

export function applyReferenceModelOpacity(model: Group, opacity: number) {
  const clamped = Math.max(0.05, Math.min(1, opacity));
  model.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    obj.material = materials.map((mat) => {
      const cloned = (mat as Material).clone();
      cloned.transparent = clamped < 1;
      cloned.opacity = clamped;
      cloned.depthWrite = clamped >= 0.75;
      return cloned;
    }) as any;
  });
}

export function clearReferenceWarehouseModel() {
  if (currentReferenceObjectUrl) {
    URL.revokeObjectURL(currentReferenceObjectUrl);
    currentReferenceObjectUrl = null;
  }
  cachedReferenceModel = null;
}

export function hasReferenceWarehouseModel(): boolean {
  return cachedReferenceModel !== null;
}

function centerModelOnFloor(model: Group) {
  const box = new Box3().setFromObject(model);
  const size = new Vector3();
  box.getSize(size);
  const center = new Vector3();
  box.getCenter(center);
  model.position.sub(center);
  model.position.y += size.y / 2;
}
