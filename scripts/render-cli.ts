/**
 * Headless renderer.
 *
 *   npm run render -- [--project file.json] [--shot <index|id>] [--t 1.5,3] [--seq 0:4] [--fps 24]
 *                     [--w 1920] [--h 1080] [--cols 1.5] [--out exports/cli] [--all]
 *
 * --t     list of shot-local times to render
 * --seq   a:b renders every frame between a and b seconds at --fps
 * --all   renders 3 frames of every shot
 * --cols  multiplies the project's global grid (density test only; normal renders use 1)
 * --template redfield   use the RED FIELD — HYBRID TEST template instead of --project
 * --renderer legacy|hybrid   force a renderer (default: each shot's own)
 * --mp4 file.mp4   render the whole timeline (or --shot) at --fps and encode H.264 with the
 *                  system FFmpeg (frames piped as raw RGBA; deterministic time, no audio yet).
 *                  FFmpeg is looked up in FFMPEG_PATH, then in PATH.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { useNodeCanvas, encodePng } from './nodeCanvas';
import { projectDuration, renderFrame, shotAt } from '../src/engine/render';
import { redFieldProject } from '../src/engine/project/templates';
import type { RendererId } from '../src/engine/project/schema';
import { defaultProject, type Project } from '../src/engine/project/schema';
import { parseProject } from '../src/engine/project/ProjectIO';

useNodeCanvas();

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const has = (k: string) => args.includes('--' + k);

const project: Project = arg('template') === 'redfield' ? redFieldProject() : arg('project') ? parseProject(readFileSync(arg('project')!, 'utf8')) : defaultProject();
const renderer = arg('renderer') as RendererId | undefined;
// default size = the project's export quality (same grid, larger glyphs at higher scales)
const W = Number(arg('w', String(Math.round(project.width * project.output.exportScale))));
const H = Number(arg('h', String(Math.round(project.height * project.output.exportScale))));
const fps = Number(arg('fps', String(project.fps)));
const out = arg('out', 'exports/cli')!;
mkdirSync(out, { recursive: true });

function shotIndex(s: string | undefined): number[] {
  if (!s) return project.shots.map((_, i) => i);
  const n = Number(s);
  if (!Number.isNaN(n)) return [n];
  const i = project.shots.findIndex((x) => x.id === s);
  if (i < 0) throw new Error('shot not found: ' + s);
  return [i];
}

async function encodeMp4(file: string) {
  const ff = process.env.FFMPEG_PATH || 'ffmpeg';
  const shots = arg('shot') ? shotIndex(arg('shot')) : null;
  // global timeline frames (or the frames of one shot)
  const frames: { si: number; t: number }[] = [];
  if (shots) {
    const d = project.shots[shots[0]].duration;
    for (let f = 0; f < Math.round(d * fps); f++) frames.push({ si: shots[0], t: f / fps });
  } else {
    const total = projectDuration(project);
    for (let f = 0; f < Math.round(total * fps); f++) {
      const a = shotAt(project, f / fps);
      frames.push({ si: a.index, t: a.t });
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const proc = spawn(ff, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<number>((res, rej) => {
    proc.on('error', (e) => rej(new Error(`FFmpeg no encontrado (${ff}). Instálalo (winget install ffmpeg) o define FFMPEG_PATH. ${e.message}`)));
    proc.on('close', (code) => res(code ?? 1));
  });
  const t0 = performance.now();
  for (const [k, f] of frames.entries()) {
    const r = renderFrame(project, f.si, f.t, { width: W, height: H, renderer });
    if (!proc.stdin.write(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength))) await new Promise((res) => proc.stdin.once('drain', res));
    if (k % 24 === 0) process.stdout.write(`${k + 1}/${frames.length} fotogramas`);
  }
  proc.stdin.end();
  const code = await done;
  if (code !== 0) throw new Error('FFmpeg terminó con código ' + code);
  console.log(`
→ ${file}: ${frames.length} fotogramas a ${fps} fps, ${W}×${H}, render ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

async function main() {
  if (arg('mp4')) return encodeMp4(arg('mp4')!);
  const shots = shotIndex(arg('shot'));
  for (const si of shots) {
    const shot = project.shots[si];
    let times: number[];
    if (arg('seq')) {
      const [a, b] = arg('seq')!.split(':').map(Number);
      times = [];
      for (let f = Math.round(a * fps); f <= Math.round(b * fps); f++) times.push(f / fps);
    } else if (arg('t')) times = arg('t')!.split(',').map(Number);
    else times = has('all') || !arg('shot') ? [0.5, shot.duration * 0.5, shot.duration - 0.3] : [1];
    for (const t of times) {
      const t0 = performance.now();
      const name = arg('seq') ? `${shot.id}_${String(Math.round(t * fps)).padStart(5, '0')}.png` : `${shot.id}_t${t.toFixed(2)}.png`;
      const raws: Promise<void>[] = [];
      const r = renderFrame(project, si, t, {
        width: W,
        height: H,
        colsScale: Number(arg('cols', '1')),
        renderer,
        debugRaster: has('raw')
          ? (ps) =>
              ps.forEach((p, k) => {
                writeFileSync(join(out, name.replace('.png', `_raw${k}.png`)), (p.colorCanvas as any).encodeSync('png'));
                writeFileSync(join(out, name.replace('.png', `_dens${k}.png`)), (p.densCanvas as any).encodeSync('png'));
              })
          : undefined,
      });
      await Promise.all(raws);
      const ms = performance.now() - t0;
      writeFileSync(join(out, name), await encodePng(r.data, r.width, r.height));
      console.log(`${name}  ${r.cols}x${r.rows} cells  ${ms.toFixed(0)} ms`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
