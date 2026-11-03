import { LOSTDIR_PALETTE, type Palette } from '../core/color';
import { DEFAULT_GRADE, type GradeKey, type GradeParams } from '../grading/ColorGrade';
import type { FaceParams } from '../character/face';
import type { GaitParams } from '../animation/locomotion';

export type CameraType = 'side' | 'front' | 'elevated' | 'closeup' | 'wide' | 'overhead';

export type RendererId = 'legacy' | 'hybrid';

export interface CameraParams {
  type: CameraType;
  /** Distance from the camera to the subject (m). */
  distance: number;
  /** Camera height above ground (m). */
  height: number;
  /** Horizon position on screen, 0 = top, 1 = bottom. */
  horizon: number;
  /** Focal multiplier. */
  zoom: number;
  /** Lateral framing offset (m) – puts the subject off-centre. */
  offsetX: number;
  /** 0 = locked-off camera, 1 = tight follow. */
  follow: number;
  /** Camera travel over the whole shot (m): pan/track. */
  moveX: number;
  /** Vertical travel over the shot (m): crane. */
  moveY: number;
  /** Zoom multiplier reached at the end of the shot (1 = none). */
  zoomTo: number;
  /**
   * HYBRID only: extra aim (radians). yaw turns the camera, pitch adds to the
   * horizon-derived pitch (for 'overhead' it is the absolute pitch; default ≈ 85°).
   * The LEGACY renderer has no yaw and ignores this.
   */
  aim?: { yaw?: number; pitch?: number };
}

export type Heading = 'right' | 'left' | 'toward' | 'away';
export type LookTarget = 'forward' | 'down' | 'up' | 'back' | 'camera' | 'tilt';

export interface ActorAction {
  t: number;
  type: 'walk' | 'stop' | 'look';
  speed?: number;
  look?: LookTarget;
}

export interface ActorParams {
  character: string;
  heading: Heading;
  /** Initial position along the walking axis (m). */
  start: number;
  /** Lateral (side view: depth) placement (m). */
  lane: number;
  /** If true the actor is already walking at t=0 (else starts from rest). */
  startWalking: boolean;
  speed: number;
  actions: ActorAction[];
  /**
   * Effective walk parameters, filled in by the engine from the character's global
   * look (project.characters). Not stored per shot.
   */
  gait?: Partial<GaitParams>;
}

/**
 * Global look of a character for the whole project: face, hair, collar and walk
 * style. It applies to every shot the character appears in (on top of the base
 * look in data/characters/<id>.json). Shots only hold placement and actions.
 */
export interface CharacterLook {
  face?: Partial<FaceParams>;
  gait?: Partial<GaitParams>;
}

export interface WindParams {
  strength: number;
  /** +1 blows toward +x (screen right in side view), -1 toward -x. */
  direction: number;
  gust: number;
}

/** Global resolution presets: columns × rows of the ASCII grid at 16:9. */
export const RESOLUTION_PRESETS = [
  { cols: 160, label: '160 × 50 · gruesa' },
  { cols: 240, label: '240 × 74 · media' },
  { cols: 360, label: '360 × 111 · fina' },
  { cols: 480, label: '480 × 149 · muy fina' },
] as const;

import type { PreviewProfileId } from './profiles';
export type PreviewQuality = PreviewProfileId;

/**
 * Project-wide ASCII output. The grid (and so the visual size of each character)
 * belongs to the project: every shot and camera renders on the same grid.
 */
export interface AsciiOutput {
  /** Columns of the global grid (rows follow from the 16:9 frame and the cell aspect). */
  cols: number;
  /** Glyph palette (charset id). */
  charset: string;
  /** Multiplier on glyph ink (how dense the characters are). */
  density: number;
  /** Contrast of glyph density. */
  contrast: number;
  /** Local contrast inside each cell: favours edge/shape glyphs over flat ramp ones. */
  sharpness: number;
  /** Ink brightness of glyphs. */
  glyphGain: number;
  dither: boolean;
  bgGlow: number;
  /** Adaptive level of detail for characters (by projected size). */
  autoLod: boolean;
  /** Preview profile (PERFORMANCE / BALANCED / QUALITY). Export is independent of it. */
  preview: PreviewQuality;
  /** Export/capture pixel scale over 1920×1080 (same grid, larger glyphs). */
  exportScale: 1 | 1.5 | 2;
  /** HYBRID renderer effect intensities (ignored by LEGACY). */
  hybrid: HybridFx;
}

/** Complementary effects of the HYBRID renderer; they never replace the ASCII structure. */
export interface HybridFx {
  /** free world-anchored glyphs for vegetation/particles (0 = grid only) */
  strokes: number;
  bloom: number;
  fog: number;
  shadows: number;
  ambient: number;
}

export const DEFAULT_HYBRID_FX: HybridFx = { strokes: 1, bloom: 0.35, fog: 1, shadows: 0.85, ambient: 1 };

export const DEFAULT_OUTPUT: AsciiOutput = {
  cols: 360,
  charset: 'cine',
  density: 1,
  contrast: 1,
  sharpness: 0,
  glyphGain: 2.1,
  dither: true,
  bgGlow: 0.16,
  autoLod: true,
  preview: 'balanced',
  exportScale: 1,
  hybrid: { ...DEFAULT_HYBRID_FX },
};

/** Advanced, explicit per-shot ASCII modifications. Resolution is never per shot. */
export type AsciiOverride = Partial<Pick<AsciiOutput, 'charset' | 'density' | 'contrast' | 'sharpness' | 'glyphGain' | 'dither' | 'bgGlow'>>;
export const OVERRIDE_KEYS = ['charset', 'density', 'contrast', 'sharpness', 'glyphGain', 'dither', 'bgGlow'] as const;

/** Effective ASCII settings for a shot: the project output plus the shot's explicit overrides. */
export function resolveAscii(project: Project, shot: Shot): AsciiOutput {
  return { ...DEFAULT_OUTPUT, ...project.output, ...(shot.asciiOverride ?? {}) };
}

export interface EffectsParams {
  grain: number;
  vignette: number;
  scanlines: number;
  glitch: number;
  particles: boolean;
  particleDensity: number;
  meteors: boolean;
  fogBands: boolean;
}

export interface Transition {
  type: 'cut' | 'fade';
  duration: number;
}

export interface Shot {
  id: string;
  name: string;
  location: string;
  duration: number;
  transitionIn: Transition;
  camera: CameraParams;
  actor: ActorParams | null;
  wind: WindParams;
  grade: GradeParams;
  gradeKeys: GradeKey[];
  effects: EffectsParams;
  /** Advanced: explicit per-shot ASCII modifications (absent = inherit the project output). */
  asciiOverride?: AsciiOverride;
  /** Which renderer draws this shot (absent = 'legacy'). */
  renderer?: RendererId;
  /** Overrides for the location's own parameters. */
  locationParams: Record<string, number | string | boolean>;
}

export interface Project {
  format: 'lostdir-ascii-cinema';
  version: 4;
  name: string;
  seed: number;
  fps: 24 | 30;
  width: number;
  height: number;
  palette: Palette;
  /** Global ASCII output (resolution, glyphs, LOD, preview/export quality). */
  output: AsciiOutput;
  /** Global look per character id (face, hair, walk). */
  characters: Record<string, CharacterLook>;
  shots: Shot[];
}

export const CAMERA_PRESETS: Record<CameraType, Omit<CameraParams, 'type'>> = {
  side: { distance: 6.2, height: 1.2, horizon: 0.55, zoom: 1, offsetX: 0, follow: 0.85, moveX: 0, moveY: 0, zoomTo: 1 },
  front: { distance: 12, height: 1.4, horizon: 0.5, zoom: 1, offsetX: 0, follow: 0, moveX: 0, moveY: 0, zoomTo: 1 },
  elevated: { distance: 14, height: 6, horizon: 0.12, zoom: 1, offsetX: 0, follow: 0.8, moveX: 0, moveY: 0, zoomTo: 1 },
  closeup: { distance: 1.0, height: 1.53, horizon: 0.5, zoom: 1.6, offsetX: -0.09, follow: 1, moveX: 0, moveY: 0, zoomTo: 1 },
  wide: { distance: 70, height: 16, horizon: 0.34, zoom: 1, offsetX: 0, follow: 0.4, moveX: 0, moveY: 0, zoomTo: 1 },
  // true top-down only in HYBRID; LEGACY approximates it as a very steep elevated view
  overhead: { distance: 3, height: 14, horizon: -1.6, zoom: 1, offsetX: 0, follow: 0.9, moveX: 0, moveY: 0, zoomTo: 1 },
};

export const DEFAULT_EFFECTS: EffectsParams = {
  grain: 0.35,
  vignette: 0.55,
  scanlines: 0.15,
  glitch: 0,
  particles: true,
  particleDensity: 0.5,
  meteors: false,
  fogBands: true,
};

let idCounter = 0;
export function newId(prefix = 'shot'): string {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function makeShot(partial: Partial<Shot> & { location: string; name: string }): Shot {
  const camType = partial.camera?.type ?? 'side';
  return {
    id: partial.id ?? newId(),
    name: partial.name,
    location: partial.location,
    duration: partial.duration ?? 8,
    transitionIn: partial.transitionIn ?? { type: 'cut', duration: 0 },
    camera: { type: camType, ...CAMERA_PRESETS[camType], ...(partial.camera ?? {}) },
    actor:
      partial.actor === null
        ? null
        : {
            character: 'protagonist',
            heading: 'right',
            start: 0,
            lane: 0,
            startWalking: true,
            speed: 0.75,
            actions: [],
            ...(partial.actor ?? {}),
          },
    wind: partial.wind ?? { strength: 0.45, direction: -1, gust: 0.5 },
    grade: { ...DEFAULT_GRADE, ...(partial.grade ?? {}) },
    gradeKeys: partial.gradeKeys ?? [],
    ...(partial.asciiOverride && Object.keys(partial.asciiOverride).length ? { asciiOverride: { ...partial.asciiOverride } } : {}),
    ...(partial.renderer === 'hybrid' ? { renderer: 'hybrid' as const } : {}),
    effects: { ...DEFAULT_EFFECTS, ...(partial.effects ?? {}) },
    locationParams: partial.locationParams ?? {},
  };
}

export function defaultProject(): Project {
  return {
    format: 'lostdir-ascii-cinema',
    version: 4,
    name: 'lostdir_prototipo',
    seed: 1337,
    fps: 24,
    width: 1920,
    height: 1080,
    palette: { ...LOSTDIR_PALETTE },
    output: { ...DEFAULT_OUTPUT },
    characters: { protagonist: {} },
    shots: [
      makeShot({
        id: 'wasteland_lateral',
        name: 'WASTELAND — caminata lateral',
        location: 'wasteland',
        duration: 10,
        camera: { type: 'side' } as CameraParams,
        actor: { start: -2, speed: 0.75, actions: [{ t: 7.2, type: 'stop' }, { t: 8.6, type: 'look', look: 'up' }] } as ActorParams,
        grade: { ...DEFAULT_GRADE, redIntensity: 0.45 },
        gradeKeys: [
          { t: 0, values: { redIntensity: 0.35 } },
          { t: 10, values: { redIntensity: 0.7 } },
        ],
      }),
      makeShot({
        id: 'wasteland_front',
        name: 'WASTELAND — frontal',
        location: 'wasteland',
        duration: 7,
        camera: { type: 'front' } as CameraParams,
        actor: { heading: 'toward', start: 9, speed: 0.75 } as ActorParams,
        transitionIn: { type: 'fade', duration: 0.8 },
      }),
      makeShot({
        id: 'wasteland_elevated',
        name: 'WASTELAND — cámara elevada',
        location: 'wasteland',
        duration: 7,
        camera: { type: 'elevated' } as CameraParams,
        actor: { start: -1.5, speed: 0.7 } as ActorParams,
      }),
      makeShot({
        id: 'rose_lateral',
        name: 'ROSE FIELD — plano A lateral',
        location: 'rose_field',
        duration: 10,
        camera: { type: 'side', distance: 5.2, height: 1.45, horizon: 0.5 } as CameraParams,
        actor: { start: -2, speed: 0.7 } as ActorParams,
        grade: { ...DEFAULT_GRADE, redIntensity: 0.62, paletteAmount: 0.4, saturation: 1.05 },
        transitionIn: { type: 'fade', duration: 1.2 },
      }),
      makeShot({
        id: 'rose_closeup',
        name: 'ROSE FIELD — plano C primer plano',
        location: 'rose_field',
        duration: 7,
        camera: { type: 'closeup' } as CameraParams,
        actor: { start: 0, speed: 0, startWalking: false, actions: [{ t: 3.5, type: 'look', look: 'camera' }] } as ActorParams,
        grade: { ...DEFAULT_GRADE, redIntensity: 0.6, paletteAmount: 0.35 },
      }),
      makeShot({
        id: 'rose_wide',
        name: 'ROSE FIELD — plano D general extremo',
        location: 'rose_field',
        duration: 9,
        camera: { type: 'wide', zoomTo: 0.8 } as CameraParams,
        actor: { start: 0, speed: 0.7 } as ActorParams,
        grade: { ...DEFAULT_GRADE, redIntensity: 0.65, paletteAmount: 0.4 },
      }),
    ],
  };
}
