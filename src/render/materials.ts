import { MeshStandardMaterial, MeshLambertMaterial, LineBasicMaterial } from "three";

export const rackMaterial = new MeshStandardMaterial({ color: "#8fa0ad", metalness: 0.45, roughness: 0.45 });
export const shelfMaterial = new MeshStandardMaterial({ color: "#b7c2ca", metalness: 0.25, roughness: 0.62 });
export const boxMaterial = new MeshLambertMaterial({ color: "#b98d55" });
export const demandMaterial = new MeshLambertMaterial({ color: "#f2d24b" });
export const floorMaterial = new MeshStandardMaterial({ color: "#e1e5e8", roughness: 0.68 });
export const gridLineMaterial = new LineBasicMaterial({ color: "#36d147", transparent: true, opacity: 0.25 });
export const wallMaterial = new MeshStandardMaterial({ color: "#c2ced8", transparent: true, opacity: 0.12, roughness: 0.55 });
export const roofMaterial = new MeshStandardMaterial({ color: "#d7dde4", transparent: true, opacity: 0.16, roughness: 0.5, metalness: 0.04 });

export const stationColors: Record<string, string> = {
  packing: "#1f8f78",
  inbound: "#2756a3",
  charging: "#a38827",
  buffer: "#7a3ba3",
};

export const robotColors = ["#1f7ae0", "#16a4d8", "#38d36f", "#3b8be2", "#2756a3", "#5aa9ff"];

export function getRobotColor(id: number): string {
  return robotColors[(id - 1) % robotColors.length];
}
