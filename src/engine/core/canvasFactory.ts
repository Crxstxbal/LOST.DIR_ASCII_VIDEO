// The engine never touches the DOM directly. A canvas factory is injected:
// browser → OffscreenCanvas / <canvas>, Node → @napi-rs/canvas.

export type Ctx2D = CanvasRenderingContext2D;

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d', opts?: any): any;
}

export type CanvasFactory = (w: number, h: number) => CanvasLike;

let factory: CanvasFactory | null = null;

export function setCanvasFactory(f: CanvasFactory) {
  factory = f;
}

export function createCanvas(w: number, h: number): CanvasLike {
  if (!factory) {
    if (typeof OffscreenCanvas !== 'undefined') {
      factory = (cw, ch) => new OffscreenCanvas(cw, ch) as unknown as CanvasLike;
    } else if (typeof document !== 'undefined') {
      factory = (cw, ch) => {
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        return c as unknown as CanvasLike;
      };
    } else {
      throw new Error('No canvas factory configured (call setCanvasFactory in Node).');
    }
  }
  return factory(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

export function ctx2d(c: CanvasLike): Ctx2D {
  return c.getContext('2d', { willReadFrequently: true }) as Ctx2D;
}
