import type { Vec2 } from '../core/math';
import type { FaceParams } from './face';
import type { GaitParams } from '../animation/locomotion';

export interface CharacterDef {
  id: string;
  name: string;
  height: number;
  proportions: {
    thigh: number;
    shin: number;
    ankleH: number;
    footLen: number;
    heelBack: number;
    spine: number;
    neck: number;
    headR: number;
    shoulderW: number;
    chestDepth: number;
  };
  colors: Record<
    'skin' | 'skinShadow' | 'hair' | 'hairLight' | 'cloak' | 'cloakLight' | 'cloakRim' | 'cross' | 'eyes' | 'lips' | 'boots' | 'trousers',
    string
  >;
  cloak: { length: number; hemLift: number; hemFlare: number; shoulderSpan: number };
  hair: { strands: number; length: number };
  /** Base look of the character (global): face/hair/collar and walk style. */
  look?: { face?: Partial<FaceParams>; gait?: Partial<GaitParams> };
  walk: {
    stepLenBase: number;
    stepLenPerSpeed: number;
    duty: number;
    lift: number;
    bob: number;
    lean: number;
    headDown: number;
    accelTime: number;
  };
}

/** Foot sample in "heading space": u = along walking direction (m), y = up (m). */
export interface FootState {
  ankle: Vec2;
  heel: Vec2;
  toe: Vec2;
  angle: number;
  planted: boolean;
  /** Swing progress 0..1 while the foot is in the air (absent when planted). */
  swing?: number;
}

/**
 * Skeleton pose in heading space (u forward, y up, metres). Front/back views reuse it:
 * u becomes depth toward/away from camera, `sway` is lateral.
 */
export interface Pose {
  t: number;
  u: number;
  speed: number;
  phase: number;
  mode: 'walk' | 'settle' | 'idle';
  hip: Vec2;
  chest: Vec2;
  neck: Vec2;
  head: Vec2;
  lean: number;
  /** Head rotation in the image plane (rad, + = chin up). */
  headPitch: number;
  /** -1 looking back · 0 profile/forward · 1 toward camera. */
  headYaw: number;
  headTilt: number;
  knees: [Vec2, Vec2];
  feet: [FootState, FootState];
  shoulders: Vec2;
  elbows: [Vec2, Vec2];
  hands: [Vec2, Vec2];
  /** Lateral pelvis sway (m) – visible in front/back views. */
  sway: number;
  breath: number;
  /** Eye openness 0..1 (blinks). */
  eyeOpen: number;
}
