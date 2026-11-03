import { describe, expect, it } from 'vitest';
import { History, describeChange } from '../src/ui/history';
import { defaultProject, makeShot, type Project } from '../src/engine/project/schema';

const setCam = (p: Project, distance: number): Project => ({
  ...p,
  shots: p.shots.map((s, i) => (i === 0 ? { ...s, camera: { ...s.camera, distance } } : s)),
});

describe('undo / redo history', () => {
  it('undo returns the previous state, redo the next one', () => {
    const h = new History();
    const a = defaultProject();
    const b = setCam(a, 5);
    const c = setCam(b, 4);
    h.record(a, b, 'p:x', 0);
    h.record(b, c, 'p:y', 5000);
    expect(h.undo()!.before).toBe(b);
    expect(h.undo()!.before).toBe(a);
    expect(h.undo()).toBeNull();
    expect(h.redo()!.after).toBe(b);
    expect(h.redo()!.after).toBe(c);
    expect(h.redo()).toBeNull();
  });

  it('a whole slider drag (one gesture key) is a single entry', () => {
    const h = new History();
    let p = defaultProject();
    const start = p;
    for (let d = 6; d > 2; d -= 0.1) {
      const n = setCam(p, d);
      h.record(p, n, 'g:7', 0);
      p = n;
    }
    expect(h.sizes.undo).toBe(1);
    const e = h.undo()!;
    expect(e.before).toBe(start);
    expect(e.after).toBe(p);
  });

  it('typing in one field merges within the window, separate edits do not', () => {
    const h = new History();
    const a = defaultProject();
    const b = setCam(a, 5);
    const c = setCam(b, 4);
    h.record(a, b, 'p:shots.0.camera.distance', 1000);
    h.record(b, c, 'p:shots.0.camera.distance', 1500);
    expect(h.sizes.undo).toBe(1);
    const d = setCam(c, 3);
    h.record(c, d, 'p:shots.0.camera.distance', 9000); // after the window → new entry
    expect(h.sizes.undo).toBe(2);
  });

  it('a new edit after undo invalidates the redo branch', () => {
    const h = new History();
    const a = defaultProject();
    const b = setCam(a, 5);
    h.record(a, b, 'p:x', 0);
    h.undo();
    expect(h.redoLabel).not.toBeNull();
    h.record(a, setCam(a, 9), 'p:x', 10000);
    expect(h.redoLabel).toBeNull();
    expect(h.redo()).toBeNull();
  });

  it('respects the configurable limit', () => {
    const h = new History(3);
    let p = defaultProject();
    for (let i = 0; i < 10; i++) {
      const n = setCam(p, 10 + i);
      h.record(p, n, `p:${i}`, i * 10000);
      p = n;
    }
    expect(h.sizes.undo).toBe(3);
    h.setLimit(1);
    expect(h.sizes.undo).toBe(1);
  });

  it('describes the edit', () => {
    const a = defaultProject();
    expect(describeChange(a, setCam(a, 5))).toBe('Mover cámara (distancia)');
    const lit = { ...a, shots: a.shots.map((s, i) => (i === 0 ? { ...s, grade: { ...s.grade, redIntensity: 0.9 } } : s)) };
    expect(describeChange(a, lit)).toMatch(/^Cambiar color \/ iluminación/);
    expect(describeChange(a, { ...a, shots: [...a.shots, makeShot({ name: 'n', location: 'wasteland' })] })).toBe('Crear plano');
    expect(describeChange(a, { ...a, shots: a.shots.slice(1) })).toBe('Eliminar plano');
    expect(describeChange(a, { ...a, shots: [a.shots[1], a.shots[0], ...a.shots.slice(2)] })).toBe('Reordenar planos');
    expect(describeChange(a, { ...a, output: { ...a.output, cols: 240 } })).toBe('Salida ASCII (resolución)');
    const face = { ...a, characters: { protagonist: { face: { eyeOpen: 0.3 } } } };
    expect(describeChange(a, face)).toBe('Rostro (eyeOpen)');
  });
});

describe('history labels for whole objects', () => {
  it('adding / removing the character', () => {
    const a = defaultProject();
    const none = { ...a, shots: a.shots.map((s, i) => (i === 0 ? { ...s, actor: null } : s)) };
    expect(describeChange(a, none)).toBe('Quitar personaje');
    expect(describeChange(none, a)).toBe('Añadir personaje');
  });
});
