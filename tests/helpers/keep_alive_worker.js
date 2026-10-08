import { FakePanel } from '../mock_paradox.js';
import { captureConsole, loadBridge, setBridgeEnv, useFakeClock } from '../support.js';

export const KEEP_ALIVE = '/keep_alive.html';

export const KEEP_ALIVE_LINE = 'GET /keep_alive.html?msgid=1';

export async function boot(panelOptions = {}) {
  const logs = captureConsole();
  const panel = await new FakePanel(panelOptions).start();
  setBridgeEnv({ HOSTNAME: panel.hostname });
  const clock = useFakeClock();
  const { keepAlive } = loadBridge().load('keep_alive_worker.js');
  return { panel, logs, clock, keepAlive };
}
