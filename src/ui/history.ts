import type { Project } from '../engine/project/schema';

/**
 * Edit history (undo / redo) over immutable project snapshots.
 *
 * Every edit replaces the project with a new object that shares all unchanged
 * subtrees, so an entry is just two references (before/after) — cheap, exact, and
 * it covers every kind of edit (camera, colour, character, scene, shots, keys,
 * project settings…) without per-feature command classes. Labels are derived by
 * diffing the two snapshots.
 *
 * Grouping: edits that carry the same merge key are folded into one entry —
 * a whole slider drag (one pointer gesture) or bursts of typing in the same field.
 * Only project edits are recorded: playback, time, preview stats, panel scroll and
 * (later) editor-camera navigation never touch the project, so they never enter it.
 */
export interface HistoryEntry {
  before: Project;
  after: Project;
  label: string;
  key: string | null;
  at: number;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  limit: number;
  /** Typing in the same field within this window becomes one entry. */
  mergeWindowMs = 1200;

  constructor(limit = 200) {
    this.limit = limit;
  }

  record(before: Project, after: Project, key: string | null, now = Date.now()) {
    if (before === after) return;
    const label = describeChange(before, after);
    const top = this.undoStack[this.undoStack.length - 1];
    // a new edit after undo invalidates the redo branch
    this.redoStack = [];
    if (top && key && top.key === key && (key.startsWith('g:') || now - top.at < this.mergeWindowMs)) {
      top.after = after;
      top.at = now;
      // keep the label of the gesture unless the gesture started as a no-op
      if (top.before === top.after) this.undoStack.pop();
      return;
    }
    this.undoStack.push({ before, after, label, key, at: now });
    while (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  setLimit(n: number) {
    this.limit = Math.max(1, Math.round(n));
    while (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  undo(): HistoryEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push(e);
    return e;
  }

  redo(): HistoryEntry | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push(e);
    return e;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  get redoLabel() {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }
  get sizes() {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}

/** Changed leaf paths between two snapshots (shared references are skipped). */
export function diffPaths(a: unknown, b: unknown, path: string[] = [], out: string[][] = [], max = 12): string[][] {
  if (out.length >= max || a === b) return out;
  const oa = a !== null && typeof a === 'object';
  const ob = b !== null && typeof b === 'object';
  // an object that appeared or disappeared: report its fields (e.g. a new face override)
  if (oa !== ob && (a === undefined || b === undefined) && !Array.isArray(a ?? b)) {
    const o = (a ?? b) as object;
    const ks = Object.keys(o);
    if (!ks.length) out.push(path);
    for (const k of ks) diffPaths(a === undefined ? undefined : (a as any)[k], b === undefined ? undefined : (b as any)[k], [...path, k], out, max);
    return out;
  }
  if (!oa || !ob || Array.isArray(a) !== Array.isArray(b)) {
    out.push(path);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
    out.push([...path, '#length']);
    return out;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) diffPaths((a as any)[k], (b as any)[k], [...path, k], out, max);
  return out;
}

const FIELD: Record<string, string> = {
  distance: 'distancia',
  height: 'altura',
  horizon: 'horizonte',
  zoom: 'zoom',
  zoomTo: 'zoom final',
  offsetX: 'desplazamiento',
  follow: 'seguimiento',
  moveX: 'travelling',
  moveY: 'grúa',
  type: 'tipo',
  speed: 'velocidad',
  start: 'posición',
  lane: 'carril',
  heading: 'dirección',
  startWalking: 'inicio caminando',
  duration: 'duración',
  name: 'nombre',
  cols: 'resolución',
  charset: 'glifos',
  density: 'densidad',
  contrast: 'contraste',
  sharpness: 'nitidez',
  preview: 'calidad de vista previa',
  exportScale: 'calidad de exportación',
  autoLod: 'LOD',
  fps: 'fps',
};
const f = (k: string | undefined) => (k ? FIELD[k] ?? k : '');

/** Human label for the change (Spanish UI): "Mover cámara (distancia)", "Crear plano"… */
export function describeChange(a: Project, b: Project): string {
  if (a.shots.length !== b.shots.length) return b.shots.length > a.shots.length ? 'Crear plano' : 'Eliminar plano';
  if (a.shots.some((s, i) => s.id !== b.shots[i].id)) return 'Reordenar planos';
  const paths = diffPaths(a, b);
  if (!paths.length) return 'Cambio';
  const p = paths[0];
  const many = paths.length > 1 && paths.some((q) => q[2] !== p[2]);
  if (p[0] === 'output') return `Salida ASCII (${f(p[1])})`;
  if (p[0] === 'palette') return 'Cambiar paleta';
  if (p[0] === 'characters') {
    const leaf = p.length > 3 ? p[3] : p[2] ?? '';
    return p[2] === 'gait' ? `Caminata (${leaf})` : `Rostro (${leaf})`;
  }
  if (p[0] !== 'shots') return `Proyecto (${f(p[0])})`;
  const area = p[2];
  const leaf = p[p.length - 1];
  switch (area) {
    case 'camera':
      return many ? 'Cambiar cámara' : `Mover cámara (${f(leaf)})`;
    case 'grade':
      return `Cambiar color / iluminación (${leaf})`;
    case 'gradeKeys':
      return 'Fotogramas clave de color';
    case 'actor': {
      const i = Number(p[1]);
      if (!a.shots[i].actor !== !b.shots[i].actor) return b.shots[i].actor ? 'Añadir personaje' : 'Quitar personaje';
      if (p[3] === 'face') return `Rostro (${leaf})`;
      if (p[3] === 'gait') return `Caminata (${leaf})`;
      if (p[3] === 'actions') return 'Acciones del personaje';
      return `Personaje (${f(p[3])})`;
    }
    case 'wind':
      return 'Viento del escenario';
    case 'location':
      return 'Cambiar escenario';
    case 'locationParams':
      return `Escenario (${leaf})`;
    case 'effects':
      return `Efectos (${leaf})`;
    case 'asciiOverride':
      return 'ASCII del plano';
    case 'transitionIn':
      return 'Transición';
    default:
      return `Plano (${f(area)})`;
  }
}
