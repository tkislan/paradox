import { FakePanel } from '../mock_paradox.js';
import { captureConsole, loadBridge, loadSpec, setBridgeEnv } from '../support.js';

export const spec = loadSpec('status_pages');

export const OPERATIONS = [
  ['getStatus', '/statuslive.html'],
  ['sendKeepAlive', '/keep_alive.html'],
];

export const requestRows = (...operations) => spec.requests.filter((row) => operations.includes(row.operation));

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
