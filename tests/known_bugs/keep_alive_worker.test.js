import { describe, expect, it, vi } from 'vitest';
import { loadKnownBugSpec, settle, waitFor, withTitle } from '../support.js';
import { KEEP_ALIVE, boot, expectReportedFailures } from '../helpers/keep_alive_worker.js';

const spec = loadKnownBugSpec('status_machine');

describe('keepAlive() request', () => {
  it.each(withTitle(spec.keep_alive_random))('$title', async ({ random, expected_request }) => {
    const { panel, clock, keepAlive } = await boot();
    vi.spyOn(Math, 'random').mockReturnValue(random);
    keepAlive();

    await clock.advance(3000);
    await waitFor(() => panel.requestsTo(KEEP_ALIVE).length === 1, { message: 'the keep-alive' });

    expect(panel.requestLines).toEqual([expected_request]);
    expect(panel.requestsTo(KEEP_ALIVE)[0].query).toEqual({ msgid: '1' });
  });
});

describe('keepAlive() failures', () => {
  it.each(withTitle(spec.keep_alive_failures))('$title', expectReportedFailures);
});

describe('keepAlive() hung panel', () => {
  it('KNOWN BUG KB-13: a keep-alive that is never answered does not delay the next one and is never reported', async () => {
    const { panel, logs, clock, keepAlive } = await boot();
    panel.respondWith(KEEP_ALIVE, { hang: true });
    keepAlive();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await clock.advance(3000);
      await waitFor(() => panel.requestsTo(KEEP_ALIVE).length === attempt, { message: `keep-alive ${attempt}` });
    }
    await settle();

    expect(logs.error).toEqual([]);

    await panel.stop();
    await waitFor(() => logs.error.length === 3, { message: 'the dropped connections to surface' });
  });
});
