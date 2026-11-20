import type { Scene, WebGLRenderer } from "three";
import { downloadBlob } from "../app/persistence";

export async function exportGLB(scene: Scene, filename: string): Promise<void> {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const exporter = new GLTFExporter();

  return new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          const blob = new Blob([result], { type: "model/gltf-binary" });
          downloadBlob(blob, filename);
          resolve();
        } else {
          const json = JSON.stringify(result, null, 2);
          const blob = new Blob([json], { type: "application/json" });
          downloadBlob(blob, filename.replace(".glb", ".gltf"));
          resolve();
        }
      },
      (error) => reject(error),
      { binary: true }
    );
  });
}

export function exportScreenshot(renderer: WebGLRenderer, filename: string) {
  renderer.domElement.toBlob((blob) => {
    if (blob) downloadBlob(blob, filename);
  }, "image/png");
}
