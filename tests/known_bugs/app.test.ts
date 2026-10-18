import { describe, it } from 'vitest';
import { loadKnownBugSpec, withTitle } from '../support.ts';
import { runScenario } from '../helpers/app.ts';
import { KnownBugSystemScenariosSpec } from '../spec/schemas.ts';

const spec = loadKnownBugSpec('system_scenarios', KnownBugSystemScenariosSpec);

describe('scenarios', () => {
  for (const [group, rows] of Object.entries(spec)) {
    if (!Array.isArray(rows)) continue;
    describe(group, () => {
      it.each(withTitle(rows))('$title', runScenario);
    });
  }
});
