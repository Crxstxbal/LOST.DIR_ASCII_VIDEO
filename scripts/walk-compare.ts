/**
 * Walk diagnostic: previous walk (v1) vs the 12-key-pose walk (v2).
 *
 *   npm run walk-compare -- [--out exports/walk-compare.png] [--speed 0.75]
 *
 * For each style: the skeleton at 12 evenly spaced moments of one gait cycle
 * (planted feet in red), curves of hip height / ankle heights / body speed over
 * two cycles, and the actual ASCII render of the lateral shot at 6 moments.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { useNodeCanvas } from './nodeCanvas';
import { getCharacter, renderFrame, resetRuntimes } from '../src/engine/render';
import { defaultProject, type Project } from '../src/engine/project/schema';
import { buildTrack, computePose, sampleTrack } from '../src/engine/animation/locomotion';
import type { Pose } from '../src/engine/character/types';

useNodeCanvas();
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const out = arg('out', 'exports/walk-compare.png')!;
const speed = Number(arg('speed', '0.75'));
const STYLES = ['v1', 'v2'] as const;

const W = 1500;
const ROW_SK = 260;
const ROW_PLOT = 200;
const ROW_ASCII = 250;
const BLOCK = ROW_SK + ROW_PLOT + ROW_ASCII + 50;

function projectFor(style: 'v1' | 'v2'): Project {
  const p = defaultProject();
  const s = p.shots.find((x) => x.id === 'wasteland_lateral')!;
  p.shots = [
    {
      ...s,
      duration: 12,
      gradeKeys: [],
      camera: { ...s.camera, distance: 3.4, height: 1.0, horizon: 0.58, follow: 1 },
      actor: { ...s.actor!, start: 0, speed, startWalking: true, actions: [], gait: { style } },
    },
  ];
  // the render takes the walk from the character's global look
  p.characters = { protagonist: { gait: { style } } };
  return p;
}

async function main() {
  const sheet = createCanvas(W, 40 + BLOCK * 2);
  const g = sheet.getContext('2d');
  g.fillStyle = '#0b0708';
  g.fillRect(0, 0, sheet.width, sheet.height);
  g.font = '18px sans-serif';
  g.fillStyle = '#e4a18b';
  g.fillText(`Caminata: anterior (v1) frente a 12 poses clave (v2) · velocidad ${speed} m/s · rojo = pie apoyado`, 12, 26);

  for (const [bi, style] of STYLES.entries()) {
    const y0 = 40 + bi * BLOCK;
    const p = projectFor(style);
    const def = getCharacter('protagonist');
    const track = buildTrack(def, p.shots[0].actor!, p.shots[0].duration);
    // one steady cycle: from a foot-0 heel strike after 3 s
    const ev = track.feet[0].filter((e) => e.t > 3);
    const tA = ev[0].t;
    const tB = ev[1].t;
    const cyc = tB - tA;
    g.fillStyle = '#e4a18b';
    g.font = '17px sans-serif';
    g.fillText(`${style === 'v1' ? 'ANTERIOR (v1, procedural)' : 'NUEVA (v2, 12 poses clave)'} · ciclo ${cyc.toFixed(2)} s`, 12, y0 + 18);

    // --- skeleton strip ---
    const scale = 120;
    const base = sampleTrack(track, tA).dist;
    const N = 12;
    for (let k = 0; k < N; k++) {
      const t = tA + (k / N) * cyc;
      const pose = computePose(track, t, 7);
      const ox = 50 + k * ((W - 100) / N) - (pose.u - base) * scale * 0.0;
      const gy = y0 + ROW_SK;
      const X = (x: number) => ox + (x - pose.u) * scale + 40;
      const Y = (y: number) => gy - y * scale;
      g.strokeStyle = '#3a2427';
      g.beginPath();
      g.moveTo(ox, gy);
      g.lineTo(ox + (W - 100) / N - 6, gy);
      g.stroke();
      drawSkeleton(g, pose, X, Y);
      g.fillStyle = '#8a6a64';
      g.font = '11px sans-serif';
      g.fillText(`${k + 1}`, ox + 2, gy + 14);
    }

    // --- curves over two cycles ---
    const py = y0 + ROW_SK + 30;
    const pw = W - 100;
    const ph = ROW_PLOT - 40;
    g.strokeStyle = '#2a1a1d';
    g.strokeRect(50, py, pw, ph);
    const M = 240;
    const series: { name: string; col: string; f: (pose: Pose, t: number) => number; lo: number; hi: number }[] = [
      { name: 'altura de cadera', col: '#e33b38', f: (q) => q.hip.y, lo: 0.82, hi: 0.95 },
      { name: 'tobillo pie A', col: '#e4a18b', f: (q) => q.feet[0].ankle.y, lo: 0, hi: 0.28 },
      { name: 'tobillo pie B', col: '#8e292d', f: (q) => q.feet[1].ankle.y, lo: 0, hi: 0.28 },
      {
        name: 'velocidad del cuerpo',
        col: '#7fa0c8',
        f: (_q, t) => (sampleTrack(track, t + 0.01).dist - sampleTrack(track, t - 0.01).dist) / 0.02,
        lo: speed * 0.8,
        hi: speed * 1.2,
      },
    ];
    for (const [si, S] of series.entries()) {
      g.strokeStyle = S.col;
      g.lineWidth = 1.6;
      g.beginPath();
      for (let i = 0; i <= M; i++) {
        const t = tA + (i / M) * 2 * cyc;
        const q = computePose(track, t, 7);
        const v = (S.f(q, t) - S.lo) / (S.hi - S.lo);
        const x = 50 + (i / M) * pw;
        const y = py + ph - Math.max(0, Math.min(1, v)) * ph;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = S.col;
      g.font = '12px sans-serif';
      g.fillText(S.name, 60 + si * 170, py + ph + 16);
    }
    g.lineWidth = 1;

    // --- ASCII strip (real renders) ---
    const ay = y0 + ROW_SK + ROW_PLOT + 10;
    resetRuntimes();
    const frame = createCanvas(1280, 720);
    const fctx = frame.getContext('2d');
    for (let k = 0; k < 6; k++) {
      const t = tA + (k / 6) * cyc;
      const r = renderFrame(p, 0, t, { width: 1280, height: 720 });
      const img = fctx.createImageData(1280, 720);
      img.data.set(r.data);
      fctx.putImageData(img, 0, 0);
      const ry = (((r.cols * 2) / 1280) * 720) / (r.rows * 3);
      const cx = r.head!.x;
      const top = r.head!.y * ry - 0.15 * r.head!.s;
      const hgt = 1.95 * r.head!.s;
      const wdt = hgt * 0.72;
      const dw = (W - 100) / 6 - 8;
      g.drawImage(frame, cx - wdt / 2, top, wdt, hgt, 50 + k * (dw + 8), ay, dw, (dw * hgt) / wdt > ROW_ASCII ? ROW_ASCII : (dw * hgt) / wdt);
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await sheet.encode('png'));
  console.log('→ ' + out);
}

function drawSkeleton(g: any, q: Pose, X: (x: number) => number, Y: (y: number) => number) {
  const line = (pts: { x: number; y: number }[], col: string, w: number) => {
    g.strokeStyle = col;
    g.lineWidth = w;
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))));
    g.stroke();
  };
  // far side first, darker
  for (const k of [1, 0]) {
    const f = q.feet[k];
    const c = k === 1 ? '#6a4b47' : '#e4a18b';
    line([q.hip, q.knees[k], f.ankle], c, 3);
    line([f.heel, f.toe], f.planted ? '#e33b38' : c, 3);
    line([q.shoulders, q.elbows[k], q.hands[k]], k === 1 ? '#5a3a37' : '#c08a7a', 2);
  }
  line([q.hip, q.chest, q.neck], '#e4a18b', 3);
  g.strokeStyle = '#e4a18b';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(X(q.head.x), Y(q.head.y), 0.105 * 120, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
