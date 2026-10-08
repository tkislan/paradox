import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_DIR } from '../support.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// The harness needs an MQTT 5 client next to the bridge's mqtt 2.x, so it is installed as the alias `mqtt5`:
// a second package named `mqtt` (or a node_modules under tests/) would shadow the one production installs
// and silently change what the suite tests.
describe('the bridge under test', () => {
  it.each(['axios', 'express', 'mqtt'])('resolves %s from the root project, like production', (name) => {
    const resolved = createRequire(path.join(BUILD_DIR, 'app.js')).resolve(name);

    expect(resolved.startsWith(path.join(REPO_ROOT, 'node_modules', name))).toBe(true);
  });

  it('runs on the mqtt 2.x client', () => {
    const { version } = createRequire(path.join(BUILD_DIR, 'app.js'))('mqtt/package.json');

    expect(version.split('.')[0]).toBe('2');
  });
});
