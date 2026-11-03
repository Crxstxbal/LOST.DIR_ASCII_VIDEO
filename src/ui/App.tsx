import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultProject, type Project } from '../engine/project/schema';
import { parseProject, serializeProject } from '../engine/project/ProjectIO';
import { projectDuration, shotAt } from '../engine/render';
import { PropertiesPanel } from './PropertiesPanel';
import { RenderClient } from './renderClient';
import { PreviewEngine, type PreviewStats } from './previewEngine';
import { MetricsBar } from './MetricsBar';
import { History, diffPaths } from './history';
import { installPanelWheel } from './panelWheel';
import { ScenePanel } from './ScenePanel';
import { AsciiOutputPanel } from './AsciiOutputPanel';
import { Timeline } from './Timeline';


function fmt(t: number, fps: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export function App() {
  const renderStart = performance.now();
  const [project, setProjectState] = useState<Project>(() => defaultProject());
  const [time, setTime] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [loopShot, setLoopShot] = useState(false);
  const [status, setStatus] = useState('Listo.');
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const uiMs = useRef(0);
  const [saved, setSaved] = useState<{ name: string; mtime: number }[]>([]);
  const [dirty, setDirty] = useState(false);
  const preview = useMemo(() => new PreviewEngine(), []);
  const capture = useMemo(() => new RenderClient(), []);
  const timeRef = useRef(time);
  timeRef.current = time;
  // ---- edit history ----
  const history = useMemo(() => new History(readHistoryLimit()), []);
  const [, setHistVer] = useState(0);
  const projectRef = useRef(project);
  const gestureRef = useRef<number | null>(null);
  // cost of a React render+commit of the whole app (shown in the metrics)
  useLayoutEffect(() => {
    uiMs.current = performance.now() - renderStart;
  });

  const total = projectDuration(project);
  const at = shotAt(project, time);

  /** Apply a project state to the UI and the render workers (no history). */
  const applyProject = useCallback(
    (p: Project, reset = false) => {
      projectRef.current = p;
      setProjectState(p);
      preview.setProject(p, reset);
      capture.setProject(p, reset);
    },
    [preview, capture],
  );

  /** Every user edit goes through here and is recorded in the history. */
  const setProject = useCallback(
    (p: Project, reset = false) => {
      const before = projectRef.current;
      if (p === before) return;
      // one pointer gesture (a slider drag) = one entry; typing in one field merges briefly
      const g = gestureRef.current;
      const key = g !== null ? `g:${g}` : `p:${(diffPaths(before, p)[0] ?? []).join('.')}`;
      history.record(before, p, key);
      setHistVer((v) => v + 1);
      setDirty(true);
      applyProject(p, reset);
    },
    [applyProject, history],
  );

  /** Replace the whole project (new / load / import): starts a fresh history. */
  const resetProject = useCallback(
    (p: Project) => {
      history.clear();
      setHistVer((v) => v + 1);
      applyProject(p, true);
    },
    [applyProject, history],
  );

  const undo = useCallback(() => {
    const e = history.undo();
    if (!e) return;
    applyProject(e.before);
    setDirty(true);
    setHistVer((v) => v + 1);
    setStatus(`Deshecho: ${e.label}`);
  }, [history, applyProject]);

  const redo = useCallback(() => {
    const e = history.redo();
    if (!e) return;
    applyProject(e.after);
    setDirty(true);
    setHistVer((v) => v + 1);
    setStatus(`Rehecho: ${e.label}`);
  }, [history, applyProject]);

  // pointer gestures on sliders / timeline group their edits into one history entry
  useEffect(() => {
    let n = 0;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.('input[type=range], .timeline')) gestureRef.current = ++n;
    };
    const up = () => setTimeout(() => (gestureRef.current = null), 0);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    const off = installPanelWheel();
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      off();
    };
  }, []);

  useEffect(() => {
    preview.setProject(project, true);
    capture.setProject(project, true);
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- rendering (outside React state, see previewEngine.ts) ----
  useEffect(() => {
    preview.onStats = setStats;
    preview.onTime = (T) => setTime(T);
    preview.onError = (e) => setStatus('Error de render: ' + e.message);
  }, [preview]);

  // paused: re-render whenever the project or the time changes (latest request wins)
  useEffect(() => {
    if (!playing) preview.renderStill(time);
  }, [project, time, playing, preview]);

  // playback: the engine owns the clock and the canvas; React gets a throttled time
  useEffect(() => {
    if (!playing) return;
    preview.start(timeRef.current, loopShot);
    return () => {
      const T = preview.stop();
      if (T !== null) setTime(T);
    };
  }, [playing, loopShot, preview]);

  useEffect(() => {
    preview.profiling = showBreakdown;
    if (!playing) preview.renderStill(timeRef.current);
  }, [showBreakdown, preview, playing]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      const textLike =
        tag === 'TEXTAREA' || el.isContentEditable || (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'color', 'button', 'file'].includes((el as HTMLInputElement).type));
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if ((k === 'z' || k === 'y') && !textLike) {
          e.preventDefault();
          if (k === 'y' || (k === 'z' && e.shiftKey)) redo();
          else undo();
          return;
        }
      }
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowRight') setTime((T) => Math.min(total - 1e-3, T + 1 / project.fps));
      else if (e.code === 'ArrowLeft') setTime((T) => Math.max(0, T - 1 / project.fps));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total, project.fps, undo, redo]);

  // ---- project I/O ----
  async function refreshList() {
    try {
      const r = await fetch('/api/projects');
      if (r.ok) setSaved(await r.json());
    } catch {
      /* API unavailable (e.g. static build) */
    }
  }

  const safeName = project.name.replace(/[^\w\-. ]/g, '_').slice(0, 80) || 'proyecto';

  async function save() {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(safeName)}`, { method: 'PUT', body: serializeProject(project) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setStatus(`Guardado en ${j.path}`);
      setDirty(false);
      refreshList();
    } catch (e: any) {
      setStatus('No se pudo guardar: ' + e.message);
    }
  }

  async function load(name: string) {
    if (dirty && !confirm('Hay cambios sin guardar. ¿Cargar de todas formas?')) return;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}`);
      if (!r.ok) throw new Error((await r.json()).error);
      const p = parseProject(await r.text());
      resetProject(p);
      setDirty(false);
      setTime(0);
      setStatus(`Cargado projects/${name}.json (${p.shots.length} planos)`);
    } catch (e: any) {
      setStatus('No se pudo cargar: ' + e.message);
    }
  }

  function exportJson() {
    const blob = new Blob([serializeProject(project)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeName + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJson(file: File) {
    file.text().then((txt) => {
      try {
        const p = parseProject(txt);
        resetProject(p);
        setDirty(true);
        setTime(0);
        setStatus(`Importado ${file.name}`);
      } catch (e: any) {
        setStatus('Importación fallida: ' + e.message);
      }
    });
  }

  async function capturePng() {
    const ew = Math.round(project.width * project.output.exportScale);
    const eh = Math.round(project.height * project.output.exportScale);
    setStatus(`Renderizando captura ${ew}×${eh}…`);
    try {
      const f = await capture.render(at.index, at.t, ew, eh, 1);
      const c = document.createElement('canvas');
      c.width = f.width;
      c.height = f.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
      const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
      const shot = project.shots[at.index];
      const name = `${safeName}_${shot.id}_f${String(Math.round(at.t * project.fps)).padStart(5, '0')}.png`.replace(/[^\w\-. ]/g, '_');
      const r = await fetch(`/api/capture?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setStatus(`Captura ${f.width}×${f.height} (${f.cols}×${f.rows} celdas) guardada en ${j.path} (${(j.bytes / 1024).toFixed(0)} KB, render ${f.ms.toFixed(0)} ms)`);
    } catch (e: any) {
      setStatus('Captura fallida: ' + e.message);
    }
  }

  const selectShot = (i: number, p = project) => {
    let acc = 0;
    for (let k = 0; k < i; k++) acc += p.shots[k].duration;
    const tr = p.shots[i]?.transitionIn;
    // land after a fade-in so the selected shot is visible immediately
    const skip = tr && tr.type === 'fade' ? Math.min(tr.duration, p.shots[i].duration * 0.5) : 0;
    setTime(acc + skip + 0.001);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          LOST.DIR <span>— ASCII CINEMA</span>
        </div>
        <div className="actions">
          <button onClick={undo} disabled={!history.undoLabel} title="Ctrl+Z">
            ↶ {history.undoLabel ? `Deshacer: ${history.undoLabel}` : 'Deshacer'}
          </button>
          <button onClick={redo} disabled={!history.redoLabel} title="Ctrl+Y · Ctrl+Shift+Z">
            ↷ {history.redoLabel ? `Rehacer: ${history.redoLabel}` : 'Rehacer'}
          </button>
          <select
            className="hist-limit"
            value={String(history.limit)}
            title={`Límite del historial (${history.sizes.undo} pasos guardados)`}
            onChange={(e) => {
              history.setLimit(Number(e.target.value));
              writeHistoryLimit(history.limit);
              setHistVer((v) => v + 1);
            }}
          >
            {[50, 100, 200, 500, 1000].map((n) => (
              <option key={n} value={n}>
                historial {n}
              </option>
            ))}
          </select>
          <span className="sep" />
          <button
            onClick={() => {
              if (dirty && !confirm('Hay cambios sin guardar. ¿Crear un proyecto nuevo?')) return;
              resetProject(defaultProject());
              setTime(0);
              setDirty(false);
            }}
          >
            Nuevo
          </button>
          <button onClick={save} title={`projects/${safeName}.json`}>
            Guardar{dirty ? ' •' : ''}
          </button>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) load(e.target.value);
            }}
            onFocus={refreshList}
          >
            <option value="">Cargar…</option>
            {saved.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <button onClick={exportJson}>Exportar JSON</button>
          <label className="button">
            Importar JSON
            <input type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          </label>
          <button className="accent" onClick={capturePng}>
            Captura PNG
          </button>
        </div>
      </header>

      <aside className="left">
        <ScenePanel
          project={project}
          shotIndex={at.index}
          onSelect={(i) => selectShot(i)}
          onChange={(p, sel) => {
            setProject(p);
            if (sel !== undefined) selectShot(sel, p);
          }}
        />
        <AsciiOutputPanel output={project.output} onChange={(output) => setProject({ ...project, output })} />
      </aside>

      <main className="center">
        <div className="viewer">
          <canvas ref={(c) => preview.attach(c)} />
          {showBreakdown && stats?.profile && <Breakdown profile={stats.profile} />}
        </div>
        <div className="transport">
          <button onClick={() => setTime(at.start + 0.001)} title="Inicio del plano">
            ⏮
          </button>
          <button onClick={() => setTime((T) => Math.max(0, T - 1 / project.fps))} title="Fotograma anterior (←)">
            ◀︎|
          </button>
          <button className="play" onClick={() => setPlaying((p) => !p)} title="Reproducir / pausa (espacio)">
            {playing ? '❚❚' : '▶'}
          </button>
          <button onClick={() => setTime((T) => Math.min(total - 1e-3, T + 1 / project.fps))} title="Fotograma siguiente (→)">
            |▶︎
          </button>
          <span className="tc">
            {fmt(time, project.fps)} / {fmt(total, project.fps)}
          </span>
          <span className="tc dim">
            plano {at.index + 1}: {at.t.toFixed(2)}s · fotograma {Math.round(at.t * project.fps)}
          </span>
          <label className="chk">
            <input type="checkbox" checked={loopShot} onChange={(e) => setLoopShot(e.target.checked)} /> bucle del plano
          </label>
          <MetricsBar stats={stats} uiMs={uiMs.current} playing={playing} breakdown={showBreakdown} onBreakdown={setShowBreakdown} />
        </div>
        <Timeline project={project} time={time} shotIndex={at.index} onSeek={setTime} />
        <footer className="status">{status}</footer>
      </main>

      <aside className="right">
        <PropertiesPanel project={project} shotIndex={at.index} localT={at.t} onChange={(p) => setProject(p)} />
      </aside>
    </div>
  );
}

/** Per-stage breakdown of the last profiled frame (worker 0), heaviest first. */
function Breakdown({ profile }: { profile: Record<string, number> }) {
  const rows = Object.entries(profile)
    .filter(([k]) => k !== 'TOTAL')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14);
  return (
    <div className="breakdown">
      <div className="bd-title">Desglose del último fotograma · total {profile.TOTAL?.toFixed(1)} ms</div>
      {rows.map(([k, v]) => (
        <div key={k} className="bd-row">
          <span>{k}</span>
          <span>{v.toFixed(1)} ms</span>
        </div>
      ))}
    </div>
  );
}

const HISTORY_KEY = 'lostdir.historyLimit';
function readHistoryLimit() {
  try {
    const n = Number(localStorage.getItem(HISTORY_KEY));
    return Number.isFinite(n) && n > 0 ? n : 200;
  } catch {
    return 200;
  }
}
function writeHistoryLimit(n: number) {
  try {
    localStorage.setItem(HISTORY_KEY, String(n));
  } catch {
    /* storage unavailable: the limit just isn't remembered */
  }
}
