import { hexToRgb, mix, type RGB } from '../../core/color';
import { clamp, smoothstep } from '../../core/math';
import { fbm1, fbm2, noise2 } from '../../core/noise';
import { hashf } from '../../core/rng';
import type { FrameCtx, Generator } from '../types';

const col = (ctx: FrameCtx, v: any, fallback: RGB): RGB => {
  if (typeof v !== 'string') return fallback;
  const p = ctx.palette as any;
  if (p[v]) return p[v];
  return hexToRgb(v);
};

/** Exponential distance fog amount. */
export function fogAt(ctx: FrameCtx, dist: number, k = 1): number {
  const dens = 0.004 + ctx.grade.fog * 0.02 * (ctx.params.fogDensity ?? 1) * k;
  return 1 - Math.exp(-dist * dens);
}

/** Smooth layers are shaded at half the zone resolution (4× fewer evaluations; see perf-report). */
const SKY_RES = 0.5;
const FOG_RES = 0.5;

/** Sky: zenith→horizon gradient, perspective cloud deck, low sun glow. */
export const sky: Generator = (ctx, layer, out) => {
  const v = ctx.view;
  const P0 = ctx.params;
  const zen = col(ctx, layer.zenith ?? 'black', ctx.palette.black);
  const mid = col(ctx, layer.mid ?? 'blood', ctx.palette.blood);
  const hor = col(ctx, layer.horizon ?? 'red', ctx.palette.red);
  const cloudCol = col(ctx, layer.cloud ?? 'sepia', ctx.palette.sepia);
  const cloudLit = col(ctx, layer.cloudLit ?? 'pale', ctx.palette.pale);
  const sunCol = col(ctx, layer.sun ?? 'pale', ctx.palette.pale);
  const glowAmt = P0.skyGlow ?? 0.6;
  const cover = P0.cloudCover ?? 0.5;
  const speed = P0.cloudSpeed ?? 0.4;
  const t = ctx.t;
  const seed = ctx.seed;
  const hy = v.horizonY;
  const sunX = (P0.sunX ?? 0.7) * v.vw;
  const sunY = hy - (P0.sunHeight ?? 0.08) * v.vh;
  const glowR = v.vh * 0.55;
  out.add(1e9, (P) => {
    P.shade(0, Math.min(v.vh, Math.max(0, hy + v.vh * 0.06)), (sx, sy, o) => {
      const d = v.ray(sx, sy);
      const el = Math.atan2(d.y, Math.hypot(d.x, d.z));
      let c = mix(hor, mid, smoothstep(0.0, 0.22, el));
      c = mix(c, zen, smoothstep(0.12, 0.85, el));
      let dens = 0.22 + 0.22 * (1 - smoothstep(0, 0.5, el));
      // sun glow
      const gd = Math.hypot(sx - sunX, (sy - sunY) * 1.6) / glowR;
      const glow = Math.exp(-gd * gd * 2.2) * glowAmt;
      c = mix(c, sunCol, glow * 0.65);
      dens += glow * 0.35;
      // cloud deck at 900 m, seen in perspective (converges at the horizon)
      if (d.y > 0.004) {
        const lam = 900 / d.y;
        const wx = v.cx + d.x * lam + t * speed * 14;
        const wz = v.cz + d.z * lam;
        const warp = fbm2(wx * 0.0006, wz * 0.002, 2, seed + 29) * 900;
        const n = fbm2((wx + warp) * 0.0008, wz * 0.0065, 5, seed + 17) * 0.5 + 0.5;
        const streak = noise2(wx * 0.0003, wz * 0.02, seed + 23) * 0.5 + 0.5;
        const v0 = n * 0.7 + streak * 0.3;
        const cl = smoothstep(1 - cover - 0.08, 1 - cover + 0.22, v0);
        const thick = smoothstep(1 - cover + 0.12, 1.0, v0);
        const edge = clamp(cl * (1 - thick) * 2.2);
        const lit = clamp(glow * 1.8 + (1 - smoothstep(0, 0.3, el)) * 0.55);
        // dark cloud bodies with burning rims: strong tonal structure for the glyphs
        const body = mix(mix(zen, cloudCol, 0.7), cloudCol, lit * 0.4);
        const cc = mix(body, cloudLit, clamp(edge * lit * 1.3));
        c = mix(c, cc, cl * 0.92);
        dens = dens * (1 - cl) + cl * (0.15 + edge * lit * 0.6);
      }
      // ink follows tonality in the sky: dark zenith → sparse glyphs, glowing horizon → dense
      const L = c[0] * 0.6 + c[1] * 0.3 + c[2] * 0.1;
      dens = clamp(0.04 + L * 0.95 + (dens - 0.3) * 0.35);
      o[0] = c[0];
      o[1] = c[1];
      o[2] = c[2];
      o[3] = 1;
      o[4] = dens;
      return true;
    }, -Infinity, Infinity, undefined, SKY_RES);
  });
};

/** Distant ridges / mesas: world-space silhouettes with true parallax. */
export const ridges: Generator = (ctx, layer, out) => {
  const v = ctx.view;
  const D: number = layer.distance ?? 1200;
  const H: number = (layer.height ?? 60) * (ctx.params.ridgeHeight ?? 1);
  const scale: number = layer.scale ?? 400;
  const seed = ctx.seed + (layer.seed ?? 0);
  const base = col(ctx, layer.color ?? 'black', ctx.palette.black);
  const z = v.cz + D;
  const fog = fogAt(ctx, D, layer.fogK ?? 0.12);
  const c = mix(base, ctx.fogColor, clamp(fog * (layer.fogMix ?? 1)));
  const flat: number = layer.flatTop ?? 0;
  out.add(D, (P) => {
    const pts: { x: number; y: number }[] = [];
    const step = 6;
    for (let sx = -step; sx <= v.vw + step; sx += step) {
      const wx = v.cx + ((sx - v.vw / 2) / v.f) * (D * Math.cos(v.pitch));
      let h = fbm1(wx / scale, 4, seed) * 0.5 + 0.5;
      if (flat > 0) h = Math.min(h, 0.55 + flat * 0.1) + smoothstep(0.5, 0.56, h) * flat * 0.15; // mesa tops
      const p = v.project(wx, h * H, z);
      if (p) pts.push({ x: sx, y: p.y });
    }
    if (pts.length < 2) return;
    const g = v.project(v.cx, 0, z);
    const groundY = g ? g.y + 2 : v.vh;
    P.beginPath();
    P.moveTo(pts[0].x, groundY);
    for (const p of pts) P.lineTo(p.x, p.y);
    P.lineTo(pts[pts.length - 1].x, groundY);
    P.closePath();
    P.fill({ color: c, density: layer.density ?? 0.3 });
  });
};

/** Low drifting fog bands (in front of distant layers, behind the subject). */
export const fogBands: Generator = (ctx, layer, out) => {
  if (!ctx.effects.fogBands) return;
  const v = ctx.view;
  const depth: number = layer.depth ?? 30;
  const amount: number = (layer.amount ?? 0.5) * ctx.grade.fog * 2 * (ctx.params.fogBands ?? 1);
  if (amount <= 0.01) return;
  const height: number = (layer.height ?? 6) * (ctx.params.fogHeight ?? 1);
  const c = mix(ctx.fogColor, col(ctx, layer.color ?? 'pale', ctx.palette.pale), layer.light ?? 0.15);
  const t = ctx.t;
  const seed = ctx.seed + (layer.seed ?? 5);
  const wind = ctx.wind(t, v.cx, 1, v.cz + depth);
  const top = v.project(v.cx, height * 1.5, v.cz + depth);
  const y0 = top ? Math.max(0, top.y) : 0;
  out.add(depth, (P) => {
    P.shade(y0, v.vh, (sx, sy, o) => {
      const g = v.ground(sx, sy);
      // height of the ray above ground at the fog's depth
      const d = v.ray(sx, sy);
      const lam = depth / Math.max(0.01, d.z);
      const wy = v.cy + d.y * lam;
      const behind = g ? smoothstep(depth * 0.55, depth * 1.6, g.dist) : 1;
      if (behind <= 0) return false;
      const wx = v.cx + d.x * lam - t * wind * 0.6;
      const n = fbm2(wx * 0.05, wy * 0.35 + t * 0.05, 3, seed) * 0.5 + 0.5;
      const hfall = 1 - smoothstep(-height * 0.2, height, wy);
      const a = clamp(amount * hfall * behind * (0.25 + n * 0.9));
      if (a < 0.01) return false;
      o[0] = c[0];
      o[1] = c[1];
      o[2] = c[2];
      o[3] = a * 0.8;
      o[4] = 0.3 + n * 0.2;
      return true;
    }, -Infinity, Infinity, undefined, FOG_RES);
  });
};

/** Analytic particle field: ash, leaves or petals. Deterministic and scrub-safe (no integration). */
export const particles: Generator = (ctx, layer, out) => {
  if (!ctx.effects.particles) return;
  const v = ctx.view;
  const kind: 'ash' | 'leaf' | 'petal' = layer.kind ?? 'ash';
  const N = Math.round((layer.count ?? 120) * ctx.effects.particleDensity * 2 * (ctx.params[layer.amountParam ?? ''] ?? 1));
  const t = ctx.t;
  const seed = ctx.seed + (kind === 'ash' ? 300 : kind === 'leaf' ? 400 : 500);
  const zNear: number = layer.zNear ?? 3.2;
  const zFar: number = layer.zFar ?? 40;
  const colors: RGB[] = (layer.colors ?? ['pale']).map((c: string) => col(ctx, c, ctx.palette.pale));
  for (let i = 0; i < N; i++) {
    const life = 7 + hashf(seed, i, 1) * 8;
    const ph = hashf(seed, i, 2) * life;
    const g = Math.floor((t + ph) / life);
    const age = t + ph - g * life;
    const r = (k: number) => hashf(seed, i, g, k);
    const depth = zNear + Math.pow(r(3), 1.6) * (zFar - zNear);
    const z = v.cz + depth;
    const halfW = (v.vw / v.f) * depth * 0.65;
    const top = 2 + depth * 0.5;
    const fall = kind === 'ash' ? 0.35 : kind === 'leaf' ? 0.8 : 0.45;
    let y = top * (0.3 + r(4) * 0.9) - fall * age + Math.sin(age * 1.7 + r(5) * 6) * 0.15;
    if (kind === 'petal') y = 0.6 + r(4) * 2.2 - fall * 0.3 * age + Math.sin(age * 2.1 + r(5) * 6) * 0.3;
    if (y < -0.1) continue;
    const w = ctx.wind(t, v.cx, y, z);
    let x = v.cx + (r(6) - 0.5) * 2 * halfW + w * age * (kind === 'ash' ? 0.6 : 0.9) + Math.sin(age * 0.9 + r(7) * 6) * 0.4;
    x = v.cx + ((((x - v.cx + halfW) % (2 * halfW)) + 2 * halfW) % (2 * halfW)) - halfW;
    const p = v.project(x, y, z);
    if (!p || p.x < -20 || p.x > v.vw + 20 || p.y < -20 || p.y > v.vh + 20) continue;
    const fade = smoothstep(0, 1, age) * (1 - smoothstep(life - 1.5, life, age));
    const c = colors[Math.floor(r(8) * colors.length)];
    const fogK = fogAt(ctx, depth, 0.6);
    const cc = mix(c, ctx.fogColor, fogK * 0.7);
    const size = kind === 'ash' ? 0.025 : kind === 'leaf' ? 0.09 : 0.045;
    const spin = age * (1.5 + r(9) * 3) + r(10) * 6;
    out.add(p.depth, (P) => {
      const s = Math.max(1.1, size * p.s);
      P.beginPath();
      if (kind === 'ash') P.ellipse(p.x, p.y, s, s);
      else P.ellipse(p.x, p.y, s, Math.max(0.6, s * Math.abs(Math.cos(spin)) * 0.6), spin * 0.5);
      P.fill({ color: cc, density: kind === 'ash' ? 0.4 : 0.7, alpha: fade * (kind === 'ash' ? 0.7 : 0.95) });
    });
  }
};

/** Meteors crossing the sky; each emits a temporary light that brightens nearby glyphs. */
export const meteors: Generator = (ctx, layer, out) => {
  const on = ctx.effects.meteors || layer.always;
  if (!on) return;
  const v = ctx.view;
  const t = ctx.t;
  const seed = ctx.seed + 900;
  const rate: number = (layer.rate ?? 6) * (ctx.params.meteorRate ?? 1); // per minute
  const period = 60 / Math.max(0.1, rate);
  const hy = v.horizonY;
  const tail = col(ctx, layer.color ?? 'red', ctx.palette.red);
  const head = col(ctx, layer.headColor ?? 'pale', ctx.palette.pale);
  const i0 = Math.floor(t / period) - 3;
  for (let i = i0; i <= i0 + 4; i++) {
    const start = i * period + hashf(seed, i, 1) * period;
    const dur = 1.6 + hashf(seed, i, 2) * 2.2;
    const a = (t - start) / dur;
    if (a < 0 || a > 1) continue;
    const dir = layer.direction ?? (hashf(seed, i, 3) > 0.5 ? 1 : -1);
    const ang = (0.35 + hashf(seed, i, 4) * 0.3) * 1;
    const len = v.vw * (0.35 + hashf(seed, i, 5) * 0.3);
    const x0 = v.vw * (dir > 0 ? -0.1 + hashf(seed, i, 6) * 0.6 : 0.5 + hashf(seed, i, 6) * 0.6);
    const y0 = Math.max(-40, hy - v.vh * (0.35 + hashf(seed, i, 7) * 0.4));
    const hx = x0 + dir * Math.cos(ang) * len * a;
    const hyy = y0 + Math.sin(ang) * len * a;
    if (hyy > hy) continue;
    const tl = len * (0.25 + 0.15 * a);
    const tx = hx - dir * Math.cos(ang) * tl;
    const ty = hyy - Math.sin(ang) * tl;
    const fade = smoothstep(0, 0.15, a) * (1 - smoothstep(0.8, 1, a));
    ctx.lights.push({ x: hx, y: hyy, radius: v.vh * 0.45, color: mix(tail, head, 0.4), intensity: 0.35 * fade });
    out.add(9e8, (P) => {
      const segs = 8;
      for (let k = 0; k < segs; k++) {
        const f0 = k / segs;
        const f1 = (k + 1) / segs;
        P.beginPath();
        P.moveTo(tx + (hx - tx) * f0, ty + (hyy - ty) * f0);
        P.lineTo(tx + (hx - tx) * f1, ty + (hyy - ty) * f1);
        P.stroke({ color: mix(tail, head, f1 * f1), density: 0.4 + 0.5 * f1, alpha: fade * f1 }, 1 + f1 * 4);
      }
      P.beginPath();
      P.ellipse(hx, hyy, 6, 5);
      P.fill({ color: head, density: 1, alpha: fade });
    });
  }
};
