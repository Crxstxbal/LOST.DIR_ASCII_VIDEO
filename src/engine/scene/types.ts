import type { Light } from '../ascii/AsciiCompositor';
import type { PaletteRGB, RGB } from '../core/color';
import type { View } from '../camera/Camera';
import type { GradeParams } from '../grading/ColorGrade';
import type { Painter } from '../raster/Painter';
import type { Shot } from '../project/schema';
import type { CharacterLight } from '../character/drawCharacter';

export type PassId = 'bg' | 'main' | 'fg';

export interface DrawItem {
  /** Camera-space depth (m). Larger = further = drawn first. */
  depth: number;
  pass?: PassId;
  draw: (P: Painter) => void;
}

export class DrawList {
  items: DrawItem[] = [];
  add(depth: number, draw: (P: Painter) => void, pass?: PassId) {
    this.items.push({ depth, draw, pass });
  }
}

/** World wind: horizontal velocity along +x in m/s. */
export type WindField = (t: number, x: number, y: number, z: number) => number;

export interface FrameCtx {
  /** Shot-local time (s). */
  t: number;
  frame: number;
  fps: number;
  seed: number;
  shot: Shot;
  view: View;
  palette: PaletteRGB;
  grade: GradeParams;
  wind: WindField;
  /** Location parameters (defaults merged with shot overrides). */
  params: Record<string, any>;
  fogColor: RGB;
  light: CharacterLight;
  /** Screen-space lights emitted by generators (meteors, glows). */
  lights: Light[];
  /** Screen footprint of the actor (for generators that react to it). */
  actor: { x: number; y: number; s: number; depth: number; worldX: number; worldZ: number } | null;
  effects: Shot['effects'];
}

export type Generator = (ctx: FrameCtx, layer: Record<string, any>, out: DrawList) => void;

export interface LocationLayer {
  generator: string;
  params?: Record<string, any>;
}

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

export interface LocationDef {
  id: string;
  name: string;
  description: string;
  references: string[];
  params: Record<string, number>;
  paramDefs: ParamDef[];
  light: { side: number; rim: number; rimColor: string; ambient: string; ambientAmt: number };
  fogColor: string;
  layers: LocationLayer[];
  /** World description for the HYBRID renderer (absent = location has no HYBRID world). */
  hybrid?: any;
}
