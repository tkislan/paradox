import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tests run the same Babel output production ships (`npm run build`), not src/ directly: src/ is
// Flow-annotated CommonJS that Vite cannot load. Source maps let coverage map back onto src/.
export default function buildBridge() {
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
