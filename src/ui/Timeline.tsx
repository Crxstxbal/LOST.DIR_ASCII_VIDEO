import { useRef } from 'react';
import type { Project } from '../engine/project/schema';
import { projectDuration } from '../engine/render';

interface Props {
  project: Project;
  time: number;
  shotIndex: number;
  onSeek: (t: number) => void;
}

/** Shot track with proportional blocks, colour-key and action markers, and a draggable playhead. */
export function Timeline({ project, time, shotIndex, onSeek }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const total = projectDuration(project);
  const seekFrom = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(total - 1e-3, ((clientX - r.left) / r.width) * total)));
  };
  let acc = 0;
  const ticks: number[] = [];
  for (let s = 0; s <= total; s += total > 60 ? 10 : 5) ticks.push(s);
  return (
    <div className="timeline">
      <div
        className="track"
        ref={ref}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          seekFrom(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) seekFrom(e.clientX);
        }}
      >
        {ticks.map((s) => (
          <span key={s} className="tick" style={{ left: `${(s / total) * 100}%` }}>
            {s}s
          </span>
        ))}
        {project.shots.map((s, i) => {
          const start = acc;
          acc += s.duration;
          return (
            <div key={s.id} className={'block' + (i === shotIndex ? ' on' : '') + (s.location === 'rose_field' ? ' rose' : '')} style={{ left: `${(start / total) * 100}%`, width: `${(s.duration / total) * 100}%` }}>
              <span>{s.name}</span>
              {s.gradeKeys.map((k, j) => (
                <i key={'k' + j} className="kmark" title={`Clave de color t=${k.t}`} style={{ left: `${(k.t / s.duration) * 100}%` }} />
              ))}
              {s.actor?.actions.map((a, j) => (
                <i key={'a' + j} className="amark" title={`${a.type} t=${a.t}`} style={{ left: `${(a.t / s.duration) * 100}%` }} />
              ))}
            </div>
          );
        })}
        <div className="playhead" style={{ left: `${(time / total) * 100}%` }} />
      </div>
    </div>
  );
}
