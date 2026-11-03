import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legacyHashes } from '../scripts/golden-legacy';

describe('LEGACY renderer is unchanged', () => {
  it('every reference frame of the default project renders bit-identical', () => {
    const golden = JSON.parse(readFileSync('tests/golden/legacy-hashes.json', 'utf8'));
    expect(legacyHashes()).toEqual(golden);
  });
});
