import { describe, expect, it } from 'vitest';
import { loadKnownBugSpec, settle, useFakeClock, waitFor, withTitle } from '../support.ts';
import { FLOW_PATHS, expectRequestCounts, startBridge } from '../helpers/login.ts';
import { KnownBugLoginCasesSpec } from '../spec/schemas.ts';

const spec = loadKnownBugSpec('login_cases', KnownBugLoginCasesSpec);

describe('login() against a panel that stops answering', () => {
  it.each(withTitle(spec.hangs))('$title', async (row) => {
    const { panel, login } = await startBridge({ responses: { [row.hang]: { hang: true } } });
    let state = 'pending';
    login().then(() => { state = 'resolved'; }, () => { state = 'rejected'; });

    await waitFor(() => panel.requestsTo(row.hang).length === 1, { message: `a request to ${row.hang}` });
    await settle(100);

    expect(state).toBe('pending');
    expectRequestCounts(panel, Object.fromEntries(FLOW_PATHS.map((p) => [p, row.expected.request_counts[p] ?? 0])));

    // Once the connection drops, a failed index page request is retried 1000 ms apart like any other failure.
    const clock = useFakeClock();
    await panel.stop();
    await waitFor(async () => {
      await clock.advance(1000);
      return state !== 'pending';
    }, { message: 'login() to end once the connection drops' });
    expect(state).toBe('rejected');
  });
});
