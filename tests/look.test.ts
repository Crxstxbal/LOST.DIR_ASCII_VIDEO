import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useNodeCanvas } from '../scripts/nodeCanvas';
import { renderFrame, resolveLook, getCharacter } from '../src/engine/render';
import { defaultProject } from '../src/engine/project/schema';
import { parseProject, serializeProject } from '../src/engine/project/ProjectIO';

useNodeCanvas();
const hash = (d: Uint8ClampedArray) => createHash('sha1').update(d).digest('hex');
const SIZE = { width: 480, height: 270 };

describe('global character look', () => {
  it('the base look comes from the character file (the look tuned by the user)', () => {
    const look = resolveLook(defaultProject(), 'protagonist');
    expect(look.face).toEqual(getCharacter('protagonist').look!.face);
    expect(look.face.eyeOpen).toBe(0.42);
  });

  it('one project-level change applies to every shot with the character', () => {
    const p = defaultProject();
    const q = { ...p, characters: { protagonist: { face: { shadow: 0.1, eyeOpen: 0.9 } } } };
    for (const id of ['rose_closeup', 'rose_lateral']) {
      const i = p.shots.findIndex((s) => s.id === id);
      expect(hash(renderFrame(q, i, 5.5, SIZE).data)).not.toBe(hash(renderFrame(p, i, 5.5, SIZE).data));
    }
  });

  it('the walk style is global too (it rebuilds the locomotion of every shot)', () => {
    const p = defaultProject();
    const q = { ...p, characters: { protagonist: { gait: { style: 'v1' as const } } } };
    expect(hash(renderFrame(q, 0, 3, SIZE).data)).not.toBe(hash(renderFrame(p, 0, 3, SIZE).data));
  });

  it('older files with per-shot face/gait migrate to the global look and lose the per-shot copies', () => {
    const raw: any = JSON.parse(serializeProject(defaultProject()));
    delete raw.characters;
    raw.version = 2;
    raw.shots[3].actor.face = { eyeOpen: 0.2, width: 1.1 };
    raw.shots[4].actor.face = { eyeOpen: 0.9 };
    raw.shots[0].actor.gait = { stride: 1.2 };
    const q = parseProject(JSON.stringify(raw));
    expect(q.version).toBe(3);
    expect(q.characters.protagonist.face).toEqual({ eyeOpen: 0.2, width: 1.1 });
    expect(q.characters.protagonist.gait).toEqual({ stride: 1.2 });
    for (const s of q.shots) {
      expect((s.actor as any)?.face).toBeUndefined();
      expect((s.actor as any)?.gait).toBeUndefined();
    }
    expect(parseProject(serializeProject(q))).toEqual(q);
  });
});
