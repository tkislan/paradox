import { describe, expect, it } from 'vitest';
import { rejection } from '../helpers/outcomes.ts';
import { html } from '../helpers/responses.ts';
import { loadKnownBugSpec, specText, withTitle } from '../support.ts';
import { expectKeepAliveOutcome, startBridge } from '../helpers/status.ts';
import { KnownBugStatusPagesSpec } from '../spec/schemas.ts';

const spec = loadKnownBugSpec('status_pages', KnownBugStatusPagesSpec);

describe('getStatus() page parsing', () => {
  it.each([
    ['the login page', specText({ file: 'data/login_page.html' }), 'tbl_statuszone'],
    ['a page with only the zone table', 'tbl_statuszone = new Array(1,2);', 'tbl_useraccess'],
  ])('KNOWN BUG KB-36: a table the pattern does not find logs the whole page, then the pattern (%s)', async (_, page, failedTable) => {
    const { panel, logs, getStatus } = await startBridge();
    panel.respondWith('/statuslive.html', html(page));

    await rejection(getStatus());

    expect(logs.error).toHaveLength(2);
    expect(logs.error[0]).toEqual([page]);
    expect(logs.error[1][0]).toContain(failedTable);
  });
});

describe('sendKeepAlive()', () => {
  it.each(withTitle(spec.body_ignoring_responses.map((row) => ({ ...row, known_bug: 'KB-28' }))))('$title', expectKeepAliveOutcome);
});
