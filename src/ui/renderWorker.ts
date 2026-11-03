/// <reference lib="webworker" />
import { renderFrame, resetRuntimes } from '../engine/render';
import type { Project, RendererId } from '../engine/project/schema';
import { LOD_LEVELS } from '../engine/character/lod';

export type WorkerIn =
  | { type: 'project'; project: Project; reset?: boolean }
  | { type: 'render'; id: number; shotIndex: number; t: number; width: number; height: number; colsScale: number; profile?: boolean; renderer?: RendererId };

export type WorkerOut =
  | { type: 'frame'; id: number; width: number; height: number; buffer: ArrayBuffer; ms: number; cols: number; rows: number; lod: string | null; profile?: Record<string, number>; renderer?: RendererId; stats?: Record<string, number> }
  | { type: 'error'; id: number; message: string };

let project: Project | null = null;

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'project') {
    project = msg.project;
    if (msg.reset) resetRuntimes();
    return;
  }
  if (msg.type === 'render') {
    if (!project) return;
    try {
      const t0 = performance.now();
      const profile = msg.profile ? ({} as Record<string, number>) : undefined;
      const r = renderFrame(project, Math.min(msg.shotIndex, project.shots.length - 1), msg.t, {
        width: msg.width,
        height: msg.height,
        colsScale: msg.colsScale,
        profile,
        renderer: msg.renderer,
      });
      const ms = performance.now() - t0;
      const lod = r.lod ? `${LOD_LEVELS.find((l) => l.id === r.lod!.level)?.label} · rostro ${r.lod.faceRows.toFixed(1)} filas` : null;
      const out: WorkerOut = { type: 'frame', id: msg.id, width: r.width, height: r.height, buffer: r.data.buffer as ArrayBuffer, ms, cols: r.cols, rows: r.rows, lod, profile, renderer: r.renderer ?? 'legacy', stats: r.stats };
      (self as unknown as Worker).postMessage(out, [r.data.buffer as ArrayBuffer]);
    } catch (err: any) {
      const out: WorkerOut = { type: 'error', id: msg.id, message: String(err?.stack ?? err) };
      (self as unknown as Worker).postMessage(out);
    }
  }
};
