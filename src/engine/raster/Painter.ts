import { createCanvas, ctx2d, type CanvasLike, type Ctx2D } from '../core/canvasFactory';
import { css, type RGB } from '../core/color';
import { clamp } from '../core/math';

/**
 * A material paint: the visible colour of a surface and its glyph "density"
 * (how much ink the ASCII renderer should put there). Decoupling the two lets a
 * black cloak still read as textured dark-red glyphs instead of empty space.
 */
export interface Paint {
  color: RGB;
  density: number;
  alpha?: number;
}

/**
 * Sub-cell sampling: each ASCII cell is SX×SY raster samples grouped into ZX×ZY
 * shape zones. One sample per zone: canvas anti-aliasing already integrates the
 * coverage inside each raster pixel, so 2×3 gives the glyph matcher the same zone
 * values as 4×6 did, with 4× fewer pixels to rasterise, read back and scan
 * (measured: see scripts/perf-report.ts).
 */
export const SX = 2;
export const SY = 3;
export const ZX = 2;
export const ZY = 3;

/**
 * Internal raster for one render pass. Everything is drawn in "virtual" screen
 * units (1920 wide) and scaled to the pass raster, so passes with different
 * ASCII densities share the same drawing code.
 */
export class Painter {
  readonly cols: number;
  readonly rows: number;
  readonly w: number;
  readonly h: number;
  readonly vw: number;
  readonly vh: number;
  readonly k: number;
  readonly colorCanvas: CanvasLike;
  readonly densCanvas: CanvasLike;
  readonly cc: Ctx2D;
  readonly dc: Ctx2D;
  private shadeC: CanvasLike | null = null;
  private shadeD: CanvasLike | null = null;
  /** Cached shaded bands for static layers (same key → same pixels, no re-evaluation). */
  private shadeCache = new Map<string, { r0: number; bh: number; c0: number; c1: number; zw: number; imgC: ImageData; imgD: ImageData }>();
  /** Per-cell forced glyph (char code, 0 = none). Lets art direction pin iconic glyphs (e.g. '@' rose heads). */
  readonly hints: Uint16Array;
  /** True for low-resolution defocus passes: generators may skip detail that will blur away. */
  soft = false;

  constructor(cols: number, rows: number, vw: number, vh: number) {
    this.cols = cols;
    this.rows = rows;
    this.w = cols * SX;
    this.h = rows * SY;
    this.vw = vw;
    this.vh = vh;
    this.k = this.w / vw;
    this.colorCanvas = createCanvas(this.w, this.h);
    this.densCanvas = createCanvas(this.w, this.h);
    this.cc = ctx2d(this.colorCanvas);
    this.dc = ctx2d(this.densCanvas);
    this.hints = new Uint16Array(cols * rows);
    this.reset();
  }

  /** Pin a glyph at a virtual screen position (overrides shape matching for that cell). */
  hint(vx: number, vy: number, ch: string) {
    const c = Math.floor((vx / this.vw) * this.cols);
    const r = Math.floor((vy / this.vh) * this.rows);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return;
    this.hints[r * this.cols + c] = ch.charCodeAt(0);
  }

  /** Remove glyph hints under an opaque shape drawn in front (virtual rect). */
  clearHints(x0: number, y0: number, x1: number, y1: number) {
    const c0 = Math.max(0, Math.floor((x0 / this.vw) * this.cols));
    const c1 = Math.min(this.cols - 1, Math.floor((x1 / this.vw) * this.cols));
    const r0 = Math.max(0, Math.floor((y0 / this.vh) * this.rows));
    const r1 = Math.min(this.rows - 1, Math.floor((y1 / this.vh) * this.rows));
    for (let r = r0; r <= r1; r++) this.hints.fill(0, r * this.cols + c0, r * this.cols + c1 + 1);
  }

  /** Clear to transparent and reset transform to virtual units. */
  reset() {
    this.hints?.fill(0);
    for (const c of [this.cc, this.dc]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, this.w, this.h);
      c.setTransform(this.k, 0, 0, this.k, 0, 0);
      c.lineJoin = 'round';
      c.lineCap = 'round';
    }
  }

  // ---- transform stack (mirrored on both rasters) ----
  save() {
    this.cc.save();
    this.dc.save();
  }
  restore() {
    this.cc.restore();
    this.dc.restore();
  }
  translate(x: number, y: number) {
    this.cc.translate(x, y);
    this.dc.translate(x, y);
  }
  rotate(a: number) {
    this.cc.rotate(a);
    this.dc.rotate(a);
  }
  scale(x: number, y: number) {
    this.cc.scale(x, y);
    this.dc.scale(x, y);
  }

  // ---- path building ----
  beginPath() {
    this.cc.beginPath();
    this.dc.beginPath();
  }
  moveTo(x: number, y: number) {
    this.cc.moveTo(x, y);
    this.dc.moveTo(x, y);
  }
  lineTo(x: number, y: number) {
    this.cc.lineTo(x, y);
    this.dc.lineTo(x, y);
  }
  quadTo(cx: number, cy: number, x: number, y: number) {
    this.cc.quadraticCurveTo(cx, cy, x, y);
    this.dc.quadraticCurveTo(cx, cy, x, y);
  }
  bezierTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
    this.cc.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
    this.dc.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rotation = 0, a0 = 0, a1 = Math.PI * 2) {
    rx = Math.max(0.01, rx);
    ry = Math.max(0.01, ry);
    this.cc.ellipse(x, y, rx, ry, rotation, a0, a1);
    this.dc.ellipse(x, y, rx, ry, rotation, a0, a1);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.cc.rect(x, y, w, h);
    this.dc.rect(x, y, w, h);
  }
  closePath() {
    this.cc.closePath();
    this.dc.closePath();
  }
  /** Smooth closed/open curve through points (Catmull-Rom → bezier). */
  smoothPath(pts: { x: number; y: number }[], closed: boolean, tension = 0.5) {
    const n = pts.length;
    if (n < 2) return;
    this.moveTo(pts[0].x, pts[0].y);
    const get = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = get(i - 1);
      const p1 = get(i);
      const p2 = get(i + 1);
      const p3 = get(i + 2);
      const t = tension / 3;
      this.bezierTo(p1.x + (p2.x - p0.x) * t, p1.y + (p2.y - p0.y) * t, p2.x - (p3.x - p1.x) * t, p2.y - (p3.y - p1.y) * t, p2.x, p2.y);
    }
    if (closed) this.closePath();
  }
  polygon(pts: { x: number; y: number }[]) {
    if (!pts.length) return;
    this.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.lineTo(pts[i].x, pts[i].y);
    this.closePath();
  }

  // ---- painting ----
  private applyFill(p: Paint) {
    const a = p.alpha ?? 1;
    const d = Math.round(clamp(p.density) * 255);
    this.cc.fillStyle = css(p.color, a);
    this.dc.fillStyle = a >= 1 ? `rgb(${d},${d},${d})` : `rgba(${d},${d},${d},${clamp(a)})`;
  }
  private applyStroke(p: Paint, width: number) {
    const a = p.alpha ?? 1;
    const d = Math.round(clamp(p.density) * 255);
    this.cc.strokeStyle = css(p.color, a);
    this.dc.strokeStyle = a >= 1 ? `rgb(${d},${d},${d})` : `rgba(${d},${d},${d},${clamp(a)})`;
    this.cc.lineWidth = width;
    this.dc.lineWidth = width;
  }
  fill(p: Paint) {
    this.applyFill(p);
    this.cc.fill();
    this.dc.fill();
  }
  stroke(p: Paint, width: number) {
    this.applyStroke(p, width);
    this.cc.stroke();
    this.dc.stroke();
  }
  fillRect(x: number, y: number, w: number, h: number, p: Paint) {
    this.applyFill(p);
    this.cc.fillRect(x, y, w, h);
    this.dc.fillRect(x, y, w, h);
  }
  /** Clip subsequent drawing to the current path (until restore). */
  clip() {
    this.cc.clip();
    this.dc.clip();
  }

  /**
   * Per-pixel shader over a horizontal band of the screen, evaluated at shape-zone
   * resolution (cols·2 × rows·3, i.e. exactly what glyph matching can resolve) and
   * upscaled onto the raster. fn(vx, vy, out) fills out=[r,g,b,a,density] and
   * returns false to leave the pixel transparent. Optional vx0/vx1 limit the
   * horizontal range that is evaluated (pixels outside stay transparent).
   */
  shade(
    vy0: number,
    vy1: number,
    fn: (vx: number, vy: number, out: Float32Array) => boolean,
    vx0 = -Infinity,
    vx1 = Infinity,
    /** Static layers: a key covering every input of `fn`; an identical key reuses the band. */
    cacheKey?: string,
    /**
     * Evaluation resolution relative to the shape-zone grid (1 = every zone). Smooth
     * layers (sky gradient, fog) can use 0.5: 4× fewer evaluations, bilinear upscale.
     */
    res = 1,
  ) {
    if (!this.shadeC) {
      this.shadeC = createCanvas(this.cols * ZX, this.rows * ZY);
      this.shadeD = createCanvas(this.cols * ZX, this.rows * ZY);
    }
    const zw = Math.max(1, Math.round(this.cols * ZX * res));
    const zh = Math.max(1, Math.round(this.rows * ZY * res));
    const r0 = Math.max(0, Math.floor((vy0 / this.vh) * zh));
    const r1 = Math.min(zh, Math.ceil((vy1 / this.vh) * zh));
    if (r1 <= r0) return;
    const bh = r1 - r0;
    const scC = ctx2d(this.shadeC);
    const scD = ctx2d(this.shadeD!);
    // one extra row replicating the band's last row: the smoothed upscale samples one
    // row past the band, and that row must never hold leftovers from a previous call
    // (that made the first frame of a session differ from later ones)
    const bhE = Math.min(this.rows * ZY, bh + 1);
    // same for one column past the right edge when the band is evaluated at < full
    // resolution (the scratch canvas is wider than the evaluated grid)
    const iw = Math.min(this.cols * ZX, zw + 1);
    const sx = this.vw / zw;
    const sy = this.vh / zh;
    const c0 = Math.max(0, Math.floor(vx0 / sx));
    const c1 = Math.min(zw, Math.ceil(vx1 / sx));
    const hit = cacheKey ? this.shadeCache.get(cacheKey) : undefined;
    if (hit && hit.r0 === r0 && hit.bh === bh && hit.c0 === c0 && hit.c1 === c1 && hit.zw === zw) {
      scC.putImageData(hit.imgC, 0, 0);
      scD.putImageData(hit.imgD, 0, 0);
      this.blitShade(r0, bh, zw, zh, c0, c1);
      return;
    }
    const imgC = scC.createImageData(iw, bhE);
    const imgD = scD.createImageData(iw, bhE);
    const pc = imgC.data;
    const pd = imgD.data;
    const out = new Float32Array(5);
    for (let y = r0; y < r1; y++) {
      const vy = (y + 0.5) * sy;
      let o = ((y - r0) * iw + c0) * 4;
      for (let x = c0; x < c1; x++, o += 4) {
        out[3] = 1;
        if (!fn((x + 0.5) * sx, vy, out)) continue;
        const a = clamp(out[3]) * 255;
        pc[o] = clamp(out[0]) * 255;
        pc[o + 1] = clamp(out[1]) * 255;
        pc[o + 2] = clamp(out[2]) * 255;
        pc[o + 3] = a;
        const d = clamp(out[4]) * 255;
        pd[o] = d;
        pd[o + 1] = d;
        pd[o + 2] = d;
        pd[o + 3] = a;
      }
    }
    if (iw > zw) {
      for (let y = 0; y < bh; y++) {
        const o = (y * iw + zw) * 4;
        for (let k = 0; k < 4; k++) {
          pc[o + k] = pc[o - 4 + k];
          pd[o + k] = pd[o - 4 + k];
        }
      }
    }
    if (bhE > bh) {
      const row = iw * 4;
      pc.copyWithin(bh * row, (bh - 1) * row, bh * row);
      pd.copyWithin(bh * row, (bh - 1) * row, bh * row);
    }
    scC.putImageData(imgC, 0, 0);
    scD.putImageData(imgD, 0, 0);
    if (cacheKey) {
      this.shadeCache.set(cacheKey, { r0, bh, c0, c1, zw, imgC, imgD });
      if (this.shadeCache.size > 4) this.shadeCache.delete(this.shadeCache.keys().next().value!);
    }
    this.blitShade(r0, bh, zw, zh, c0, c1);
  }

  private blitShade(r0: number, bh: number, zw: number, zh: number, c0: number, c1: number) {
    const dy = (r0 / zh) * this.h;
    const dh = (bh / zh) * this.h;
    // composite only the evaluated columns: even fully transparent pixels can nudge
    // the raster by a rounding step, which is enough to flip glyphs far away
    const sx0 = Math.max(0, c0 - 1);
    const sx1 = Math.min(zw, c1 + 1);
    if (sx1 <= sx0) return;
    for (const [dst, src] of [
      [this.cc, this.shadeC],
      [this.dc, this.shadeD!],
    ] as const) {
      dst.save();
      dst.setTransform(1, 0, 0, 1, 0, 0);
      dst.imageSmoothingEnabled = true;
      dst.drawImage(src as any, sx0, 0, sx1 - sx0, bh, (sx0 / zw) * this.w, dy, ((sx1 - sx0) / zw) * this.w, dh);
      dst.restore();
    }
  }
}
