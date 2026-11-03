import { LOSTDIR_PALETTE } from '../core/color';
import { DEFAULT_GRADE } from '../grading/ColorGrade';
import {
  CAMERA_PRESETS,
  DEFAULT_EFFECTS,
  DEFAULT_OUTPUT,
  DEFAULT_HYBRID_FX,
  makeShot,
  OVERRIDE_KEYS,
  type AsciiOutput,
  type AsciiOverride,
  type CharacterLook,
  type Project,
  type Shot,
} from './schema';
import { normalizePreview } from './profiles';

/** Serialise a project to stable, human-readable JSON. */
export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}

function num(v: any, d: number) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function sanitizeOutput(o: any, base: AsciiOutput): AsciiOutput {
  const out: AsciiOutput = { ...base, hybrid: { ...(base.hybrid ?? DEFAULT_HYBRID_FX) } };
  if (!o || typeof o !== 'object') return out;
  out.cols = Math.round(Math.min(640, Math.max(80, num(o.cols, base.cols))));
  if (typeof o.charset === 'string') out.charset = o.charset;
  out.density = num(o.density, base.density);
  out.contrast = num(o.contrast, base.contrast);
  out.sharpness = num(o.sharpness, base.sharpness);
  out.glyphGain = num(o.glyphGain, base.glyphGain);
  out.bgGlow = num(o.bgGlow, base.bgGlow);
  if (typeof o.dither === 'boolean') out.dither = o.dither;
  if (typeof o.autoLod === 'boolean') out.autoLod = o.autoLod;
  const pv = normalizePreview(o.preview);
  if (pv) out.preview = pv;
  if (o.exportScale === 1 || o.exportScale === 1.5 || o.exportScale === 2) out.exportScale = o.exportScale;
  out.hybrid = { ...DEFAULT_HYBRID_FX };
  if (o.hybrid && typeof o.hybrid === 'object') for (const k of Object.keys(DEFAULT_HYBRID_FX) as (keyof typeof DEFAULT_HYBRID_FX)[]) out.hybrid[k] = num(o.hybrid[k], DEFAULT_HYBRID_FX[k]);
  return out;
}

/**
 * Version-1 projects stored ASCII settings per shot. Migration: the first shot's
 * settings become the project output (resolution included); any other shot whose
 * glyph settings differ keeps them as an explicit advanced override. Per-shot
 * resolution is dropped on purpose: the grid now belongs to the project.
 */
function migrateV1(raw: any): { output: AsciiOutput; overrides: (AsciiOverride | undefined)[] } {
  const shots: any[] = raw.shots;
  const first = shots.find((s) => s?.ascii)?.ascii;
  const output = sanitizeOutput(first, DEFAULT_OUTPUT);
  const overrides = shots.map((s) => {
    if (!s?.ascii) return undefined;
    const o: AsciiOverride = {};
    for (const k of OVERRIDE_KEYS) {
      const v = s.ascii[k];
      if (v !== undefined && v !== (output as any)[k]) (o as any)[k] = v;
    }
    return Object.keys(o).length ? o : undefined;
  });
  return { output, overrides };
}

/** Parse + validate + fill defaults. Throws with a readable message on invalid input. */
export function parseProject(text: string): Project {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error('El archivo no es JSON válido.');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Proyecto vacío.');
  if (raw.format !== 'lostdir-ascii-cinema') throw new Error('No es un proyecto LOST.DIR — ASCII CINEMA (campo "format").');
  if (!Array.isArray(raw.shots) || raw.shots.length === 0) throw new Error('El proyecto no tiene planos.');
  const characters = migrateLooks(raw);
  const legacy = raw.output === undefined;
  const mig = legacy ? migrateV1(raw) : null;
  const output = mig ? mig.output : sanitizeOutput(raw.output, DEFAULT_OUTPUT);
  const shots: Shot[] = raw.shots.map((s0: any, i: number) => {
    let s = s0;
    if (!s || typeof s.location !== 'string') throw new Error(`Plano ${i + 1}: falta "location".`);
    // looks are global now: per-shot face/gait (older files) were moved to `characters`
    if (s.actor && typeof s.actor === 'object') {
      s = { ...s, actor: { ...s.actor } };
      delete s.actor.face;
      delete s.actor.gait;
    }
    const camType = CAMERA_PRESETS[s.camera?.type as keyof typeof CAMERA_PRESETS] ? s.camera.type : 'side';
    return makeShot({
      ...s,
      name: String(s.name ?? `Plano ${i + 1}`),
      duration: Math.max(0.5, num(s.duration, 8)),
      camera: { type: camType, ...CAMERA_PRESETS[camType as keyof typeof CAMERA_PRESETS], ...(s.camera ?? {}) },
      grade: { ...DEFAULT_GRADE, ...(s.grade ?? {}) },
      effects: { ...DEFAULT_EFFECTS, ...(s.effects ?? {}) },
      gradeKeys: Array.isArray(s.gradeKeys) ? s.gradeKeys : [],
      asciiOverride: mig ? mig.overrides[i] : s.asciiOverride && typeof s.asciiOverride === 'object' ? pickOverride(s.asciiOverride) : undefined,
    });
  });
  return {
    format: 'lostdir-ascii-cinema',
    version: 4,
    name: String(raw.name ?? 'proyecto'),
    seed: num(raw.seed, 1337) >>> 0,
    fps: raw.fps === 30 ? 30 : 24,
    width: Math.round(num(raw.width, 1920)),
    height: Math.round(num(raw.height, 1080)),
    palette: { ...LOSTDIR_PALETTE, ...(raw.palette ?? {}) },
    output,
    characters,
    shots,
  };
}

function pickOverride(o: any): AsciiOverride | undefined {
  const r: AsciiOverride = {};
  for (const k of OVERRIDE_KEYS) if (o[k] !== undefined) (r as any)[k] = o[k];
  return Object.keys(r).length ? r : undefined;
}

const LOOK_KEYS = ['face', 'gait'] as const;
const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Global character looks. Files before version 3 kept face/gait per shot: the first
 * shot of each character that has them defines the character's global look.
 */
function migrateLooks(raw: any): Record<string, CharacterLook> {
  const out: Record<string, CharacterLook> = {};
  if (isObj(raw.characters)) {
    for (const [id, l] of Object.entries<any>(raw.characters)) {
      if (!isObj(l)) continue;
      const look: CharacterLook = {};
      for (const k of LOOK_KEYS) if (isObj(l[k])) (look as any)[k] = { ...l[k] };
      out[id] = look;
    }
  } else {
    for (const s of raw.shots as any[]) {
      const a = s?.actor;
      if (!isObj(a)) continue;
      const id = typeof a.character === 'string' ? a.character : 'protagonist';
      const look = (out[id] ??= {});
      for (const k of LOOK_KEYS) if (isObj(a[k]) && Object.keys(a[k]).length && !(look as any)[k]) (look as any)[k] = { ...a[k] };
    }
  }
  if (!out.protagonist) out.protagonist = {};
  return out;
}
