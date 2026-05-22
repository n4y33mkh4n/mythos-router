// Cross-platform test runner that works on Node 20+.
// Node 22 expands `--test` glob args itself; Node 20 does not, so we expand
// the test/**/*.test.ts pattern here and pass the file list explicitly.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const files = readdirSync('test', { recursive: true })
  .filter((entry) => /\.test\.ts$/.test(entry))
  .map((entry) => join('test', entry));

if (files.length === 0) {
  console.error('No test files found under test/');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
