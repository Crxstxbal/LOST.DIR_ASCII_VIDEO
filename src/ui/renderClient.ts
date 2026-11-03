import type { Project, RendererId } from '../engine/project/schema';
import type { WorkerIn, WorkerOut } from './renderWorker';

export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  ms: number;
  cols: number;
  rows: number;
  /** Character LOD label, if a character is on screen. */
  lod: string | null;
  /** Per-stage milliseconds, when requested. */
  profile?: Record<string, number>;
  renderer?: RendererId;
  /** Renderer counters (HYBRID: visible objects, free glyphs, conversion ms…). */
  stats?: Record<string, number>;
}

/** Promise-based wrapper around the render worker. One worker for preview, one for captures. */
export class RenderClient {
  private w: Worker;
  private id = 0;
  private pending = new Map<number, { res: (f: Frame) => void; rej: (e: Error) => void }>();

  constructor() {
    this.w = new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' });
    this.w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'error') p.rej(new Error(m.message));
      else p.res({ width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer), ms: m.ms, cols: m.cols, rows: m.rows, lod: m.lod, profile: m.profile, renderer: m.renderer, stats: m.stats });
    };
  }

  setProject(project: Project, reset = false) {
    const msg: WorkerIn = { type: 'project', project, reset };
    this.w.postMessage(msg);
  }

  render(shotIndex: number, t: number, width: number, height: number, colsScale = 1, profile = false, renderer?: RendererId): Promise<Frame> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      const msg: WorkerIn = { type: 'render', id, shotIndex, t, width, height, colsScale, profile, renderer };
      this.w.postMessage(msg);
    });
  }

  get busy() {
    return this.pending.size > 0;
  }
}
