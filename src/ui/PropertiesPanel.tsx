import { useLayoutEffect, useRef, useState } from 'react';
import { CHARSETS } from '../engine/ascii/charsets';
import { evalGrade, NUMERIC_GRADE_KEYS, type GradeKey, type NumericGradeKey } from '../engine/grading/ColorGrade';
import { CAMERA_PRESETS, resolveAscii, type AsciiOverride, type CharacterLook, type ActorAction, type CameraParams, type CameraType, type Heading, type LookTarget, type Project, type Shot } from '../engine/project/schema';
import { getLocation, listLocations } from '../engine/scene/registry';
import { getCharacter } from '../engine/render';
import { FACE_PARAM_DEFS, resolveFace, type FaceParams } from '../engine/character/face';
import { DEFAULT_GAIT, GAIT_PARAM_DEFS, type GaitParams } from '../engine/animation/locomotion';
import { ColorField, NumberField, Section, Select, Slider, TextField, Toggle } from './controls';

type Tab = 'plano' | 'camara' | 'personaje' | 'escena' | 'color' | 'ascii';

const TABS: { id: Tab; label: string }[] = [
  { id: 'plano', label: 'Plano' },
  { id: 'camara', label: 'Cámara' },
  { id: 'personaje', label: 'Personaje' },
  { id: 'escena', label: 'Escena' },
  { id: 'color', label: 'Color' },
  { id: 'ascii', label: 'FX' },
];

const CAMERA_LABELS: Record<CameraType, string> = {
  side: 'Lateral (seguimiento)',
  front: 'Frontal',
  elevated: 'Elevada',
  closeup: 'Primer plano',
  wide: 'Plano general extremo',
};

const GRADE_DEFS: { key: NumericGradeKey; label: string; min: number; max: number; step: number }[] = [
  { key: 'redIntensity', label: 'Intensidad roja', min: 0, max: 1, step: 0.01 },
  { key: 'paletteAmount', label: 'Mapeo a paleta', min: 0, max: 1, step: 0.01 },
  { key: 'exposure', label: 'Exposición', min: -2, max: 2, step: 0.05 },
  { key: 'brightness', label: 'Brillo', min: -0.5, max: 0.5, step: 0.01 },
  { key: 'contrast', label: 'Contraste', min: 0.3, max: 2.5, step: 0.01 },
  { key: 'saturation', label: 'Saturación', min: 0, max: 2, step: 0.01 },
  { key: 'shadowTint', label: 'Tinte de sombras', min: 0, max: 1, step: 0.01 },
  { key: 'highlightTint', label: 'Tinte de luces', min: 0, max: 1, step: 0.01 },
  { key: 'fog', label: 'Niebla', min: 0, max: 1, step: 0.01 },
];

interface Props {
  project: Project;
  shotIndex: number;
  /** Shot-local time (for keyframes and actions). */
  localT: number;
  onChange: (p: Project) => void;
}

export function PropertiesPanel({ project, shotIndex, localT, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('plano');
  const [keyMode, setKeyMode] = useState(false);
  // remember the scroll position of each tab (the scrolling element is the side panel)
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollByTab = useRef<Partial<Record<Tab, number>>>({});
  const switchTab = (t: Tab) => {
    const sc = rootRef.current?.closest('.right') as HTMLElement | null;
    if (sc) scrollByTab.current[tab] = sc.scrollTop;
    setTab(t);
  };
  useLayoutEffect(() => {
    const sc = rootRef.current?.closest('.right') as HTMLElement | null;
    if (sc) sc.scrollTop = scrollByTab.current[tab] ?? 0;
  }, [tab]);
  const shot = project.shots[shotIndex];
  if (!shot) return null;

  const setShot = (patch: Partial<Shot>) => {
    const shots = project.shots.map((s, i) => (i === shotIndex ? { ...s, ...patch } : s));
    onChange({ ...project, shots });
  };
  const setCam = (patch: Partial<CameraParams>) => setShot({ camera: { ...shot.camera, ...patch } });
  const loc = getLocation(shot.location);

  return (
    <div className="props" ref={rootRef}>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => switchTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'plano' && (
          <>
            <Section title="Plano">
              <TextField label="Nombre" value={shot.name} onChange={(name) => setShot({ name })} />
              <Select
                label="Locación"
                value={shot.location}
                options={listLocations().map((l) => ({ value: l.id, label: l.name }))}
                onChange={(location) => setShot({ location, locationParams: {} })}
              />
              <NumberField label="Duración (s)" value={shot.duration} min={0.5} step={0.5} onChange={(duration) => setShot({ duration: Math.max(0.5, duration) })} />
              <Select
                label="Transición de entrada"
                value={shot.transitionIn.type}
                options={[
                  { value: 'cut', label: 'Corte' },
                  { value: 'fade', label: 'Fundido desde negro' },
                ]}
                onChange={(type) => setShot({ transitionIn: { ...shot.transitionIn, type, duration: type === 'fade' ? Math.max(0.3, shot.transitionIn.duration || 1) : 0 } })}
              />
              {shot.transitionIn.type === 'fade' && (
                <Slider label="Duración fundido" value={shot.transitionIn.duration} min={0.1} max={4} step={0.1} onChange={(duration) => setShot({ transitionIn: { ...shot.transitionIn, duration } })} />
              )}
            </Section>
            <Section title="Proyecto">
              <TextField label="Nombre" value={project.name} onChange={(name) => onChange({ ...project, name })} />
              <Select
                label="FPS"
                value={String(project.fps) as '24' | '30'}
                options={[
                  { value: '24', label: '24 fps' },
                  { value: '30', label: '30 fps' },
                ]}
                onChange={(v) => onChange({ ...project, fps: v === '30' ? 30 : 24 })}
              />
              <NumberField label="Semilla" value={project.seed} step={1} onChange={(seed) => onChange({ ...project, seed: Math.max(0, Math.round(seed)) })} />
              <p className="note">Resolución de captura: {project.width}×{project.height}</p>
            </Section>
          </>
        )}

        {tab === 'camara' && (
          <Section title="Cámara">
            <Select
              label="Tipo de plano"
              value={shot.camera.type}
              options={(Object.keys(CAMERA_LABELS) as CameraType[]).map((k) => ({ value: k, label: CAMERA_LABELS[k] }))}
              onChange={(type) => setShot({ camera: { type, ...CAMERA_PRESETS[type] } })}
            />
            <Slider label="Distancia (m)" value={shot.camera.distance} min={0.6} max={120} step={0.1} onChange={(distance) => setCam({ distance })} />
            <Slider label="Altura (m)" value={shot.camera.height} min={0.2} max={40} step={0.05} onChange={(height) => setCam({ height })} />
            <Slider label="Horizonte" value={shot.camera.horizon} min={-0.5} max={1.2} step={0.01} onChange={(horizon) => setCam({ horizon })} hint="Posición de la línea del horizonte en pantalla (inclina la cámara)" />
            <Slider label="Zoom" value={shot.camera.zoom} min={0.3} max={4} step={0.01} onChange={(zoom) => setCam({ zoom })} />
            <Slider label="Desplazamiento X (m)" value={shot.camera.offsetX} min={-5} max={5} step={0.01} onChange={(offsetX) => setCam({ offsetX })} />
            <Slider label="Seguimiento" value={shot.camera.follow} min={0} max={1} step={0.01} onChange={(follow) => setCam({ follow })} hint="0 = cámara fija · 1 = sigue al personaje" />
            <h4>Movimiento durante el plano</h4>
            <Slider label="Paneo / travelling X (m)" value={shot.camera.moveX} min={-30} max={30} step={0.1} onChange={(moveX) => setCam({ moveX })} />
            <Slider label="Grúa vertical (m)" value={shot.camera.moveY} min={-10} max={20} step={0.05} onChange={(moveY) => setCam({ moveY })} />
            <Slider label="Zoom final (×)" value={shot.camera.zoomTo} min={0.3} max={3} step={0.01} onChange={(zoomTo) => setCam({ zoomTo })} />
          </Section>
        )}

        {tab === 'personaje' && <ActorTab project={project} onProject={onChange} shot={shot} localT={localT} setShot={setShot} />}

        {tab === 'escena' && (
          <>
            <Section title={`Locación — ${loc.name}`}>
              <p className="note">{loc.description}</p>
              {loc.paramDefs.map((d) => (
                <Slider
                  key={d.key}
                  label={d.label}
                  value={Number(shot.locationParams[d.key] ?? loc.params[d.key])}
                  min={d.min}
                  max={d.max}
                  step={d.step}
                  onChange={(v) => setShot({ locationParams: { ...shot.locationParams, [d.key]: v } })}
                />
              ))}
              <button className="small" onClick={() => setShot({ locationParams: {} })}>
                Restaurar valores de la locación
              </button>
            </Section>
            <Section title="Viento">
              <Slider label="Fuerza" value={shot.wind.strength} min={0} max={2} step={0.01} onChange={(strength) => setShot({ wind: { ...shot.wind, strength } })} />
              <Select
                label="Dirección"
                value={shot.wind.direction < 0 ? '-1' : '1'}
                options={[
                  { value: '-1', label: '← hacia la izquierda' },
                  { value: '1', label: '→ hacia la derecha' },
                ]}
                onChange={(v) => setShot({ wind: { ...shot.wind, direction: Number(v) } })}
              />
              <Slider label="Ráfagas" value={shot.wind.gust} min={0} max={1.5} step={0.01} onChange={(gust) => setShot({ wind: { ...shot.wind, gust } })} />
            </Section>
          </>
        )}

        {tab === 'color' && (
          <ColorTab project={project} shot={shot} localT={localT} keyMode={keyMode} setKeyMode={setKeyMode} setShot={setShot} onProject={onChange} />
        )}

        {tab === 'ascii' && (
          <>
            <Section title="Efectos">
              <Toggle label="Partículas" value={shot.effects.particles} onChange={(particles) => setShot({ effects: { ...shot.effects, particles } })} />
              <Slider label="Cantidad de partículas" value={shot.effects.particleDensity} min={0} max={2} step={0.01} onChange={(particleDensity) => setShot({ effects: { ...shot.effects, particleDensity } })} />
              <Toggle label="Bancos de niebla" value={shot.effects.fogBands} onChange={(fogBands) => setShot({ effects: { ...shot.effects, fogBands } })} />
              <Toggle label="Meteoros" value={shot.effects.meteors} onChange={(meteors) => setShot({ effects: { ...shot.effects, meteors } })} />
              <Slider label="Grano analógico" value={shot.effects.grain} min={0} max={1.5} step={0.01} onChange={(grain) => setShot({ effects: { ...shot.effects, grain } })} />
              <Slider label="Viñeta" value={shot.effects.vignette} min={0} max={1} step={0.01} onChange={(vignette) => setShot({ effects: { ...shot.effects, vignette } })} />
              <Slider label="Líneas de barrido" value={shot.effects.scanlines} min={0} max={1} step={0.01} onChange={(scanlines) => setShot({ effects: { ...shot.effects, scanlines } })} />
              <Slider label="Glitch sutil" value={shot.effects.glitch} min={0} max={1} step={0.01} onChange={(glitch) => setShot({ effects: { ...shot.effects, glitch } })} />
            </Section>
            <AsciiOverrideSection project={project} shot={shot} setShot={setShot} />
          </>
        )}
      </div>
    </div>
  );
}

function ActorTab({
  project,
  onProject,
  shot,
  localT,
  setShot,
}: {
  project: Project;
  onProject: (p: Project) => void;
  shot: Shot;
  localT: number;
  setShot: (p: Partial<Shot>) => void;
}) {
  const a = shot.actor;
  // global look of this character (project-wide), on top of its base look (character file)
  const charId = a?.character ?? 'protagonist';
  const look: CharacterLook = project.characters?.[charId] ?? {};
  const baseLook = getCharacter(charId).look ?? {};
  const setLook = (patch: CharacterLook) => {
    const next: CharacterLook = { ...look, ...patch };
    for (const k of Object.keys(next) as (keyof CharacterLook)[]) if (next[k] === undefined) delete next[k];
    onProject({ ...project, characters: { ...(project.characters ?? {}), [charId]: next } });
  };
  if (!a)
    return (
      <Section title="Personaje">
        <p className="note">Este plano no tiene personaje.</p>
        <button
          onClick={() =>
            setShot({ actor: { character: 'protagonist', heading: 'right', start: 0, lane: 0, startWalking: true, speed: 0.75, actions: [] } })
          }
        >
          Añadir protagonista
        </button>
      </Section>
    );
  const setA = (patch: Partial<typeof a>) => setShot({ actor: { ...a, ...patch } });
  const setAction = (i: number, patch: Partial<ActorAction>) => setA({ actions: a.actions.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  return (
    <>
      <Section title="Protagonista">
        <Select
          label="Dirección"
          value={a.heading}
          options={[
            { value: 'right' as Heading, label: '→ Camina a la derecha (perfil derecho)' },
            { value: 'left' as Heading, label: '← Camina a la izquierda (perfil izquierdo)' },
            { value: 'toward' as Heading, label: '↓ Hacia la cámara (vista frontal)' },
            { value: 'away' as Heading, label: '↑ Se aleja (vista de espalda)' },
          ]}
          onChange={(heading) => setA({ heading })}
        />
        <Toggle label="Ya camina al empezar" value={a.startWalking} onChange={(startWalking) => setA({ startWalking })} />
        <Slider label="Velocidad (m/s)" value={a.speed} min={0} max={1.6} step={0.01} onChange={(speed) => setA({ speed })} />
        <Slider label="Posición inicial (m)" value={a.start} min={-20} max={40} step={0.1} onChange={(start) => setA({ start })} />
        <Slider label="Carril / profundidad (m)" value={a.lane} min={-10} max={30} step={0.1} onChange={(lane) => setA({ lane })} />
        <button className="small" onClick={() => setShot({ actor: null })}>
          Quitar personaje del plano
        </button>
      </Section>
      <p className="note global-note">
        Rostro, cabello y caminata son <b>globales</b>: pertenecen al personaje y se aplican en todos los planos del proyecto.
      </p>
      <GaitSection base={baseLook.gait} gait={look.gait} onChange={(gait) => setLook({ gait })} />
      <FaceSection base={baseLook.face} face={look.face} onChange={(face) => setLook({ face })} />
      <Section
        title="Acciones en el tiempo"
        right={
          <button className="small" onClick={() => setA({ actions: [...a.actions, { t: Number(localT.toFixed(2)), type: 'look', look: 'up' }] })}>
            + en t={localT.toFixed(2)}
          </button>
        }
      >
        {a.actions.length === 0 && <p className="note">Sin acciones. Añade "detenerse", "caminar" o "mirar" en el tiempo actual.</p>}
        {a.actions
          .map((x, i) => ({ x, i }))
          .sort((p, q) => p.x.t - q.x.t)
          .map(({ x, i }) => (
            <div key={i} className="action-row">
              <input className="num" type="number" step={0.1} value={x.t} onChange={(e) => setAction(i, { t: Math.max(0, Number(e.target.value)) })} />
              <select value={x.type} onChange={(e) => setAction(i, { type: e.target.value as ActorAction['type'] })}>
                <option value="walk">caminar</option>
                <option value="stop">detenerse</option>
                <option value="look">mirar</option>
              </select>
              {x.type === 'walk' && (
                <input className="num" type="number" step={0.05} min={0.1} max={1.6} value={x.speed ?? a.speed} onChange={(e) => setAction(i, { speed: Number(e.target.value) })} />
              )}
              {x.type === 'look' && (
                <select value={x.look ?? 'forward'} onChange={(e) => setAction(i, { look: e.target.value as LookTarget })}>
                  <option value="forward">al frente</option>
                  <option value="up">hacia arriba</option>
                  <option value="down">hacia abajo</option>
                  <option value="back">hacia atrás</option>
                  <option value="camera">a cámara</option>
                  <option value="tilt">inclinar cabeza</option>
                </select>
              )}
              <button className="small danger" onClick={() => setA({ actions: a.actions.filter((_, k) => k !== i) })} title="Eliminar acción">
                ×
              </button>
            </div>
          ))}
      </Section>
    </>
  );
}

function ColorTab(props: {
  project: Project;
  shot: Shot;
  localT: number;
  keyMode: boolean;
  setKeyMode: (v: boolean) => void;
  setShot: (p: Partial<Shot>) => void;
  onProject: (p: Project) => void;
}) {
  const { project, shot, localT, keyMode, setKeyMode, setShot, onProject } = props;
  const g = evalGrade(shot.grade, shot.gradeKeys, localT);
  const setValue = (k: NumericGradeKey, v: number) => {
    if (!keyMode) {
      // with keys present the key values win for that property; edit base otherwise
      setShot({ grade: { ...shot.grade, [k]: v } });
      return;
    }
    const keys = [...shot.gradeKeys];
    let idx = keys.findIndex((x) => Math.abs(x.t - localT) < 0.05);
    if (idx < 0) {
      keys.push({ t: Number(localT.toFixed(2)), values: {} });
      idx = keys.length - 1;
    }
    keys[idx] = { ...keys[idx], values: { ...keys[idx].values, [k]: v } };
    keys.sort((a, b) => a.t - b.t);
    setShot({ gradeKeys: keys });
  };
  const keyed = new Set(shot.gradeKeys.flatMap((k) => Object.keys(k.values)));
  const pal = project.palette;
  const setPal = (k: keyof typeof pal, v: string) => onProject({ ...project, palette: { ...pal, [k]: v } });
  return (
    <>
      <Section title="Paleta LOST.DIR (proyecto)">
        <ColorField label="Negro profundo" value={pal.black} onChange={(v) => setPal('black', v)} />
        <ColorField label="Sepia oscuro" value={pal.sepia} onChange={(v) => setPal('sepia', v)} />
        <ColorField label="Rojo sangre" value={pal.blood} onChange={(v) => setPal('blood', v)} />
        <ColorField label="Rojo intenso" value={pal.red} onChange={(v) => setPal('red', v)} />
        <ColorField label="Luz pálida" value={pal.pale} onChange={(v) => setPal('pale', v)} />
      </Section>
      <Section title="Etalonaje" right={<Toggle label="Editar como clave" value={keyMode} onChange={setKeyMode} />}>
        <p className="note">
          {keyMode
            ? `Los cambios se guardan como fotograma clave en t = ${localT.toFixed(2)} s.`
            : 'Los cambios editan el valor base del plano. Activa "Editar como clave" para animar.'}
        </p>
        {GRADE_DEFS.map((d) => (
          <Slider
            key={d.key}
            label={(keyed.has(d.key) ? '◆ ' : '') + d.label}
            value={g[d.key]}
            min={d.min}
            max={d.max}
            step={d.step}
            onChange={(v) => setValue(d.key, v)}
          />
        ))}
        <ColorField label="Color de sombras" value={shot.grade.shadowColor} onChange={(shadowColor) => setShot({ grade: { ...shot.grade, shadowColor } })} />
        <ColorField label="Color de luces" value={shot.grade.highlightColor} onChange={(highlightColor) => setShot({ grade: { ...shot.grade, highlightColor } })} />
      </Section>
      <Section title="Fotogramas clave de color">
        {shot.gradeKeys.length === 0 && <p className="note">Sin claves.</p>}
        {shot.gradeKeys.map((k: GradeKey, i) => (
          <div key={i} className="action-row">
            <input
              className="num"
              type="number"
              step={0.1}
              value={k.t}
              onChange={(e) => {
                const keys = shot.gradeKeys.map((x, j) => (j === i ? { ...x, t: Math.max(0, Number(e.target.value)) } : x));
                setShot({ gradeKeys: keys });
              }}
            />
            <span className="key-vals">
              {Object.entries(k.values)
                .map(([n, v]) => `${GRADE_DEFS.find((d) => d.key === n)?.label ?? n}: ${(v as number).toFixed(2)}`)
                .join(' · ')}
            </span>
            <button className="small danger" onClick={() => setShot({ gradeKeys: shot.gradeKeys.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        <p className="note">Propiedades animables: {NUMERIC_GRADE_KEYS.length}. ◆ = tiene claves.</p>
      </Section>
    </>
  );
}

function FaceSection({ base, face, onChange }: { base?: Partial<FaceParams>; face?: Partial<FaceParams>; onChange: (f: Partial<FaceParams> | undefined) => void }) {
  const F = resolveFace({ ...(base ?? {}), ...(face ?? {}) });
  const set = (patch: Partial<FaceParams>) => onChange({ ...(face ?? {}), ...patch });
  return (
    <Section
      title="Rostro y cabello"
      right={
        face ? (
          <button className="small" onClick={() => onChange(undefined)} title="Vuelve al aspecto base del personaje (data/characters)">
            Restablecer
          </button>
        ) : undefined
      }
    >
      <Select
        label="Estilo"
        value={F.style}
        options={[
          { value: 'v2' as const, label: 'Nuevo (v2): rostro iluminado' },
          { value: 'v1' as const, label: 'Anterior (v1): para comparar' },
        ]}
        onChange={(style) => set({ style })}
      />
      {F.style === 'v2' ? (
        FACE_PARAM_DEFS.map((d) => (
          <Slider key={d.key} label={d.label} value={F[d.key]} min={d.min} max={d.max} step={d.step} onChange={(v) => set({ [d.key]: v } as Partial<FaceParams>)} />
        ))
      ) : (
        <p className="note">El estilo anterior no tiene parámetros; se conserva solo para comparar.</p>
      )}
    </Section>
  );
}

/** Advanced, explicit per-shot ASCII modifications (resolution stays global). */
function AsciiOverrideSection({ project, shot, setShot }: { project: Project; shot: Shot; setShot: (p: Partial<Shot>) => void }) {
  const on = !!shot.asciiOverride;
  const eff = resolveAscii(project, shot);
  const set = (patch: AsciiOverride) => setShot({ asciiOverride: { ...(shot.asciiOverride ?? {}), ...patch } });
  return (
    <Section title="Avanzado: ASCII de este plano">
      <Toggle
        label="Sobrescribir la salida global en este plano"
        value={on}
        onChange={(v) => setShot({ asciiOverride: v ? { glyphGain: eff.glyphGain } : undefined })}
      />
      {!on ? (
        <p className="note">Este plano hereda ASCII Output del proyecto (resolución {eff.cols} columnas, glifos y densidad).</p>
      ) : (
        <>
          <p className="note">La resolución no se puede cambiar por plano: pertenece al proyecto.</p>
          <Select
            label="Paleta de glifos"
            value={eff.charset}
            options={Object.entries(CHARSETS).map(([k, v]) => ({ value: k, label: v.label }))}
            onChange={(charset) => set({ charset })}
          />
          <Slider label="Densidad" value={eff.density} min={0.5} max={1.6} step={0.01} onChange={(density) => set({ density })} />
          <Slider label="Contraste" value={eff.contrast} min={0.5} max={1.8} step={0.01} onChange={(contrast) => set({ contrast })} />
          <Slider label="Nitidez" value={eff.sharpness} min={0} max={1} step={0.01} onChange={(sharpness) => set({ sharpness })} />
          <Slider label="Brillo de glifos" value={eff.glyphGain} min={0.5} max={3} step={0.05} onChange={(glyphGain) => set({ glyphGain })} />
          <Slider label="Resplandor de celda" value={eff.bgGlow} min={0} max={0.6} step={0.01} onChange={(bgGlow) => set({ bgGlow })} />
          <Toggle label="Dithering" value={eff.dither} onChange={(dither) => set({ dither })} />
        </>
      )}
    </Section>
  );
}

function GaitSection({ base, gait, onChange }: { base?: Partial<GaitParams>; gait?: Partial<GaitParams>; onChange: (g: Partial<GaitParams> | undefined) => void }) {
  const G = { ...DEFAULT_GAIT, ...(base ?? {}), ...(gait ?? {}) };
  const set = (patch: Partial<GaitParams>) => onChange({ ...(gait ?? {}), ...patch });
  return (
    <Section
      title="Caminata"
      right={
        gait ? (
          <button className="small" onClick={() => onChange(undefined)}>
            Restablecer
          </button>
        ) : undefined
      }
    >
      <Select
        label="Estilo"
        value={G.style}
        options={[
          { value: 'v2' as const, label: 'Nueva (v2): 12 poses clave, peso' },
          { value: 'v1' as const, label: 'Anterior (v1): para comparar' },
        ]}
        onChange={(style) => set({ style })}
      />
      {GAIT_PARAM_DEFS.map((d) => (
        <Slider key={d.key} label={d.label} value={G[d.key]} min={d.min} max={d.max} step={d.step} onChange={(v) => set({ [d.key]: v } as Partial<GaitParams>)} />
      ))}
      <p className="note">La velocidad está en «Protagonista». Paso, balanceo y secundario recalculan la simulación de capa y pelo.</p>
    </Section>
  );
}
