import { LOSTDIR_PALETTE } from '../core/color';
import { DEFAULT_GRADE } from '../grading/ColorGrade';
import { DEFAULT_OUTPUT, makeShot, type ActorParams, type CameraParams, type Project } from './schema';

/**
 * "RED FIELD — HYBRID TEST": a separate template project (the example project is
 * untouched). Five shots rendered by the HYBRID renderer, sharing one timeline.
 */
export function redFieldProject(): Project {
  const grade = (red: number, extra: Partial<typeof DEFAULT_GRADE> = {}) => ({ ...DEFAULT_GRADE, redIntensity: red, paletteAmount: 0.35, ...extra });
  const common = { location: 'red_field', renderer: 'hybrid' as const };
  return {
    format: 'lostdir-ascii-cinema',
    version: 4,
    name: 'red_field_hybrid_test',
    seed: 2077,
    fps: 24,
    width: 1920,
    height: 1080,
    palette: { ...LOSTDIR_PALETTE },
    output: { ...DEFAULT_OUTPUT },
    characters: { protagonist: {} },
    shots: [
      makeShot({
        ...common,
        id: 'rf_01_extreme_wide',
        name: 'SHOT 01 — plano general extremo del campo',
        duration: 8,
        transitionIn: { type: 'fade', duration: 1.5 },
        camera: { type: 'wide', distance: 58, height: 13, horizon: 0.36, follow: 0.3, zoomTo: 1.12 } as CameraParams,
        actor: { start: -4, speed: 0.7 } as ActorParams,
        grade: grade(0.62),
      }),
      makeShot({
        ...common,
        id: 'rf_02_tracking',
        name: 'SHOT 02 — travelling lateral',
        duration: 9,
        camera: { type: 'side', distance: 5.4, height: 1.3, horizon: 0.52, follow: 0.95 } as CameraParams,
        actor: { start: 0, speed: 0.75 } as ActorParams,
        grade: grade(0.6),
      }),
      makeShot({
        ...common,
        id: 'rf_03_vegetation',
        name: 'SHOT 03 — detalle: las rosas se apartan a su paso',
        duration: 8,
        camera: { type: 'side', distance: 2.3, height: 0.5, horizon: 0.6, follow: 0, offsetX: 3.6 } as CameraParams,
        actor: { start: -4, speed: 0.8 } as ActorParams,
        grade: grade(0.62, { contrast: 1.1 }),
      }),
      makeShot({
        ...common,
        id: 'rf_04_face',
        name: 'SHOT 04 — primer plano del rostro',
        duration: 6,
        camera: { type: 'closeup' } as CameraParams,
        actor: { start: 0, speed: 0, startWalking: false, actions: [{ t: 2, type: 'look', look: 'camera' }] } as ActorParams,
        grade: grade(0.58),
      }),
      makeShot({
        ...common,
        id: 'rf_05_overhead',
        name: 'SHOT 05 — cenital ascendente',
        duration: 8,
        transitionIn: { type: 'fade', duration: 0.8 },
        camera: { type: 'overhead', height: 5, moveY: 16, follow: 0.9, zoom: 1, distance: 3 } as CameraParams,
        actor: { start: 2, speed: 0.7 } as ActorParams,
        grade: grade(0.64),
      }),
    ],
  };
}
