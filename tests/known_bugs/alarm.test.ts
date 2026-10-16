import { describe, expect, it } from 'vitest';
import { loadKnownBugSpec, withTitle } from '../support.ts';
import { html } from '../helpers/responses.ts';
import { COMMANDS, expectRequestAsSent, expectResponseHandled, requestRows, startBridge } from '../helpers/alarm.ts';
import { KnownBugStatusPagesSpec } from '../spec/schemas.ts';

const spec = loadKnownBugSpec('status_pages', KnownBugStatusPagesSpec);

describe('requests as sent', () => {
  it.each(withTitle(requestRows(spec.requests, 'arm', 'disarm')))('$title sends exactly $request, with only the HTTP client default headers', expectRequestAsSent);
});

describe.each(COMMANDS)('%s() outcome', (command) => {
  it.each(withTitle(spec.body_ignoring_responses))('$title', (row) => expectResponseHandled(command, row));

  it('KNOWN BUG KB-14: follows a redirect to a page that answers 200 (the index page) and counts that as success', async () => {
    const api = await startBridge();
    api.panel.respondWith('/statuslive.html', html('', 302, { Location: '/index.html' }), { times: 1 });

    await expect(api[command]()).resolves.toBeUndefined();

    expect(api.panel.requestLines).toHaveLength(2);
    expect(api.panel.requestLines[1]).toBe('GET /index.html');
  });
});
