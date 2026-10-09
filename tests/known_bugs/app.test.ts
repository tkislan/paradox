import { describe, expect, it } from 'vitest';
import { loadKnownBugSpec, waitFor, withTitle } from '../support.ts';
import { login } from '../fixtures/app.ts';
import { createBridge, runScenario } from '../helpers/app.ts';

const spec = loadKnownBugSpec('system_scenarios');

describe('scenarios', () => {
  const groups = Object.keys(spec).filter((group) => Array.isArray(spec[group]));
  for (const group of groups) {
    describe(group, () => {
      it.each(withTitle(spec[group]))('$title', runScenario);
    });
  }
});

describe('logging', () => {
  it('KNOWN BUG KB-35: a login request failing with HTTP 500 is logged as the whole axios error, whose request params hold the hashed panel username and password', async () => {
    const world = await createBridge({ panel: { faults: [{ path: '/default.html', kind: 'http_500' }] } });

    world.load();
    await waitFor(() => world.exitCodes().length === 1, { message: 'the failed login to end the process' });

    // With the session value, which is logged too, the two hashes allow an offline guess of the (short) panel PIN.
    const loggedParams = world.logs.error.flat().map((entry) => entry?.config?.params).filter(Boolean);
    expect(loggedParams).toEqual([{ u: login.u, p: login.p }]);
    expect(world.logs.log).toContainEqual([`Session value: ${login.session}`]);
  });
});
