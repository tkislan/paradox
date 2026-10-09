import { describe, it } from 'vitest';
import { withTitle } from '../support.ts';
import { spec } from '../fixtures/app.ts';
import { runScenario } from '../helpers/app.ts';

describe('scenarios', () => {
  const groups = Object.keys(spec).filter((group) => Array.isArray(spec[group]));
  for (const group of groups) {
    describe(group, () => {
      it.each(withTitle(spec[group]))('$title', runScenario);
    });
  }
});
