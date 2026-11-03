import { useState } from 'react';
import { makeShot, newId, type Project } from '../engine/project/schema';
import { listLocations } from '../engine/scene/registry';

interface Props {
  project: Project;
  shotIndex: number;
  onSelect: (i: number) => void;
  onChange: (p: Project, select?: number) => void;
}

export function ScenePanel({ project, shotIndex, onSelect, onChange }: Props) {
  const [newLoc, setNewLoc] = useState(listLocations()[0].id);
  const shots = project.shots;
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= shots.length) return;
    const s = [...shots];
    [s[i], s[j]] = [s[j], s[i]];
    onChange({ ...project, shots: s }, j);
  };
  return (
    <div className="scenes">
      <header>
        <h3>Escenas / planos</h3>
      </header>
      <ol>
        {shots.map((s, i) => (
          <li key={s.id} className={i === shotIndex ? 'on' : ''} onClick={() => onSelect(i)}>
            <span className="idx">{String(i + 1).padStart(2, '0')}</span>
            <span className="name">{s.name}</span>
            <span className="meta">
              {s.location} · {s.camera.type} · {s.duration.toFixed(1)}s
            </span>
          </li>
        ))}
      </ol>
      <div className="row">
        <button onClick={() => move(shotIndex, -1)} disabled={shotIndex === 0} title="Subir">
          ↑
        </button>
        <button onClick={() => move(shotIndex, 1)} disabled={shotIndex === shots.length - 1} title="Bajar">
          ↓
        </button>
        <button
          onClick={() => {
            const src = shots[shotIndex];
            const copy = JSON.parse(JSON.stringify(src));
            copy.id = newId();
            copy.name = src.name + ' (copia)';
            const s = [...shots];
            s.splice(shotIndex + 1, 0, copy);
            onChange({ ...project, shots: s }, shotIndex + 1);
          }}
        >
          Duplicar
        </button>
        <button
          className="danger"
          disabled={shots.length <= 1}
          onClick={() => {
            if (!confirm(`¿Eliminar el plano "${shots[shotIndex].name}"?`)) return;
            const s = shots.filter((_, i) => i !== shotIndex);
            onChange({ ...project, shots: s }, Math.max(0, shotIndex - 1));
          }}
        >
          Eliminar
        </button>
      </div>
      <div className="row">
        <select value={newLoc} onChange={(e) => setNewLoc(e.target.value)}>
          {listLocations().map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            const loc = listLocations().find((l) => l.id === newLoc)!;
            const shot = makeShot({ name: `${loc.name} — nuevo plano`, location: newLoc });
            const s = [...shots];
            s.splice(shotIndex + 1, 0, shot);
            onChange({ ...project, shots: s }, shotIndex + 1);
          }}
        >
          + Nuevo plano
        </button>
      </div>
    </div>
  );
}
