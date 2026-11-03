import { useId, type ReactNode } from 'react';

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h3>{title}</h3>
        {right}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; hint?: string }) {
  const id = useId();
  const { label, value, min, max, step = 0.01, onChange } = props;
  return (
    <div className="field slider" title={props.hint}>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        className="num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? Number(value.toFixed(3)) : 0}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </div>
  );
}

export function NumberField(props: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        className="num wide"
        type="number"
        step={props.step ?? 0.1}
        min={props.min}
        max={props.max}
        value={Number(props.value.toFixed(3))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
    </div>
  );
}

export function Select<T extends string>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="field toggle">
      <label htmlFor={id}>{props.label}</label>
      <input id={id} type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
    </div>
  );
}

export function ColorField(props: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="field color">
      <label htmlFor={id}>{props.label}</label>
      <input id={id} type="color" value={props.value} onChange={(e) => props.onChange(e.target.value.toUpperCase())} />
      <code>{props.value}</code>
    </div>
  );
}

export function TextField(props: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input id={id} type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </div>
  );
}
