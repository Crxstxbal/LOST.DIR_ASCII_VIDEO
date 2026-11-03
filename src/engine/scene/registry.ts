import type { Generator, LocationDef } from './types';
import { fogBands, meteors, particles, ridges, sky } from './generators/atmosphere';
import { ground, rocks, spires } from './generators/terrain';
import { roseGround, roses } from './generators/roses';
import wasteland from '../../../data/locations/wasteland.json';
import roseField from '../../../data/locations/rose_field.json';
import redField from '../../../data/locations/red_field.json';

/** Generator registry: new generators register here; locations reference them by name in JSON. */
const generators = new Map<string, Generator>();

export function registerGenerator(name: string, g: Generator) {
  generators.set(name, g);
}
export function getGenerator(name: string): Generator | undefined {
  return generators.get(name);
}

registerGenerator('sky', sky);
registerGenerator('ridges', ridges);
registerGenerator('fogBands', fogBands);
registerGenerator('particles', particles);
registerGenerator('meteors', meteors);
registerGenerator('ground', ground);
registerGenerator('spires', spires);
registerGenerator('rocks', rocks);
registerGenerator('roseGround', roseGround);
registerGenerator('roses', roses);

const locations = new Map<string, LocationDef>();
export function registerLocation(def: LocationDef) {
  locations.set(def.id, def);
}
export function getLocation(id: string): LocationDef {
  return locations.get(id) ?? locations.get('wasteland')!;
}
export function listLocations(): LocationDef[] {
  return [...locations.values()];
}

registerLocation(wasteland as unknown as LocationDef);
registerLocation(roseField as unknown as LocationDef);
registerLocation(redField as unknown as LocationDef);
