import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKnownBugSpec, loadSpec } from '../support.js';

const TESTS = path.resolve(import.meta.dirname, '..');
const baseNames = (dir, extension) => fs.readdirSync(path.join(TESTS, dir)).filter((file) => file.endsWith(extension)).map((file) => path.basename(file, extension));
const rowsOf = (spec) => Object.values(spec).filter(Array.isArray).flat();
const pinsBug = (row) => 'known_bug' in row;

// A port skips known_bugs/ and spec/known_bugs/ and still has the whole contract, so nothing that pins a defect may live anywhere else.
describe('tests that pin a bug', () => {
  it.each(baseNames('spec', '.json'))('spec/%s.json has no row that pins one', (name) => {
    expect(rowsOf(loadSpec(name)).filter(pinsBug)).toEqual([]);
  });

  it.each(baseNames('spec/known_bugs', '.json'))('spec/known_bugs/%s.json has only rows that pin one', (name) => {
    expect(rowsOf(loadKnownBugSpec(name)).filter((row) => !pinsBug(row))).toEqual([]);
  });

  it('are in known_bugs/, not in unit/, wire/ or system/', () => {
    const marker = ['KNOWN', 'BUG'].join(' ');
    const offenders = ['unit', 'wire', 'system']
      .flatMap((dir) => baseNames(dir, '.test.js').map((name) => `${dir}/${name}.test.js`))
      .filter((file) => fs.readFileSync(path.join(TESTS, file), 'utf8').includes(marker));

    expect(offenders).toEqual([]);
  });
});
