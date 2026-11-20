import { CanvasTexture } from "three";

const textureCache = new Map<string, CanvasTexture>();

export function makeLabelTexture(text: string, accent = "#111827"): CanvasTexture {
  const key = `${text}_${accent}`;
  if (textureCache.has(key)) return textureCache.get(key)!;

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, 256, 96);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 256, 16);
  ctx.fillStyle = "#111827";
  ctx.font = "700 34px Arial";
  ctx.textAlign = "center";
  ctx.fillText(text, 128, 60);
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 === 0 ? "#111827" : "#f8fafc";
    ctx.fillRect(18 + i * 27, 70, 18, 18);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = "srgb";
  textureCache.set(key, texture);
  return texture;
}

export function makeParkingBayLabelTexture(bayId: string, state: string): CanvasTexture {
  const key = `pb_${bayId}_${state}`;
  if (textureCache.has(key)) return textureCache.get(key)!;

  const stateColors: Record<string, string> = {
    free: "#22cc55",
    reserved: "#ccaa22",
    occupied: "#3388ff",
    blocked: "#cc3333",
  };
  const accent = stateColors[state] ?? "#555555";

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 64);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.55;
  ctx.fillRect(0, 0, 128, 64);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 124, 60);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(bayId, 64, 32);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = "srgb";
  textureCache.set(key, texture);
  return texture;
}

export function clearLabelCache() {
  for (const tex of textureCache.values()) tex.dispose();
  textureCache.clear();
}
