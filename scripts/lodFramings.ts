import { CAMERA_PRESETS, defaultProject, type CameraParams, type Project } from '../src/engine/project/schema';
import type { LodLevel } from '../src/engine/character/lod';

/**
 * The protagonist (standing still, looking at camera) in five framings, only the
 * camera changes: used by the LOD tests and `npm run lod-sheet`.
 */
export interface Framing {
  id: LodLevel;
  label: string;
  camera: CameraParams;
}

export const FRAMINGS: Framing[] = [
  { id: 'ecu', label: 'Primerísimo primer plano', camera: { type: 'closeup', ...CAMERA_PRESETS.closeup, distance: 0.62, offsetX: -0.05 } },
  { id: 'cu', label: 'Primer plano', camera: { type: 'closeup', ...CAMERA_PRESETS.closeup } },
  { id: 'ms', label: 'Plano medio', camera: { type: 'side', ...CAMERA_PRESETS.side, distance: 2.4, height: 1.45, horizon: 0.5 } },
  { id: 'ws', label: 'Plano general', camera: { type: 'side', ...CAMERA_PRESETS.side, distance: 11, height: 1.4, horizon: 0.55 } },
  { id: 'xws', label: 'Plano general extremo', camera: { type: 'wide', ...CAMERA_PRESETS.wide, distance: 60, height: 9, horizon: 0.3 } },
];

/** A one-shot project: WASTELAND, protagonist at rest turning to the camera. */
export function framingProject(camera: CameraParams, base: Project = defaultProject()): Project {
  const shot = base.shots.find((s) => s.id === 'wasteland_lateral')!;
  return {
    ...base,
    shots: [
      {
        ...shot,
        transitionIn: { type: 'cut', duration: 0 },
        gradeKeys: [],
        camera: { ...camera, follow: 1, moveX: 0, moveY: 0, zoomTo: 1 },
        actor: { ...shot.actor!, start: 0, speed: 0, startWalking: false, actions: [{ t: 0.3, type: 'look', look: 'camera' }] },
      },
    ],
  };
}

export const FRAMING_T = 2.5;
