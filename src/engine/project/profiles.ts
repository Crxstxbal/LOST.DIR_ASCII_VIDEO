/**
 * Preview quality profiles. They only affect the editor preview: export always
 * renders the project's full grid at the export size.
 *
 * - quality:     the project grid (same characters as the export), 1280×720 pixels.
 * - balanced:    75 % of the grid columns.
 * - performance: 50 % of the grid columns, smaller pixel buffer — for fluid editing.
 */
export type PreviewProfileId = 'performance' | 'balanced' | 'quality';

export interface PreviewProfile {
  w: number;
  h: number;
  /** Multiplier on the project's grid columns (preview only). */
  cols: number;
  label: string;
}

export const PREVIEW_PROFILES: Record<PreviewProfileId, PreviewProfile> = {
  performance: { w: 960, h: 540, cols: 0.5, label: 'PERFORMANCE · rejilla al 50 % · edición fluida' },
  balanced: { w: 1280, h: 720, cols: 0.75, label: 'BALANCED · rejilla al 75 %' },
  quality: { w: 1280, h: 720, cols: 1, label: 'QUALITY · rejilla del proyecto (= exportación)' },
};

/** Older project files used other names for the preview modes. */
export function normalizePreview(v: unknown): PreviewProfileId | null {
  if (v === 'performance' || v === 'balanced' || v === 'quality') return v;
  if (v === 'rendimiento') return 'performance';
  if (v === 'completa' || v === 'final') return 'quality';
  return null;
}
