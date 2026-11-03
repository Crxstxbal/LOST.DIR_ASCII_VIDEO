import { CHARSETS } from '../engine/ascii/charsets';
import { RESOLUTION_PRESETS, type AsciiOutput } from '../engine/project/schema';
import { gridFor } from '../engine/render';
import { PREVIEW_PROFILES, type PreviewProfileId } from '../engine/project/profiles';
import { Section, Select, Slider, Toggle } from './controls';

export { PREVIEW_PROFILES as PREVIEW_MODES } from '../engine/project/profiles';

const EXPORT_SCALES: { value: '1' | '1.5' | '2'; label: string }[] = [
  { value: '1', label: '1920×1080' },
  { value: '1.5', label: '2880×1620 (mismos caracteres, más nítidos)' },
  { value: '2', label: '3840×2160 (mismos caracteres, más nítidos)' },
];

/**
 * ASCII OUTPUT: project-wide output settings. The grid belongs to the project, so
 * every shot and camera shares it; per-shot overrides live under FX → Avanzado.
 */
export function AsciiOutputPanel({ output, onChange }: { output: AsciiOutput; onChange: (o: AsciiOutput) => void }) {
  const set = (patch: Partial<AsciiOutput>) => onChange({ ...output, ...patch });
  const preset = RESOLUTION_PRESETS.some((p) => p.cols === output.cols);
  const g = gridFor(output.cols, 1920, 1080);
  return (
    <div className="ascii-output">
      <Section title="ASCII Output">
        <Select
          label="Resolución global"
          value={String(output.cols)}
          options={[
            ...RESOLUTION_PRESETS.map((p) => ({ value: String(p.cols), label: p.label })),
            ...(preset ? [] : [{ value: String(output.cols), label: `${g.cols} × ${g.rows} · personalizada` }]),
          ]}
          onChange={(v) => set({ cols: Number(v) })}
        />
        <p className="note">
          Rejilla del proyecto: {g.cols} × {g.rows} caracteres en todos los planos y cámaras.
        </p>
        <Select
          label="Paleta de glifos"
          value={output.charset}
          options={Object.entries(CHARSETS).map(([k, v]) => ({ value: k, label: v.label }))}
          onChange={(charset) => set({ charset })}
        />
        <Slider label="Densidad de caracteres" value={output.density} min={0.5} max={1.6} step={0.01} onChange={(density) => set({ density })} />
        <Slider label="Contraste" value={output.contrast} min={0.5} max={1.8} step={0.01} onChange={(contrast) => set({ contrast })} />
        <Slider label="Nitidez" value={output.sharpness} min={0} max={1} step={0.01} onChange={(sharpness) => set({ sharpness })} hint="Contraste dentro de cada celda: más glifos de borde y forma." />
        <Slider label="Brillo de glifos" value={output.glyphGain} min={0.5} max={3} step={0.05} onChange={(glyphGain) => set({ glyphGain })} />
        <Slider label="Resplandor de celda" value={output.bgGlow} min={0} max={0.6} step={0.01} onChange={(bgGlow) => set({ bgGlow })} />
        <Toggle label="Dithering estable" value={output.dither} onChange={(dither) => set({ dither })} />
        <Toggle label="LOD automático" value={output.autoLod} onChange={(autoLod) => set({ autoLod })} />
        <Select
          label="Calidad de vista previa"
          value={output.preview}
          options={(Object.keys(PREVIEW_PROFILES) as PreviewProfileId[]).map((k) => ({ value: k, label: PREVIEW_PROFILES[k].label }))}
          onChange={(preview) => set({ preview })}
        />
        <Select
          label="Calidad de exportación"
          value={String(output.exportScale) as '1' | '1.5' | '2'}
          options={EXPORT_SCALES}
          onChange={(v) => set({ exportScale: Number(v) as AsciiOutput['exportScale'] })}
        />
      </Section>
    </div>
  );
}
