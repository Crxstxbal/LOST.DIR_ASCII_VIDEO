/**
 * Moderate bloom for the HYBRID renderer: bright glyph pixels are gathered at 1/4
 * resolution, blurred and added back. It lifts highlights (flowers, rim light, the
 * glow in the sky) without washing out the ASCII structure.
 */
let small: Float32Array | null = null;
let tmp: Float32Array | null = null;

export function bloom(out: Uint8ClampedArray, W: number, H: number, amount: number) {
  if (amount <= 0) return;
  const D = 4;
  const w = Math.ceil(W / D);
  const h = Math.ceil(H / D);
  const n = w * h * 3;
  if (!small || small.length !== n) {
    small = new Float32Array(n);
    tmp = new Float32Array(n);
  }
  const S = small;
  const B = tmp!;
  S.fill(0);
  const thr = 150;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const l = out[i] * 0.5 + out[i + 1] * 0.3 + out[i + 2] * 0.2;
      if (l <= thr) continue;
      const k = (l - thr) / (255 - thr);
      const j = (((y / D) | 0) * w + ((x / D) | 0)) * 3;
      S[j] += out[i] * k;
      S[j + 1] += out[i + 1] * k;
      S[j + 2] += out[i + 2] * k;
    }
  // two separable box blurs (radius 3) ≈ gaussian
  const R = 3;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let k = -R; k <= R; k++) s += S[(y * w + Math.min(w - 1, Math.max(0, x + k))) * 3 + c];
          B[(y * w + x) * 3 + c] = s / (2 * R + 1);
        }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let k = -R; k <= R; k++) s += B[(Math.min(h - 1, Math.max(0, y + k)) * w + x) * 3 + c];
          S[(y * w + x) * 3 + c] = s / (2 * R + 1);
        }
  }
  const g = amount * 0.9 / (D * D) * 4;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const j = (((y / D) | 0) * w + ((x / D) | 0)) * 3;
      out[i] = Math.min(255, out[i] + S[j] * g);
      out[i + 1] = Math.min(255, out[i + 1] + S[j + 1] * g);
      out[i + 2] = Math.min(255, out[i + 2] + S[j + 2] * g);
    }
}
