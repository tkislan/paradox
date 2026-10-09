import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = path.join(testsDir, 'docker-compose.yml');

export default function setup() {
  startBrokers();
  // PARADOX_KEEP_BROKERS leaves them running: parallel runs (agents, watch mode) share the same instances.
  return process.env.PARADOX_KEEP_BROKERS ? undefined : stopBrokers;
}

const compose = (...args) => execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });

// The MQTT tests run against real Mosquitto brokers (see mosquitto.js); up is a no-op when they already run.
// --no-recreate: a run must never replace containers that other runs are using; after editing
// docker-compose.yml, `docker compose down` in tests/ makes the next run create them afresh.
function startBrokers() {
  try {
    compose('up', '--detach', '--wait', '--no-recreate');
  } catch (error) {
    throw new Error(`Could not start the Mosquitto brokers from tests/docker-compose.yml (is Docker running?)\n${error.stderr || error.message}`);
  }
}

function stopBrokers() {
  compose('down', '--timeout', '1');
}
