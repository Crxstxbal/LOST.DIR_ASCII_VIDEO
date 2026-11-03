import type { PreviewStats } from './previewEngine';

/** Real, measured preview metrics (nothing here is estimated). */
export function MetricsBar({
  stats,
  uiMs,
  playing,
  breakdown,
  onBreakdown,
}: {
  stats: PreviewStats | null;
  uiMs: number;
  playing: boolean;
  breakdown: boolean;
  onBreakdown?: (v: boolean) => void;
}) {
  if (!stats) return <span className="stats">midiendo…</span>;
  const capacity = (1000 / Math.max(1, stats.renderMs)) * stats.workers;
  return (
    <span className="stats" title="Render: tiempo medio de un fotograma en un worker. Capacidad: fotogramas por segundo que pueden producir todos los workers juntos. Mostrados: fotogramas realmente pintados en el último segundo.">
      <b className={'rtag ' + stats.renderer}>{stats.renderer.toUpperCase()}</b> {stats.cols}×{stats.rows} celdas{stats.lod ? ` · LOD: ${stats.lod}` : ''} · render {stats.renderMs.toFixed(0)} ms × {stats.workers} workers
      {stats.rstats ? ` · conversión ${stats.rstats.conversionMs ? stats.rstats.conversionMs.toFixed(0) + ' ms' : '—'} · objetos ≈${stats.rstats.objects} · glifos libres ${stats.rstats.strokes}` : ''}
      {playing ? ` · ${stats.fps} fps mostrados · ${stats.dropped} descartados` : ` · capacidad ≈${capacity.toFixed(0)} fps`} · pintar {stats.drawMs.toFixed(1)} ms · UI {uiMs.toFixed(1)} ms
      {onBreakdown && (
        <label className="chk inline">
          <input type="checkbox" checked={breakdown} onChange={(e) => onBreakdown(e.target.checked)} /> desglose
        </label>
      )}
    </span>
  );
}
