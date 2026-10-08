import { expect } from 'vitest';
import { FakePanel } from '../mock_paradox.js';
import { captureConsole, loadBridge, loadSpec, setBridgeEnv, specText } from '../support.js';
import { rejection } from './outcomes.js';
import { html } from './responses.js';

export const spec = loadSpec('status_pages');

export const OPERATIONS = [
  ['getStatus', '/statuslive.html'],
  ['sendKeepAlive', '/keep_alive.html'],
];

export const requestRows = (rows, ...operations) => rows.filter((row) => operations.includes(row.operation));

export const httpFailureRows = spec.body_ignoring_responses.filter((row) => 'error' in row.expected);

// The panel's tables are eval-ed in a vm context: their arrays have a foreign prototype, and
// `new Array(n)` has n unset slots. The spec describes both in language-neutral terms.
export const plain = (list) => (list.length > 0 && Object.keys(list).length === 0 ? { empty_slots: list.length } : Array.from(list));

export const plainStatus = (status) => ({
  ...status,
  statuszone: plain(status.statuszone),
  useraccess: plain(status.useraccess),
  alarms: plain(status.alarms),
});

export async function startBridge(panelOptions) {
  const logs = captureConsole();
  const panel = await new FakePanel(panelOptions).start();
  setBridgeEnv({ HOSTNAME: panel.hostname });
  return { panel, logs, ...loadBridge().load('api/status.js') };
}

export async function expectParsedStatus({ page, expected }) {
  const { panel, getStatus } = await startBridge();
  panel.respondWith('/statuslive.html', html(specText(page)));

  if ('error' in expected) {
    const error = await rejection(getStatus());
    expect(error.message).toBe(expected.error);
  } else {
    expect(plainStatus(await getStatus())).toEqual(expected);
  }
}

export async function expectKeepAliveOutcome({ response, expected }) {
  const { panel, sendKeepAlive } = await startBridge();
  panel.respondWith('/keep_alive.html', html(specText(response.body), response.status));

  if ('error' in expected) {
    const error = await rejection(sendKeepAlive());
    expect(error.message).toBe(expected.error);
  } else {
    await expect(sendKeepAlive()).resolves.toBeUndefined();
  }
}

export async function expectRequestAsSent({ operation, request, absent_headers: absentHeaders }) {
  const api = await startBridge();

  await api[operation]();

  expect(api.panel.requestLines).toEqual([request]);
  const { headers } = api.panel.requests[0];
  for (const name of absentHeaders) expect(headers).not.toHaveProperty(name);
  expect(Object.keys(headers).filter((name) => !['host', 'connection'].includes(name)).sort()).toEqual(['accept', 'user-agent']);
  expect(headers.accept).toBe('application/json, text/plain, */*');
  expect(headers['user-agent']).toMatch(/^axios\//);
}
