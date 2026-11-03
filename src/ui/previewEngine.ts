import type { Project, RendererId } from '../engine/project/schema';
import { PREVIEW_PROFILES } from '../engine/project/profiles';
import { projectDuration, shotAt } from '../engine/render';
import { RenderClient, type Frame } from './renderClient';

/**
 * Preview renderer, kept outside React state.
 *
 * - A pool of render workers. Frames are deterministic and independent, so during
 *   playback several workers render different frames at the same time (frame k on
 *   worker k mod N); the picture is identical to a single worker.
 * - Playback has its own clock (requestAnimationFrame): it requests upcoming frames,
 *   draws the newest frame that is due and drops late ones. React only receives a
 *   throttled time (~12 Hz) for the timecode and the timeline.
 * - While paused, edits and scrubbing render "latest wins" on one worker.
 */
export interface PreviewStats {
  /** Average worker render time (ms). */
  renderMs: number;
  /** Frames actually drawn on screen in the last second. */
  fps: number;
  /** Frames that arrived too late and were skipped (last second). */
  dropped: number;
  /** Main-thread cost of putting a frame on the canvas (ms). */
  drawMs: number;
  workers: number;
  cols: number;
  rows: number;
  lod: string | null;
  /** Latest per-stage breakdown (when enabled). */
  profile: Record<string, number> | null;
  /** Renderer of the last frame and its counters. */
  renderer: RendererId;
  rstats: Record<string, number> | null;
}

interface PlayState {
  startWall: number;
  startTime: number;
  loopShot: boolean;
  /** frame counter → playback time it represents */
  next: number;
  ready: Map<number, Frame>;
  inflight: Set<number>;
  lastDrawn: number;
  raf: number;
  lastUiPush: number;
}

export class PreviewEngine {
  private clients: RenderClient[];
  private project: Project | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private play: PlayState | null = null;
  private pendingStill: number | null = null;
  private stillBusy = false;
  private drawTimes: number[] = [];
  private dropTimes: number[] = [];
  private renderMs: number[] = [];
  private drawMsAvg = 0;
  private last: Pick<PreviewStats, 'cols' | 'rows' | 'lod' | 'renderer' | 'rstats'> = { cols: 0, rows: 0, lod: null, renderer: 'legacy', rstats: null };
  private lastProfile: Record<string, number> | null = null;
  profiling = false;
  /** Forced renderer (comparator / selector); undefined = each shot's own renderer. */
  renderer: RendererId | undefined = undefined;
  onTime: ((t: number) => void) | null = null;
  onStats: ((s: PreviewStats) => void) | null = null;
  onError: ((e: Error) => void) | null = null;

  constructor(workers = PreviewEngine.defaultWorkers()) {
    this.clients = Array.from({ length: workers }, () => new RenderClient());
  }

  static defaultWorkers() {
    const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    // leave two cores for the UI thread and the browser; more than 6 gives no measurable gain here
    return Math.max(1, Math.min(6, hc - 2));
  }

  get workers() {
    return this.clients.length;
  }

  attach(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
  }

  setProject(p: Project, reset = false) {
    this.project = p;
    for (const c of this.clients) c.setProject(p, reset);
  }

  private profile() {
    const p = this.project!;
    return PREVIEW_PROFILES[p.output.preview] ?? PREVIEW_PROFILES.balanced;
  }

  /** Paused: render the frame at project time T (coalesces bursts: the latest request wins). */
  renderStill(T: number) {
    if (this.play || !this.project) return;
    if (this.stillBusy) {
      this.pendingStill = T;
      return;
    }
    this.stillBusy = true;
    const p = this.project;
    const a = shotAt(p, T);
    const Q = this.profile();
    this.clients[0]
      .render(a.index, a.t, Q.w, Q.h, Q.cols, this.profiling, this.renderer)
      .then((f) => {
        if (!this.play) this.draw(f);
      })
      .catch((e) => this.onError?.(e))
      .finally(() => {
        this.stillBusy = false;
        if (this.pendingStill !== null) {
          const n = this.pendingStill;
          this.pendingStill = null;
          this.renderStill(n);
        }
      });
  }

  get playing() {
    return !!this.play;
  }

  /** Start playback from project time T. */
  start(T: number, loopShot: boolean) {
    this.stop();
    if (!this.project) return;
    const st: PlayState = {
      startWall: performance.now(),
      startTime: T,
      loopShot,
      next: 0,
      ready: new Map(),
      inflight: new Set(),
      lastDrawn: -1,
      raf: 0,
      lastUiPush: 0,
    };
    this.play = st;
    const tick = () => {
      if (this.play !== st) return;
      this.pump(st);
      st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
  }

  stop(): number | null {
    const st = this.play;
    if (!st) return null;
    cancelAnimationFrame(st.raf);
    this.play = null;
    return this.timeOf(st, st.lastDrawn >= 0 ? st.lastDrawn : 0);
  }

  /** Playback time of frame counter k (wrapping at the end or within the shot). */
  private timeOf(st: PlayState, k: number) {
    const p = this.project!;
    let T = st.startTime + k / p.fps;
    if (st.loopShot) {
      const a = shotAt(p, st.startTime);
      const d = p.shots[a.index].duration;
      T = a.start + ((T - a.start) % d);
    } else {
      const tot = projectDuration(p);
      T = T % tot;
    }
    return T;
  }

  private pump(st: PlayState) {
    const p = this.project!;
    const now = performance.now();
    const due = Math.floor(((now - st.startWall) / 1000) * p.fps);
    // keep every worker busy with upcoming frames (skip frames that are already late)
    if (st.next < due) st.next = due;
    const Q = this.profile();
    for (const [wi, c] of this.clients.entries()) {
      if (c.busy) continue;
      const k = st.next++;
      st.inflight.add(k);
      const T = this.timeOf(st, k);
      const a = shotAt(p, T);
      const prof = this.profiling && wi === 0;
      c.render(a.index, a.t, Q.w, Q.h, Q.cols, prof, this.renderer)
        .then((f) => {
          st.inflight.delete(k);
          if (this.play !== st) return;
          st.ready.set(k, f);
        })
        .catch((e) => this.onError?.(e));
    }
    // draw the newest ready frame that is due; frames older than it are dropped
    let best = -1;
    for (const k of st.ready.keys()) if (k <= due && k > best) best = k;
    if (best > st.lastDrawn) {
      for (const k of [...st.ready.keys()]) {
        if (k < best) {
          st.ready.delete(k);
          if (k > st.lastDrawn) this.dropTimes.push(now);
        }
      }
      const f = st.ready.get(best)!;
      st.ready.delete(best);
      st.lastDrawn = best;
      this.draw(f);
    }
    if (now - st.lastUiPush > 80) {
      st.lastUiPush = now;
      this.onTime?.(this.timeOf(st, Math.max(0, st.lastDrawn)));
    }
  }

  private draw(f: Frame) {
    const c = this.canvas;
    if (!c) return;
    const t0 = performance.now();
    if (c.width !== f.width || c.height !== f.height) {
      c.width = f.width;
      c.height = f.height;
    }
    c.getContext("2d")!.putImageData(new ImageData(f.data as Uint8ClampedArray<ArrayBuffer>, f.width, f.height), 0, 0);
    const t1 = performance.now();
    this.drawMsAvg = this.drawMsAvg * 0.8 + (t1 - t0) * 0.2;
    this.drawTimes.push(t1);
    this.renderMs.push(f.ms);
    if (this.renderMs.length > 24) this.renderMs.shift();
    this.last = { cols: f.cols, rows: f.rows, lod: f.lod, renderer: f.renderer ?? 'legacy', rstats: f.stats ?? null };
    if (f.profile) this.lastProfile = f.profile;
    this.emitStats(t1);
  }

  private lastStatsPush = 0;
  private emitStats(now: number) {
    this.drawTimes = this.drawTimes.filter((x) => now - x < 1000);
    this.dropTimes = this.dropTimes.filter((x) => now - x < 1000);
    if (now - this.lastStatsPush < 250 && this.play) return;
    this.lastStatsPush = now;
    const avg = this.renderMs.reduce((a, b) => a + b, 0) / Math.max(1, this.renderMs.length);
    this.onStats?.({
      renderMs: avg,
      fps: this.drawTimes.length,
      dropped: this.dropTimes.length,
      drawMs: this.drawMsAvg,
      workers: this.clients.length,
      ...this.last,
      profile: this.profiling ? this.lastProfile : null,
    });
  }
}
