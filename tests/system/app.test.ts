import { describe, expect, it } from 'vitest';
import { waitFor, withTitle } from '../support.ts';
import { login, spec } from '../fixtures/app.ts';
import { createBridge, runScenario } from '../helpers/app.ts';
import { expectNoCredentials } from '../helpers/outcomes.ts';

describe('scenarios', () => {
  for (const [group, rows] of Object.entries(spec)) {
    if (!Array.isArray(rows)) continue;
    describe(group, () => {
      it.each(withTitle(rows))('$title', runScenario);
    });
  }
});

describe('logging', () => {
  it('a login request failing with HTTP 500 is logged without the hashed panel username and password', async () => {
    const world = await createBridge({ panel: { faults: [{ path: '/default.html', kind: 'http_500' }] } });

    world.load();
    await waitFor(() => world.exitCodes().length === 1, { message: 'the failed login to end the process' });

    // The session value is logged as well, and with it the two hashes would allow an offline guess of the short panel code.
    expect(world.logs.error.length).toBeGreaterThan(0);
    expectNoCredentials(world.logs, login);
  });
});
