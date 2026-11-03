import { createCanvas } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/engine/core/canvasFactory';

/** Use @napi-rs/canvas as the engine canvas backend in Node (CLI + tests). */
export function useNodeCanvas() {
  setCanvasFactory((w, h) => createCanvas(w, h) as any);
}

export async function encodePng(data: Uint8ClampedArray, w: number, h: number): Promise<Buffer> {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return c.encode('png');
}
