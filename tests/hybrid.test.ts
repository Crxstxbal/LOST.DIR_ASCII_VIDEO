import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { useNodeCanvas } from '../scripts/nodeCanvas';
import { renderFrame, resetRuntimes, gridFor } from '../src/engine/render';
import { evalCamera } from '../src/engine/camera/Camera';
import { Camera3D } from '../src/engine/hybrid/camera3d';
import { redFieldProject } from '../src/engine/project/templates';
import { defaultProject, CAMERA_PRESETS } from '../src/engine/project/schema';
import { parseProject, serializeProject } from '../src/engine/project/ProjectIO';
import { bendAt } from '../src/engine/hybrid/vegetation';

useNodeCanvas();
beforeAll(() => useNodeCanvas());
const hash = (d: Uint8ClampedArray) => createHash('sha1').update(d).digest('hex');
const SIZE = { width: 640, height: 360 };

describe('Camera3D parity with the LEGACY view', () => {
  it('with yaw 0 it projects exactly like View for every camera type', () => {
    for (const type of ['side', 'front', 'elevated', 'closeup', 'wide'] as const) {
      const v = evalCamera({ type, ...CAMERA_PRESETS[type] }, null, 1, 8, 1920, 1080);
      const c = Camera3D.fromView(v);
      for (const [x, y, z] of [[0, 0, 5], [1.3, 1.7, 9], [-4, 0.2, 30], [10, 5, 120]]) {
        const a = v.project(x, y, z);
        const b = c.project(x, y, z);
        expect(!!a).toBe(!!b);
        if (a && b) {
          expect(b.x).toBeCloseTo(a.x, 9);
          expect(b.y).toBeCloseTo(a.y, 9);
          expect(b.s).toBeCloseTo(a.s, 9);
        }
      }
    }
  });
});

describe('HYBRID renderer', () => {
  const p = redFieldProject();

  it('is deterministic (repeat, after scrubbing, after other renders)', () => {
    resetRuntimes();
    const a = hash(renderFrame(p, 1, 3, SIZE).data);
    renderFrame(p, 1, 0.5, SIZE);
    renderFrame(defaultProject(), 4, 5, SIZE);
    renderFrame(p, 3, 2, SIZE);
    expect(hash(renderFrame(p, 1, 3, SIZE).data)).toBe(a);
  });

  it('every shot uses the global grid, identical to LEGACY for the same shot', () => {
    const g = gridFor(p.output.cols, SIZE.width, SIZE.height);
    for (let i = 0; i < p.shots.length; i++) {
      const h = renderFrame(p, i, 2, SIZE);
      const l = renderFrame(p, i, 2, { ...SIZE, renderer: 'legacy' });
      expect(h.renderer).toBe('hybrid');
      expect([h.cols, h.rows]).toEqual([g.cols, g.rows]);
      expect([l.cols, l.rows]).toEqual([g.cols, g.rows]);
    }
  });

  it('zoom reframes the world but never changes the character size', () => {
    const q = redFieldProject();
    const a = renderFrame(q, 1, 2, SIZE);
    q.shots[1] = { ...q.shots[1], camera: { ...q.shots[1].camera, zoom: 2 } };
    resetRuntimes();
    const b = renderFrame(q, 1, 2, SIZE);
    expect([b.cols, b.rows]).toEqual([a.cols, a.rows]);
    expect(hash(b.data)).not.toBe(hash(a.data));
    expect(b.head!.s / (a.head!.s * 2)).toBeCloseTo(1, 1); // twice the size (± terrain follow)
  });

  it('the vegetation is spatial: many roses and free glyphs in shots 01–03', () => {
    for (const i of [0, 1, 2]) {
      const r = renderFrame(p, i, p.shots[i].duration / 2, SIZE);
      expect(r.stats!.roses).toBeGreaterThan(300);
      expect(r.stats!.strokes).toBeGreaterThan(500);
    }
  });

  it('the protagonist is visible in the HYBRID scene (silhouette difference)', () => {
    for (const i of [1, 2, 3]) {
      resetRuntimes();
      const a = renderFrame(p, i, 3, SIZE).data;
      const b = renderFrame(p, i, 3, { ...SIZE, hideActor: true }).data;
      let changed = 0;
      for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) > 60) changed++;
      expect(changed).toBeGreaterThan(400);
    }
  });

  it('roses bend away from the walker nearby and not far away (local wake)', () => {
    const V = { wind: () => 0, t: 3, trail: [{ x: 0, z: 0 }, { x: -0.2, z: 0 }, { x: -0.4, z: 0 }] };
    const out = { bx: 0, bz: 0 };
    bendAt(V, 0.35, 0, 0.1, 0, out); // just ahead/right of the walker
    const nearB = Math.hypot(out.bx, out.bz);
    expect(out.bx).toBeGreaterThan(0.2); // pushed away (+x)
    bendAt(V, 6, 0, 3, 0, out); // far away: only the tiny idle flutter remains
    expect(Math.hypot(out.bx, out.bz)).toBeLessThan(0.1);
    expect(nearB).toBeGreaterThan(0.3);
  });

  it('free glyphs are temporally stable: consecutive frames keep most glyphs in place', () => {
    resetRuntimes();
    const a = renderFrame(p, 3, 3, SIZE).data; // static close-up, only wind moves the field
    const b = renderFrame(p, 3, 3 + 1 / 24, SIZE).data;
    let diff = 0;
    for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) > 40) diff++;
    expect(diff / (a.length / 4)).toBeLessThan(0.15);
  });

  it('the RED FIELD project saves and loads (round trip), renderer and aim kept', () => {
    const q = redFieldProject();
    q.shots[4].camera.aim = { pitch: 1.4 };
    const r = parseProject(serializeProject(q));
    expect(r).toEqual(parseProject(serializeProject(r)));
    expect(r.shots.every((s) => s.renderer === 'hybrid')).toBe(true);
    expect(r.shots[4].camera.aim).toEqual({ pitch: 1.4 });
    expect(r.version).toBe(4);
  });
});
