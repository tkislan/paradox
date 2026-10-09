import { createRequire } from 'node:module';
import { expect } from 'vitest';
import { FakePanel } from '../mock_paradox.js';
import { captureConsole, loadSpec, setBridgeEnv, specText } from '../support.js';
import { rejection } from './outcomes.js';
import { html } from './responses.js';

const require = createRequire(import.meta.url);

export const spec = loadSpec('status_pages');

export const COMMANDS = ['arm', 'disarm'];

export const requestRows = (rows, ...operations) => rows.filter((row) => operations.includes(row.operation));

export async function startBridge(panelOptions) {
  captureConsole();
  const panel = await new FakePanel(panelOptions).start();
  setBridgeEnv({ HOSTNAME: panel.hostname });
  return { panel, ...require('../../src/api/alarm.js'), getStatus: require('../../src/api/status.js').getStatus };
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

export async function expectResponseHandled(command, { response, expected }) {
  const api = await startBridge();
  api.panel.respondWith('/statuslive.html', html(specText(response.body), response.status));

  if ('error' in expected) {
    const error = await rejection(api[command]());
    expect(error.message).toBe(expected.error);
  } else {
    await expect(api[command]()).resolves.toBeUndefined();
  }
}
