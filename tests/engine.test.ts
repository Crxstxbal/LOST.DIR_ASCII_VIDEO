import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { useNodeCanvas } from '../scripts/nodeCanvas';
import { renderFrame, getCharacter } from '../src/engine/render';
import { defaultProject, makeShot } from '../src/engine/project/schema';
import { parseProject, serializeProject } from '../src/engine/project/ProjectIO';
import { buildTrack, footAt } from '../src/engine/animation/locomotion';
import { getGlyphSet } from '../src/engine/ascii/GlyphSet';

useNodeCanvas();
beforeAll(() => useNodeCanvas());

const hash = (d: Uint8ClampedArray) => createHash('sha1').update(d).digest('hex');
const SIZE = { width: 480, height: 270 };

describe('determinism', () => {
  it('same project + shot + time → identical pixels', () => {
    const p = defaultProject();
    const a = hash(renderFrame(p, 0, 3.25, SIZE).data);
    const b = hash(renderFrame(p, 0, 3.25, SIZE).data);
    expect(a).toBe(b);
  });

  it('identical after scrubbing forward and backward (cloth/hair sim checkpoints)', () => {
    const p = defaultProject();
    const ref = hash(renderFrame(p, 0, 2.5, SIZE).data);
    renderFrame(p, 0, 7.9, SIZE); // jump ahead
    renderFrame(p, 0, 0.2, SIZE); // jump back
    renderFrame(p, 0, 1.3, SIZE);
    expect(hash(renderFrame(p, 0, 2.5, SIZE).data)).toBe(ref);
  });

  it('a freshly parsed copy of the project renders the same frame', () => {
    const p = defaultProject();
    const q = parseProject(serializeProject(p));
    expect(hash(renderFrame(q, 3, 4, SIZE).data)).toBe(hash(renderFrame(p, 3, 4, SIZE).data));
  });

  it('a frame does not depend on what was rendered before it (no state leaks between renders)', () => {
    const p = defaultProject();
    const a = hash(renderFrame(p, 3, 2, SIZE).data);
    renderFrame(p, 4, 5.5, SIZE); // close-up: other bands, face shader, defocused pass
    renderFrame(p, 0, 1, { width: 640, height: 360 });
    const b = hash(renderFrame(p, 3, 2, SIZE).data);
    expect(b).toBe(a);
  });

  it('different time → different frame (it actually animates)', () => {
    const p = defaultProject();
    expect(hash(renderFrame(p, 0, 1, SIZE).data)).not.toBe(hash(renderFrame(p, 0, 1.5, SIZE).data));
  });
});

describe('walk: feet never slide', () => {
  const def = getCharacter('protagonist');
  const shot = makeShot({ name: 't', location: 'wasteland', duration: 12, actor: { start: 0, speed: 0.75, actions: [{ t: 8, type: 'stop' }] } as any });
  const tr = buildTrack(def, shot.actor!, shot.duration);

  for (const k of [0, 1]) {
    it(`foot ${k}: ankle x constant while flat on the ground`, () => {
      let prev: { x: number; planted: boolean; flat: boolean } | null = null;
      let maxSlide = 0;
      let checked = 0;
      for (let t = 0; t <= 11; t += 1 / 240) {
        const f = footAt(tr, k, t);
        const flat = f.planted && Math.abs(f.angle) < 1e-9;
        if (prev && prev.flat && flat) {
          maxSlide = Math.max(maxSlide, Math.abs(f.ankle.x - prev.x));
          checked++;
        }
        prev = { x: f.ankle.x, planted: f.planted, flat };
      }
      expect(checked).toBeGreaterThan(200);
      expect(maxSlide).toBeLessThan(0.0005); // < 0.5 mm per sample
    });
  }

  it('toe stays fixed during heel-rise, heel stays fixed during heel-strike roll', () => {
    let maxToe = 0;
    let prev: any = null;
    for (let t = 0; t <= 7; t += 1 / 240) {
      const f = footAt(tr, 0, t);
      if (prev && prev.planted && f.planted && prev.angle < 0 && f.angle < 0) maxToe = Math.max(maxToe, Math.abs(f.toe.x - prev.toe.x));
      prev = f;
    }
    expect(maxToe).toBeLessThan(0.0005);
  });

  it('the walker comes to rest after a stop action', () => {
    const late = footAt(tr, 0, 11.5).ankle.x;
    const later = footAt(tr, 0, 11.9).ankle.x;
    expect(Math.abs(late - later)).toBeLessThan(1e-9);
  });
});

describe('glyph shape LUT', () => {
  const g = getGlyphSet('cine');
  const pick = (z: number[]) => g.chars[g.pick(z, 0)];
  it('empty → space', () => expect(pick([0, 0, 0, 0, 0, 0])).toBe(' '));
  it('left column of ink → a vertical stroke glyph', () => expect('|[(!il1{').toContain(pick([1, 0, 1, 0, 1, 0])));
  it('diagonal top-right → bottom-left → "/"-like glyph', () => expect('/(').toContain(pick([0, 1, 0.5, 0.5, 1, 0])));
  it('bottom row of ink → underscore-like glyph', () => expect('_.,').toContain(pick([0, 0, 0, 0, 1, 1])));
  it('full ink → dense glyph', () => expect('@#%&$').toContain(pick([1, 1, 1, 1, 1, 1])));
});

describe('project JSON', () => {
  it('round-trips deeply equal', () => {
    const p = defaultProject();
    expect(parseProject(serializeProject(p))).toEqual(p);
  });
  it('rejects foreign JSON with a readable error', () => {
    expect(() => parseProject('{"a":1}')).toThrow(/LOST\.DIR/);
    expect(() => parseProject('not json')).toThrow(/JSON/);
  });
});

describe('face v2', () => {
  it('invOrient undoes orient for arbitrary head angles', async () => {
    const { orient } = await import('../src/engine/character/head');
    const { invOrient } = await import('../src/engine/character/face');
    for (const o of [
      { yaw: 0.7, pitch: -0.3, tilt: 0.2 },
      { yaw: -2.1, pitch: 0.4, tilt: -0.5 },
    ]) {
      const p: [number, number, number] = [0.03, -0.05, 0.08];
      const q = invOrient(orient(p, o), o);
      for (let i = 0; i < 3; i++) expect(q[i]).toBeCloseTo(p[i], 9);
    }
  });

  it('face parameters change the picture but stay deterministic', () => {
    const p = defaultProject();
    const i = p.shots.findIndex((s) => s.id === 'rose_closeup');
    const base = hash(renderFrame(p, i, 5.5, SIZE).data);
    p.characters = { protagonist: { face: { eyeOpen: 0.3, shadow: 1 } } };
    const a = hash(renderFrame(p, i, 5.5, SIZE).data);
    const b = hash(renderFrame(p, i, 5.5, SIZE).data);
    expect(a).toBe(b);
    expect(a).not.toBe(base);
  });
});

describe('walk v2 (12 key poses)', () => {
  const def = getCharacter('protagonist');
  const mk = (style: 'v1' | 'v2', speed = 0.75) =>
    buildTrack(def, makeShot({ name: 't', location: 'wasteland', duration: 12, actor: { start: 0, speed, actions: [{ t: 8, type: 'stop' }], gait: { style } } as any }).actor!, 12);

  it('the pelvis never jumps (no pop at heel strike), unlike the previous walk', async () => {
    const { computePose } = await import('../src/engine/animation/locomotion');
    const maxJump = (style: 'v1' | 'v2') => {
      const tr = mk(style);
      let prev = computePose(tr, 0.5, 1).hip.y;
      let m = 0;
      for (let t = 0.5; t < 11; t += 1 / 240) {
        const y = computePose(tr, t, 1).hip.y;
        m = Math.max(m, Math.abs(y - prev));
        prev = y;
      }
      return m;
    };
    const v2 = maxJump('v2');
    expect(v2).toBeLessThan(0.0025); // < 2.5 mm between 1/240 s samples
    expect(maxJump('v1')).toBeGreaterThan(v2 * 3); // the old walk did snap
  });

  it('the swinging foot never goes through the ground', () => {
    for (const speed of [0.4, 0.75, 1.3]) {
      const tr = mk('v2', speed);
      for (let t = 0; t < 11; t += 1 / 240)
        for (const k of [0, 1]) {
          const f = footAt(tr, k, t);
          expect(Math.min(f.toe.y, f.heel.y)).toBeGreaterThan(-1e-6);
        }
    }
  });

  it('feet stay planted (no sliding) in v2 at several speeds', () => {
    for (const speed of [0.4, 1.3]) {
      const tr = mk('v2', speed);
      for (const k of [0, 1]) {
        let prev: { x: number; flat: boolean } | null = null;
        let maxSlide = 0;
        for (let t = 0; t <= 11; t += 1 / 240) {
          const f = footAt(tr, k, t);
          const flat = f.planted && Math.abs(f.angle) < 1e-9;
          if (prev && prev.flat && flat) maxSlide = Math.max(maxSlide, Math.abs(f.ankle.x - prev.x));
          prev = { x: f.ankle.x, flat };
        }
        expect(maxSlide).toBeLessThan(1e-9);
      }
    }
  });

  it('the body speed carries weight transfer but keeps the requested mean speed', () => {
    const tr = mk('v2');
    const a = sampleTrackDist(tr, 3);
    const b = sampleTrackDist(tr, 6);
    expect((b - a) / 3).toBeCloseTo(0.75, 1);
  });
});

function sampleTrackDist(tr: any, t: number) {
  const f = (t - tr.t0) * 120;
  return tr.dist[Math.round(f)];
}
