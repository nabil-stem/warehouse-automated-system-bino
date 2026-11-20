import fs from "node:fs/promises";
import path from "node:path";
import { Box3, Vector3 } from "three";

globalThis.self = globalThis;
if (!globalThis.createImageBitmap) {
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
}

const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/analyze_glb_model.mjs <file.glb>");
  process.exit(1);
}

const bytes = await fs.readFile(file);
const loader = new GLTFLoader();
const gltf = await new Promise((resolve, reject) => {
  loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), path.dirname(file), resolve, reject);
});

const scene = gltf.scene;
scene.updateMatrixWorld(true);

const sceneBox = new Box3().setFromObject(scene);
const sceneSize = new Vector3();
sceneBox.getSize(sceneSize);

const meshes = [];
const materialCounts = new Map();
const nameCounts = new Map();

scene.traverse(obj => {
  nameCounts.set(obj.name || "(unnamed)", (nameCounts.get(obj.name || "(unnamed)") ?? 0) + 1);
  if (!obj.isMesh) return;
  const box = new Box3().setFromObject(obj);
  const size = new Vector3();
  const center = new Vector3();
  box.getSize(size);
  box.getCenter(center);
  const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
  const color = mat?.color ? `#${mat.color.getHexString()}` : "none";
  const key = `${mat?.name || "(mat)"} ${color}`;
  materialCounts.set(key, (materialCounts.get(key) ?? 0) + 1);
  meshes.push({
    name: obj.name || "(unnamed)",
    material: key,
    center: { x: center.x, y: center.y, z: center.z },
    size: { x: size.x, y: size.y, z: size.z },
    volume: size.x * size.y * size.z,
    thinAxes: ["x", "y", "z"].filter(axis => size[axis] > 0 && size[axis] < 0.12),
  });
});

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function roundedSizeKey(m) {
  return `${round(m.size.x)}x${round(m.size.y)}x${round(m.size.z)} ${m.material}`;
}

const sizeCounts = new Map();
for (const m of meshes) {
  const key = roundedSizeKey(m);
  sizeCounts.set(key, (sizeCounts.get(key) ?? 0) + 1);
}

const topSizes = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
const topMaterials = [...materialCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
const topNames = [...nameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

const thinLong = meshes
  .filter(m => {
    const dims = [m.size.x, m.size.y, m.size.z].sort((a, b) => a - b);
    return dims[0] < 0.13 && dims[2] > 0.8;
  })
  .sort((a, b) => b.size.y - a.size.y)
  .slice(0, 40);

const boxLike = meshes
  .filter(m => {
    const mat = m.material.toLowerCase();
    return mat.includes("2a2f35") || mat.includes("3f4852") || mat.includes("151b22") || mat.includes("b98d55");
  })
  .sort((a, b) => b.volume - a.volume)
  .slice(0, 30);

const lowObstacles = meshes
  .filter(m => m.center.y < 1.2 && m.size.y > 0.08 && m.volume > 0.0005)
  .sort((a, b) => a.center.z - b.center.z)
  .slice(0, 80);

const result = {
  file,
  sceneBounds: {
    min: { x: round(sceneBox.min.x), y: round(sceneBox.min.y), z: round(sceneBox.min.z) },
    max: { x: round(sceneBox.max.x), y: round(sceneBox.max.y), z: round(sceneBox.max.z) },
    size: { x: round(sceneSize.x), y: round(sceneSize.y), z: round(sceneSize.z) },
  },
  counts: {
    sceneChildren: scene.children.length,
    totalNodes: [...nameCounts.values()].reduce((a, b) => a + b, 0),
    meshes: meshes.length,
    materials: materialCounts.size,
    sizeGroups: sizeCounts.size,
  },
  topMaterials,
  topMeshSizes: topSizes,
  topNames,
  thinLongExamples: thinLong.map(m => ({
    name: m.name,
    material: m.material,
    center: Object.fromEntries(Object.entries(m.center).map(([k, v]) => [k, round(v)])),
    size: Object.fromEntries(Object.entries(m.size).map(([k, v]) => [k, round(v)])),
  })),
  boxLikeExamples: boxLike.map(m => ({
    name: m.name,
    material: m.material,
    center: Object.fromEntries(Object.entries(m.center).map(([k, v]) => [k, round(v)])),
    size: Object.fromEntries(Object.entries(m.size).map(([k, v]) => [k, round(v)])),
  })),
  lowObstacleExamples: lowObstacles.map(m => ({
    name: m.name,
    material: m.material,
    center: Object.fromEntries(Object.entries(m.center).map(([k, v]) => [k, round(v)])),
    size: Object.fromEntries(Object.entries(m.size).map(([k, v]) => [k, round(v)])),
  })),
};

console.log(JSON.stringify(result, null, 2));
