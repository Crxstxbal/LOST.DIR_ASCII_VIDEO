/**
 * Before/after comparison of the protagonist's face (v1 prototype face vs v2).
 *
 *   npm run face-compare -- [--out exports/face-compare.png] [--face '{"eyeOpen":0.5}']
 *
 * Renders the same frames with both face styles through the real engine and lays
 * them out next to the charcoal reference: frontal close-up, 3/4, profile,
 * medium shot and the lateral walk. --face overrides v2 parameters (JSON).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { useNodeCanvas } from './nodeCanvas';
import { renderFrame, resetRuntimes } from '../src/engine/render';
import { defaultProject, type Project, type Shot } from '../src/engine/project/schema';
import type { FaceParams } from '../src/engine/character/face';

useNodeCanvas();

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const out = arg('out', 'exports/face-compare.png')!;
const faceOverride: Partial<FaceParams> = arg('face') ? JSON.parse(arg('face')!) : {};

interface Case {
  label: string;
  base: string;
  t: number;
  /** Crop size in metres around the head. */
  crop: number;
  patch?: (s: Shot) => Shot;
}

const CASES: Case[] = [
  {
    label: 'Primer plano · frontal',
    base: 'rose_closeup',
    t: 2,
    crop: 0.62,
    patch: (s) => ({
      ...s,
      camera: { ...s.camera, offsetX: 0 },
      actor: { ...s.actor!, heading: 'toward', speed: 0, startWalking: false, actions: [] },
    }),
  },
  { label: 'Primer plano · 3/4 (mira a cámara)', base: 'rose_closeup', t: 5.5, crop: 0.62 },
  { label: 'Primer plano · perfil', base: 'rose_closeup', t: 1.5, crop: 0.62 },
  {
    label: 'Plano medio · mira a cámara',
    base: 'wasteland_lateral',
    t: 3,
    crop: 0.75,
    patch: (s) => ({
      ...s,
      camera: { ...s.camera, distance: 2.6, height: 1.5, horizon: 0.5 },
      actor: { ...s.actor!, start: 0, speed: 0, startWalking: false, actions: [{ t: 0.5, type: 'look', look: 'camera' }] },
    }),
  },
  { label: 'Plano lateral · caminando', base: 'wasteland_lateral', t: 5.2, crop: 0.9 },
];

const TILE = 460;
const HEAD = 40;
const REF = 'References/01_CHARACTER/8f74c6033d75a4cffdca0fc72444fa9f.jpg';

function shotFor(c: Case, style: 'v1' | 'v2'): Project {
  const p = defaultProject();
  const base = p.shots.find((s) => s.id === c.base)!;
  let shot = c.patch ? c.patch(base) : base;
  p.shots = [shot];
  // looks are global per character
  p.characters = { protagonist: { face: { ...(style === 'v2' ? faceOverride : {}), style } } };
  return p;
}

async function main() {
  const W = 1920;
  const H = 1080;
  const sheet = createCanvas(TILE * 3, HEAD + CASES.length * TILE);
  const g = sheet.getContext('2d');
  g.fillStyle = '#0b0708';
  g.fillRect(0, 0, sheet.width, sheet.height);
  g.fillStyle = '#e4a18b';
  g.font = '20px sans-serif';
  g.fillText('REFERENCIA (carboncillo)', 12, 27);
  g.fillText('ANTERIOR (v1)', TILE + 12, 27);
  g.fillText('NUEVO (v2)', TILE * 2 + 12, 27);
  // reference: the face of the charcoal illustration
  const ref = await loadImage(REF);
  g.drawImage(ref, 300, 60, 160, 180, 0, HEAD, TILE, (TILE * 180) / 160);

  const frame = createCanvas(W, H);
  const fctx = frame.getContext('2d');
  for (let row = 0; row < CASES.length; row++) {
    const c = CASES[row];
    for (const [col, style] of [
      [1, 'v1'],
      [2, 'v2'],
    ] as const) {
      resetRuntimes();
      const p = shotFor(c, style);
      const t0 = performance.now();
      const r = renderFrame(p, 0, c.t, { width: W, height: H });
      const ms = performance.now() - t0;
      const img = fctx.createImageData(W, H);
      img.data.set(r.data);
      fctx.putImageData(img, 0, 0);
      const y0 = HEAD + row * TILE;
      if (r.head) {
        const size = Math.min(H, c.crop * r.head.s);
        const cx = r.head.x;
        // the character (drawn as paths) sits `ry` lower than its projection (see shadeFace)
        const ry = (((r.cols * 4) / W) * H) / (r.rows * 6);
        const cy = (r.head.y + 0.16 * r.head.s) * ry;
        g.drawImage(frame, cx - size / 2, cy - size / 2, size, size, col * TILE, y0, TILE, TILE);
      }
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(col * TILE, y0 + TILE - 30, TILE, 30);
      g.fillStyle = '#e4a18b';
      g.font = '16px sans-serif';
      g.fillText(`${c.label} · t=${c.t}s`, col * TILE + 10, y0 + TILE - 10);
      console.log(`${c.label} [${style}] ${ms.toFixed(0)} ms`);
    }
  }
  // separators
  g.fillStyle = '#100a0d';
  for (let i = 1; i < 3; i++) g.fillRect(i * TILE - 2, 0, 4, sheet.height);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await sheet.encode('png'));
  console.log('→ ' + out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
