export interface CharsetDef {
  label: string;
  /** Characters used for shape matching (edges, curves, structure). */
  shape: string;
  /** Characters used in flat areas (pure density ramp). Auto-sorted by measured ink. */
  ramp: string;
  /** True if it contains non-ASCII glyphs (block elements). */
  extended?: boolean;
}

const PRINTABLE_SHAPE = " .,:;'`\"^~-_=+*<>/\\|()[]{}!?ilIjtfrJ17LcvxzunoaeYTVUCO0QZXdbpqkhgsy2345689mwWMN#%&$@";
/** Structural glyphs + a few rounded lowercase shapes; capitals removed so it never reads as text. */
const CINE_SHAPE = " .,:;'`\"^~-_=+*<>/\\|()[]{}!?ilj1tfrcvxzunoae0#%&@$";

export const CHARSETS: Record<string, CharsetDef> = {
  cine: {
    label: 'Cine — forma + densidad (sin mayúsculas)',
    shape: CINE_SHAPE,
    ramp: " .`',:;~-=+*%#@",
  },
  completo: {
    label: 'ASCII completo (incluye letras)',
    shape: PRINTABLE_SHAPE,
    ramp: " .`',:;~-=+*o%#@",
  },
  estructura: {
    label: 'Estructura — sin letras',
    shape: " .,:;'`^~-_=+*<>/\\|()[]{}!#%&@",
    ramp: " .,:;-=+*#%@",
  },
  lostdir: {
    label: 'LOST.DIR — rampa del visualizer original',
    shape: " .'`^,:;~-+=*xX#0QZ%8@",
    ramp: " .'`^,:;~-+=*xX#0QZ%8@",
  },
  minimal: {
    label: 'Mínimo',
    shape: ' .:-=+*#%@',
    ramp: ' .:-=+*#%@',
  },
  extendido: {
    label: 'Extendido — incluye bloques ░▒▓ (no ASCII puro)',
    shape: PRINTABLE_SHAPE + '░▒▓▀▄▌▐',
    ramp: ' .:-=+*░▒▓',
    extended: true,
  },
};

export const DEFAULT_CHARSET = 'cine';
