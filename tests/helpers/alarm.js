import { FakePanel } from '../mock_paradox.js';
import { captureConsole, loadBridge, loadSpec, setBridgeEnv } from '../support.js';

export const spec = loadSpec('status_pages');

export const COMMANDS = ['arm', 'disarm'];

export const requestRows = (...operations) => spec.requests.filter((row) => operations.includes(row.operation));

export async function startBridge(panelOptions) {
  captureConsole();
  const panel = await new FakePanel(panelOptions).start();
  setBridgeEnv({ HOSTNAME: panel.hostname });
  const { load } = loadBridge();
  return { panel, ...load('api/alarm.js'), getStatus: load('api/status.js').getStatus };
}
