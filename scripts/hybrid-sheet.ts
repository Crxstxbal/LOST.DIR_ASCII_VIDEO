/**
 * RED FIELD — HYBRID TEST: each of the 5 shots rendered by LEGACY and by HYBRID
 * at the same time and camera, side by side, with timings and counters.
 *
 *   npm run hybrid-sheet -- [--out exports/hybrid-sheet.png] [--t 0.55] [--w 960]
 *
 * --t is the moment inside each shot as a fraction of its duration.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { useNodeCanvas } from './nodeCanvas';
import { renderFrame, resetRuntimes } from '../src/engine/render';
import { redFieldProject } from '../src/engine/project/templates';

useNodeCanvas();
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const out = arg('out', 'exports/hybrid-sheet.png')!;
const frac = Number(arg('t', '0.55'));
const TW = Number(arg('w', '960'));
const TH = Math.round((TW * 9) / 16);

async function main() {
  const p = redFieldProject();
  const sheet = createCanvas(TW * 2 + 10, 34 + p.shots.length * (TH + 30));
  const g = sheet.getContext('2d');
  g.fillStyle = '#0b0708';
  g.fillRect(0, 0, sheet.width, sheet.height);
  g.fillStyle = '#e4a18b';
  g.font = '18px sans-serif';
  g.fillText('RED FIELD — HYBRID TEST · izquierda: LEGACY · derecha: HYBRID (misma toma, tiempo y cámara)', 10, 22);
  const frame = createCanvas(TW, TH);
  const fctx = frame.getContext('2d');
  for (let i = 0; i < p.shots.length; i++) {
    const s = p.shots[i];
    const t = s.duration * frac;
    const y = 34 + i * (TH + 30);
    for (const [col, renderer] of [
      [0, 'legacy'],
      [1, 'hybrid'],
    ] as const) {
      resetRuntimes();
      const prof: Record<string, number> = {};
      const r = renderFrame(p, i, t, { width: TW, height: TH, renderer, profile: prof });
      const img = fctx.createImageData(TW, TH);
      img.data.set(r.data);
      fctx.putImageData(img, 0, 0);
      g.drawImage(frame, col * (TW + 10), y);
      g.fillStyle = '#e4a18b';
      g.font = '14px sans-serif';
      const st = r.stats ? ` · objetos ${r.stats.objects} · glifos libres ${r.stats.strokes}` : '';
      const label = `${s.name} · ${renderer.toUpperCase()} · ${prof.TOTAL.toFixed(0)} ms · ${r.cols}×${r.rows}${st}`;
      g.fillText(label, col * (TW + 10) + 4, y + TH + 18);
      console.log(label);
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await sheet.encode('png'));
  console.log('→ ' + out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
