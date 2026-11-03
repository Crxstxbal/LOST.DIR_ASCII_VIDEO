/**
 * Performance report: renders consecutive playback frames of every shot and prints
 * where the time goes (animation, every scene layer, raster passes, ASCII, post).
 *
 *   npm run perf -- [--profile performance|balanced|quality] [--frames 12] [--shot id]
 *                   [--template redfield] [--renderer legacy|hybrid]
 *
 * Numbers are milliseconds per frame on this machine, Node + @napi-rs/canvas
 * (the browser worker uses OffscreenCanvas; absolute values differ slightly).
 */
import { useNodeCanvas } from './nodeCanvas';
import { renderFrame } from '../src/engine/render';
import { defaultProject, type RendererId } from '../src/engine/project/schema';
import { redFieldProject } from '../src/engine/project/templates';
import { PREVIEW_PROFILES, type PreviewProfileId } from '../src/engine/project/profiles';

useNodeCanvas();
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const profileIds = (arg('profile') ? [arg('profile')] : Object.keys(PREVIEW_PROFILES)) as PreviewProfileId[];
const N = Number(arg('frames', '12'));
const p = arg('template') === 'redfield' ? redFieldProject() : defaultProject();
const renderer = arg('renderer') as RendererId | undefined;
const shots = arg('shot') ? p.shots.map((s, i) => [s, i] as const).filter(([s]) => s.id === arg('shot')) : p.shots.map((s, i) => [s, i] as const);

for (const pid of profileIds) {
  const Q = PREVIEW_PROFILES[pid];
  console.log(`\n=== perfil ${pid}: ${Q.w}×${Q.h}, rejilla ×${Q.cols} ===`);
  const totals: Record<string, number> = {};
  for (const [shot, i] of shots) {
    renderFrame(p, i, 2, { width: Q.w, height: Q.h, colsScale: Q.cols, renderer }); // warm caches/simulation
    const prof: Record<string, number> = {};
    for (let f = 1; f <= N; f++) renderFrame(p, i, 2 + f / p.fps, { width: Q.w, height: Q.h, colsScale: Q.cols, profile: prof, renderer });
    const avg = (k: string) => (prof[k] ?? 0) / N;
    const rows = Object.keys(prof)
      .filter((k) => k !== 'TOTAL')
      .sort((a, b) => prof[b] - prof[a])
      .slice(0, 9)
      .map((k) => `${k} ${avg(k).toFixed(1)}`);
    console.log(`${shot.id.padEnd(20)} ${avg('TOTAL').toFixed(0).padStart(4)} ms (${(1000 / avg('TOTAL')).toFixed(1)} fps) | ${rows.join(' · ')}`);
    for (const k of Object.keys(prof)) totals[k] = (totals[k] ?? 0) + prof[k] / N / shots.length;
  }
  console.log('— media de los planos —');
  for (const k of Object.keys(totals).sort((a, b) => totals[b] - totals[a])) console.log(`  ${k.padEnd(36)} ${totals[k].toFixed(1).padStart(6)} ms`);
}
