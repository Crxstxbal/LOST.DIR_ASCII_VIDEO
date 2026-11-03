/**
 * Visual LOD test: the protagonist in five framings (extreme close-up → extreme
 * wide) with the project's global grid. Each row shows the full frame and a 1:1
 * crop at the head, so the character size can be compared between framings.
 *
 *   npm run lod-sheet -- [--out exports/lod-sheet.png] [--cols 360] [--nolod]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { useNodeCanvas } from './nodeCanvas';
import { renderFrame, resetRuntimes } from '../src/engine/render';
import { defaultProject } from '../src/engine/project/schema';
import { LOD_LEVELS } from '../src/engine/character/lod';
import { FRAMINGS, FRAMING_T, framingProject } from './lodFramings';

useNodeCanvas();
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const out = arg('out', 'exports/lod-sheet.png')!;
const base = defaultProject();
if (arg('cols')) base.output.cols = Number(arg('cols'));
if (args.includes('--nolod')) base.output.autoLod = false;

const W = 1920;
const H = 1080;
const FW = 768;
const FH = 432;
const CROP = 432;
const HEAD = 36;

async function main() {
  const sheet = createCanvas(FW + CROP + 8, HEAD + FRAMINGS.length * (FH + 8));
  const g = sheet.getContext('2d');
  g.fillStyle = '#0b0708';
  g.fillRect(0, 0, sheet.width, sheet.height);
  g.fillStyle = '#e4a18b';
  g.font = '18px sans-serif';
  g.fillText(`Rejilla global ${base.output.cols} col · LOD automático ${base.output.autoLod ? 'sí' : 'no'} · izquierda: fotograma · derecha: recorte 1:1`, 10, 24);
  const frame = createCanvas(W, H);
  const fctx = frame.getContext('2d');
  for (let i = 0; i < FRAMINGS.length; i++) {
    const F = FRAMINGS[i];
    resetRuntimes();
    const p = framingProject(F.camera, base);
    const t0 = performance.now();
    const r = renderFrame(p, 0, FRAMING_T, { width: W, height: H });
    const ms = performance.now() - t0;
    const img = fctx.createImageData(W, H);
    img.data.set(r.data);
    fctx.putImageData(img, 0, 0);
    const y = HEAD + i * (FH + 8);
    g.drawImage(frame, 0, 0, W, H, 0, y, FW, FH);
    if (r.head) {
      const ry = (((r.cols * 4) / W) * H) / (r.rows * 6);
      const cx = Math.round(Math.min(W - CROP / 2, Math.max(CROP / 2, r.head.x)));
      const cy = Math.round(Math.min(H - CROP / 2, Math.max(CROP / 2, (r.head.y + 0.12 * r.head.s) * ry)));
      g.drawImage(frame, cx - CROP / 2, cy - CROP / 2, CROP, CROP, FW + 8, y, CROP, CROP);
    }
    const lv = r.lod ? LOD_LEVELS.find((l) => l.id === r.lod!.level)!.label : '—';
    const label = `${F.label} → LOD: ${lv} (rostro ${r.lod?.faceRows.toFixed(1)} filas) · ${r.cols}×${r.rows} celdas · ${ms.toFixed(0)} ms`;
    g.fillStyle = 'rgba(0,0,0,0.65)';
    g.fillRect(0, y + FH - 28, FW, 28);
    g.fillStyle = '#e4a18b';
    g.font = '16px sans-serif';
    g.fillText(label, 8, y + FH - 9);
    console.log(label);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await sheet.encode('png'));
  console.log('→ ' + out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
