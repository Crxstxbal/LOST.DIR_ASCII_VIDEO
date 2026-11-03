import { beforeAll, describe, expect, it } from 'vitest';
import { useNodeCanvas } from '../scripts/nodeCanvas';
import { FRAMINGS, FRAMING_T, framingProject } from '../scripts/lodFramings';
import { renderFrame, resetRuntimes, gridFor } from '../src/engine/render';
import { CAMERA_PRESETS, defaultProject, type CameraType } from '../src/engine/project/schema';
import { parseProject, serializeProject } from '../src/engine/project/ProjectIO';
import { computeLod, LOD_LEVELS, type LodWeights } from '../src/engine/character/lod';

useNodeCanvas();
beforeAll(() => useNodeCanvas());

const W = 960;
const H = 540;

/** Cells whose pixels change when the actor is drawn vs. hidden (same scene logic). */
function silhouette(r: { data: Uint8ClampedArray; cols: number; rows: number }, hidden: Uint8ClampedArray) {
  const cw = W / r.cols;
  const ch = H / r.rows;
  const hit = new Uint8Array(r.cols * r.rows);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.abs(r.data[i] - hidden[i]) + Math.abs(r.data[i + 1] - hidden[i + 1]) + Math.abs(r.data[i + 2] - hidden[i + 2]);
      if (d > 60) hit[Math.min(r.rows - 1, Math.floor(y / ch)) * r.cols + Math.min(r.cols - 1, Math.floor(x / cw))] = 1;
    }
  let n = 0;
  let c0 = Infinity;
  let c1 = -1;
  let r0 = Infinity;
  let r1 = -1;
  for (let rr = 0; rr < r.rows; rr++)
    for (let c = 0; c < r.cols; c++)
      if (hit[rr * r.cols + c]) {
        n++;
        c0 = Math.min(c0, c);
        c1 = Math.max(c1, c);
        r0 = Math.min(r0, rr);
        r1 = Math.max(r1, rr);
      }
  return { cells: n, w: c1 - c0 + 1, h: r1 - r0 + 1 };
}

describe('global ASCII resolution', () => {
  const expected = gridFor(defaultProject().output.cols, W, H);

  it('the five framings use the same grid and the same character size; LOD follows the framing', () => {
    const levels: string[] = [];
    for (const F of FRAMINGS) {
      resetRuntimes();
      const r = renderFrame(framingProject(F.camera), 0, FRAMING_T, { width: W, height: H });
      expect(r.cols).toBe(expected.cols);
      expect(r.rows).toBe(expected.rows);
      expect(W / r.cols).toBeCloseTo(W / expected.cols, 9);
      levels.push(r.lod!.level);
    }
    expect(levels).toEqual(['ecu', 'cu', 'ms', 'ws', 'xws']);
  });

  it('camera type, distance and zoom never change the global resolution', () => {
    for (const type of Object.keys(CAMERA_PRESETS) as CameraType[]) {
      for (const zoom of [0.6, 1, 2.5]) {
        const p = framingProject({ type, ...CAMERA_PRESETS[type], zoom });
        const r = renderFrame(p, 0, 1, { width: W, height: H });
        expect([r.cols, r.rows]).toEqual([expected.cols, expected.rows]);
      }
    }
  });

  it('changing the project resolution changes every shot (and nothing else does)', () => {
    const p = defaultProject();
    p.output.cols = 160;
    for (let i = 0; i < p.shots.length; i++) {
      const r = renderFrame(p, i, 1, { width: W, height: H });
      expect([r.cols, r.rows]).toEqual([160, 50]);
    }
  });
});

describe('character silhouette at every framing', () => {
  for (const F of FRAMINGS) {
    it(`${F.label}: the protagonist is visible and reads as a figure`, () => {
      resetRuntimes();
      const p = framingProject(F.camera);
      const shown = renderFrame(p, 0, FRAMING_T, { width: W, height: H });
      const hidden = renderFrame(p, 0, FRAMING_T, { width: W, height: H, hideActor: true }).data;
      const s = silhouette(shown, hidden);
      // even the extreme wide shot keeps a coherent figure of several cells
      expect(s.cells).toBeGreaterThanOrEqual(F.id === 'xws' ? 6 : 40);
      // full-figure framings: taller than wide (a standing cloaked figure)
      if (F.id === 'ws' || F.id === 'xws') expect(s.h).toBeGreaterThan(s.w);
    });
  }
});

describe('adaptive LOD', () => {
  const keys = ['relief', 'features', 'bangs', 'locks', 'fineHair', 'folds', 'hem', 'silhouette', 'ecu'] as (keyof LodWeights)[];

  it('a continuous zoom never makes detail jump (every weight changes smoothly)', () => {
    let prev = computeLod(0.3, true).w;
    // 0.3 → 150 rows in 2% steps (a slow dolly from extreme wide to extreme close-up)
    for (let r = 0.3; r < 150; r *= 1.02) {
      const w = computeLod(r, true).w;
      for (const k of keys) {
        const range = k === 'locks' ? 3 : 1;
        expect(Math.abs(w[k] - prev[k]) / range).toBeLessThan(0.08);
      }
      prev = w;
    }
  });

  it('detail grows with projected size and levels are ordered', () => {
    const small = computeLod(1, true).w;
    const big = computeLod(100, true).w;
    expect(small.features).toBe(0);
    expect(big.features).toBe(1);
    expect(small.silhouette).toBeGreaterThan(0.9);
    expect(big.silhouette).toBe(0);
    const mins = LOD_LEVELS.map((l) => l.minRows);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });

  it('LOD disabled = full detail at any size', () => {
    expect(computeLod(1, false).w.features).toBe(1);
    expect(computeLod(1, false).w.silhouette).toBe(0);
  });

  it('LOD is deterministic under scrubbing (smoothing uses pure functions, not history)', () => {
    const p = framingProject(FRAMINGS[2].camera);
    resetRuntimes();
    const a = renderFrame(p, 0, 2.5, { width: W, height: H }).lod!;
    renderFrame(p, 0, 0.4, { width: W, height: H });
    const b = renderFrame(p, 0, 2.5, { width: W, height: H }).lod!;
    expect(b).toEqual(a);
  });
});

describe('project compatibility', () => {
  it('a version-1 project (per-shot ASCII) loads: resolution becomes global, glyph tweaks become overrides', () => {
    const p = defaultProject() as any;
    delete p.output;
    p.version = 1;
    p.shots[0].ascii = { cols: 240, charset: 'cine', dither: true, bgGlow: 0.16, glyphGain: 2.1 };
    p.shots[1].ascii = { cols: 450, charset: 'cine', dither: true, bgGlow: 0.16, glyphGain: 1.5 };
    const q = parseProject(JSON.stringify(p));
    expect(q.version).toBe(4);
    expect(q.output.cols).toBe(240);
    expect(q.shots[0].asciiOverride).toBeUndefined();
    expect(q.shots[1].asciiOverride).toEqual({ glyphGain: 1.5 });
    expect((q.shots[1] as any).ascii).toBeUndefined();
    // and it round-trips
    expect(parseProject(serializeProject(q))).toEqual(q);
  });
});
