import { describe, it } from 'vitest';
import { withTitle } from '../support.ts';
import { spec } from '../fixtures/app.ts';
import { runScenario } from '../helpers/app.ts';

describe('scenarios', () => {
  for (const [group, rows] of Object.entries(spec)) {
    if (!Array.isArray(rows)) continue;
    describe(group, () => {
      it.each(withTitle(rows))('$title', runScenario);
    });
  }
});
