/**
 * Records reference hashes of the LEGACY renderer (default project, 6 shots × 2
 * times at 480×270). tests/legacy-golden.test.ts checks they never change, which
 * proves new renderers did not alter the original engine.
 *
 *   npx tsx scripts/golden-legacy.ts   (only when an intended LEGACY change is made)
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { useNodeCanvas } from './nodeCanvas';
import { renderFrame, resetRuntimes } from '../src/engine/render';
import { defaultProject } from '../src/engine/project/schema';

useNodeCanvas();
export function legacyHashes() {
  const p = defaultProject();
  const out: Record<string, string> = {};
  for (let i = 0; i < p.shots.length; i++)
    for (const t of [1.25, 4.5]) {
      resetRuntimes();
      const r = renderFrame(p, i, t, { width: 480, height: 270 });
      out[`${p.shots[i].id}@${t}`] = createHash('sha1').update(r.data).digest('hex');
    }
  return out;
}
if (process.argv[1]?.includes('golden-legacy')) {
  writeFileSync('tests/golden/legacy-hashes.json', JSON.stringify(legacyHashes(), null, 2) + '\n');
  console.log('written tests/golden/legacy-hashes.json');
}
