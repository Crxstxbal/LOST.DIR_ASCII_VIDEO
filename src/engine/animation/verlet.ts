/** Minimal 2D Verlet particle system with distance constraints. Deterministic (fixed step, fixed order). */
export class Verlet {
  n: number;
  x: Float64Array;
  y: Float64Array;
  px: Float64Array;
  py: Float64Array;
  pinned: Uint8Array;
  private ca: number[] = [];
  private cb: number[] = [];
  private rest: number[] = [];
  private stiff: number[] = [];

  constructor(n: number) {
    this.n = n;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pinned = new Uint8Array(n);
  }

  set(i: number, x: number, y: number) {
    this.x[i] = x;
    this.y[i] = y;
    this.px[i] = x;
    this.py[i] = y;
  }

  /** Move a pinned particle (keeps velocity info for neighbours). */
  pin(i: number, x: number, y: number) {
    this.px[i] = this.x[i];
    this.py[i] = this.y[i];
    this.x[i] = x;
    this.y[i] = y;
  }

  link(a: number, b: number, stiffness = 1, rest?: number) {
    this.ca.push(a);
    this.cb.push(b);
    this.rest.push(rest ?? Math.hypot(this.x[a] - this.x[b], this.y[a] - this.y[b]));
    this.stiff.push(stiffness);
  }

  setRest(ci: number, r: number) {
    this.rest[ci] = r;
  }

  get constraintCount() {
    return this.ca.length;
  }

  /** Verlet integration with per-particle acceleration callback. */
  integrate(dt: number, damping: number, acc: (i: number, vx: number, vy: number, out: [number, number]) => void) {
    const out: [number, number] = [0, 0];
    const dt2 = dt * dt;
    for (let i = 0; i < this.n; i++) {
      if (this.pinned[i]) continue;
      const vx = (this.x[i] - this.px[i]) * damping;
      const vy = (this.y[i] - this.py[i]) * damping;
      out[0] = 0;
      out[1] = 0;
      acc(i, vx / dt, vy / dt, out);
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      this.x[i] += vx + out[0] * dt2;
      this.y[i] += vy + out[1] * dt2;
    }
  }

  solve() {
    const { x, y, pinned } = this;
    for (let c = 0; c < this.ca.length; c++) {
      const a = this.ca[c];
      const b = this.cb[c];
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const d = Math.hypot(dx, dy) || 1e-9;
      const diff = ((d - this.rest[c]) / d) * this.stiff[c];
      const wa = pinned[a] ? 0 : 1;
      const wb = pinned[b] ? 0 : 1;
      const w = wa + wb;
      if (!w) continue;
      const ox = dx * diff;
      const oy = dy * diff;
      x[a] += (ox * wa) / w;
      y[a] += (oy * wa) / w;
      x[b] -= (ox * wb) / w;
      y[b] -= (oy * wb) / w;
    }
  }

  snapshot(): Float64Array {
    const s = new Float64Array(this.n * 4);
    s.set(this.x, 0);
    s.set(this.y, this.n);
    s.set(this.px, this.n * 2);
    s.set(this.py, this.n * 3);
    return s;
  }

  restore(s: Float64Array) {
    this.x.set(s.subarray(0, this.n));
    this.y.set(s.subarray(this.n, this.n * 2));
    this.px.set(s.subarray(this.n * 2, this.n * 3));
    this.py.set(s.subarray(this.n * 3, this.n * 4));
  }
}
