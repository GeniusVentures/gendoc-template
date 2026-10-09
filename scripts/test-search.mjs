// Compile real production modules, run isolated Node unit tests, remove output.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'gendoc-search-tests-'));
const tsc = resolve(root, 'ask-ai/worker/node_modules/typescript/bin/tsc');
function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit',
        env: { ...process.env, SEARCH_TEST_OUTPUT: output } });
    if (result.status !== 0) throw new Error(`Check failed: ${args.join(' ')}`);
}
try {
    writeFileSync(join(output, 'package.json'), '{"type":"module"}');
    run([tsc, '-p', 'ask-ai/widget-src', '--outDir', join(output, 'widget')]);
    run([tsc, '-p', 'ask-ai/worker', '--noEmit', 'false', '--outDir', join(output, 'worker')]);
    run(['--test', 'ask-ai/tests/search.test.mjs']);
} finally {
    rmSync(output, { recursive: true, force: true });
}
