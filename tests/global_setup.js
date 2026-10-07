import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..');
const COMPOSE_FILE = path.join(testsDir, 'docker-compose.yml');

export default function setup() {
  startBrokers();
  buildBridge();
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

// Tests run the same Babel output production ships (`npm run build`), not src/ directly: src/ is
// Flow-annotated CommonJS that Vite cannot load. Source maps let coverage map back onto src/.
function buildBridge() {
  if (process.env.PARADOX_BUILD_DIR) return;

  const babel = path.join(repoRoot, 'node_modules/@babel/cli/bin/babel.js');
  const outDir = path.join(repoRoot, 'tests/.build');
  execFileSync(
    process.execPath,
    [babel, 'src', '-d', 'tests/.build', '--source-maps', '--delete-dir-on-start'],
    { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  // tests/package.json says "type": "module", which would make Node load the CommonJS output as ESM.
  fs.writeFileSync(path.join(outDir, 'package.json'), '{ "type": "commonjs" }\n');
}
