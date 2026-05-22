// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/doctor.ts
//  Health check command — single-shot diagnosis
//
//  Re-runnable counterpart to `mythos init`. Where init scaffolds
//  files once, doctor inspects the current environment, providers,
//  project state, and optional subsystems at any time.
// ─────────────────────────────────────────────────────────────

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { c, BANNER, hr, heading } from '../utils.js';
import { detectProviders, MYTHOSIGNORE_FILE } from '../config.js';
import { getMemoryPath, getDbPath, readMemory } from '../memory.js';
import { getReceiptsDir } from '../receipts.js';

// ── Detection Helpers ────────────────────────────────────────
const SQLITE_MIN_MAJOR = 22;
const SQLITE_MIN_MINOR = 5;
const NODE_MIN_MAJOR = 20;

export function hasNodeSqlite(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function parseNodeVersion(): { major: number; minor: number; raw: string } {
  const raw = process.version;
  const parts = raw.slice(1).split('.');
  return {
    major: parseInt(parts[0] ?? '0', 10),
    minor: parseInt(parts[1] ?? '0', 10),
    raw,
  };
}

// ── Check Types ──────────────────────────────────────────────
export type Severity = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  category: 'environment' | 'providers' | 'project' | 'subsystems';
  label: string;
  severity: Severity;
  detail: string;
  hint?: string;
}

// ── Individual Checks ────────────────────────────────────────
function checkNode(): DoctorCheck {
  const v = parseNodeVersion();
  if (v.major < NODE_MIN_MAJOR) {
    return {
      category: 'environment',
      label: 'Node.js',
      severity: 'fail',
      detail: `${v.raw} (requires >= ${NODE_MIN_MAJOR})`,
      hint: 'Upgrade Node.js: https://nodejs.org',
    };
  }
  return {
    category: 'environment',
    label: 'Node.js',
    severity: 'ok',
    detail: v.raw,
  };
}

function checkSqlite(): DoctorCheck {
  const v = parseNodeVersion();
  const available = hasNodeSqlite();
  if (available) {
    return {
      category: 'environment',
      label: 'node:sqlite',
      severity: 'ok',
      detail: 'available',
    };
  }
  const wantedHint =
    `Node ${SQLITE_MIN_MAJOR}.${SQLITE_MIN_MINOR}+ enables memory FTS5 search, ` +
    `deterministic cache, and the providers telemetry dashboard. ` +
    `The core CLI continues to work without it.`;
  return {
    category: 'environment',
    label: 'node:sqlite',
    severity: 'warn',
    detail: `unavailable on ${v.raw}`,
    hint: wantedHint,
  };
}

function checkGit(): DoctorCheck {
  const isGit = existsSync(resolve(process.cwd(), '.git'));
  return {
    category: 'environment',
    label: 'Git repository',
    severity: isGit ? 'ok' : 'warn',
    detail: isGit ? 'detected' : 'not a git repository',
    hint: isGit
      ? undefined
      : '--branch sandboxing, auto-commit, and CI verification require git.',
  };
}

function checkProviders(): DoctorCheck[] {
  const detected = detectProviders();
  return [
    {
      category: 'providers',
      label: 'Anthropic (Claude)',
      severity: detected.anthropic ? 'ok' : 'fail',
      detail: detected.anthropic ? 'configured' : 'ANTHROPIC_API_KEY not set',
      hint: detected.anthropic
        ? undefined
        : 'Required. Get a key: https://console.anthropic.com/',
    },
    {
      category: 'providers',
      label: 'OpenAI (GPT)',
      severity: detected.openai ? 'ok' : 'warn',
      detail: detected.openai ? 'configured' : 'OPENAI_API_KEY not set (optional fallback)',
    },
    {
      category: 'providers',
      label: 'DeepSeek',
      severity: detected.deepseek ? 'ok' : 'warn',
      detail: detected.deepseek ? 'configured' : 'DEEPSEEK_API_KEY not set (optional fallback)',
    },
  ];
}

function checkMythosignore(): DoctorCheck {
  const target = resolve(process.cwd(), MYTHOSIGNORE_FILE);
  const present = existsSync(target);
  return {
    category: 'project',
    label: MYTHOSIGNORE_FILE,
    severity: present ? 'ok' : 'warn',
    detail: present ? 'present' : 'missing',
    hint: present ? undefined : 'Run `mythos init` to scaffold.',
  };
}

function checkMemory(): DoctorCheck {
  const memPath = getMemoryPath();
  if (!existsSync(memPath)) {
    return {
      category: 'project',
      label: 'MEMORY.md',
      severity: 'warn',
      detail: 'not initialized',
      hint: 'Run `mythos init` or `mythos chat` to create it.',
    };
  }
  try {
    const { entries } = readMemory();
    return {
      category: 'project',
      label: 'MEMORY.md',
      severity: 'ok',
      detail: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
    };
  } catch (err: any) {
    return {
      category: 'project',
      label: 'MEMORY.md',
      severity: 'warn',
      detail: `unreadable: ${err.message}`,
    };
  }
}

function checkMemoryIndex(): DoctorCheck {
  const dbPath = getDbPath();
  const memPath = getMemoryPath();
  if (!existsSync(memPath)) {
    return {
      category: 'subsystems',
      label: 'Memory FTS5 index',
      severity: 'warn',
      detail: 'no MEMORY.md yet',
    };
  }
  if (!hasNodeSqlite()) {
    return {
      category: 'subsystems',
      label: 'Memory FTS5 index',
      severity: 'warn',
      detail: 'disabled (node:sqlite unavailable)',
    };
  }
  const present = existsSync(dbPath);
  return {
    category: 'subsystems',
    label: 'Memory FTS5 index',
    severity: present ? 'ok' : 'warn',
    detail: present ? `present at ${dbPath}` : 'will be rebuilt on next run',
  };
}

function checkReceipts(): DoctorCheck {
  const dir = getReceiptsDir();
  if (!existsSync(dir)) {
    return {
      category: 'subsystems',
      label: 'SWD receipts',
      severity: 'warn',
      detail: 'no receipts yet',
    };
  }
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    return {
      category: 'subsystems',
      label: 'SWD receipts',
      severity: 'ok',
      detail: `${files.length} receipt${files.length === 1 ? '' : 's'} at ${dir}`,
    };
  } catch (err: any) {
    return {
      category: 'subsystems',
      label: 'SWD receipts',
      severity: 'warn',
      detail: `unreadable: ${err.message}`,
    };
  }
}

// ── Orchestration ────────────────────────────────────────────
export function runDoctorChecks(): DoctorCheck[] {
  return [
    checkNode(),
    checkSqlite(),
    checkGit(),
    ...checkProviders(),
    checkMythosignore(),
    checkMemory(),
    checkMemoryIndex(),
    checkReceipts(),
  ];
}

// ── Formatting ───────────────────────────────────────────────
function severityIcon(s: Severity): string {
  if (s === 'ok') return `${c.green}✔${c.reset}`;
  if (s === 'warn') return `${c.yellow}○${c.reset}`;
  return `${c.red}✗${c.reset}`;
}

function categoryTitle(cat: DoctorCheck['category']): string {
  switch (cat) {
    case 'environment': return 'Environment';
    case 'providers': return 'Providers';
    case 'project': return 'Project';
    case 'subsystems': return 'Subsystems';
  }
}

function renderChecks(checks: DoctorCheck[]): void {
  const cats: DoctorCheck['category'][] = ['environment', 'providers', 'project', 'subsystems'];
  for (const cat of cats) {
    const group = checks.filter((x) => x.category === cat);
    if (group.length === 0) continue;
    console.log(`${c.cyan}${c.bold}  ${categoryTitle(cat)}${c.reset}`);
    for (const check of group) {
      console.log(
        `  ${severityIcon(check.severity)} ${c.bold}${check.label}${c.reset} ` +
        `${c.dim}${check.detail}${c.reset}`,
      );
      if (check.hint) {
        console.log(`    ${c.dim}→ ${check.hint}${c.reset}`);
      }
    }
    console.log();
  }
}

// ── Command Interface ────────────────────────────────────────
interface DoctorOptions {
  json?: boolean;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  const checks = runDoctorChecks();
  const failed = checks.filter((c) => c.severity === 'fail').length;
  const warned = checks.filter((c) => c.severity === 'warn').length;

  if (options.json) {
    const payload = {
      ok: failed === 0,
      counts: { fail: failed, warn: warned, ok: checks.length - failed - warned },
      checks,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log(BANNER);
  console.log(heading('HEALTH CHECK'));
  console.log();

  renderChecks(checks);

  console.log(`${c.cyan}${c.bold}  Result${c.reset}`);
  if (failed === 0 && warned === 0) {
    console.log(`  ${c.green}✔${c.reset} All checks passed.`);
  } else if (failed === 0) {
    console.log(`  ${c.green}✔${c.reset} Healthy ${c.dim}(${warned} optional warning${warned === 1 ? '' : 's'})${c.reset}`);
  } else {
    console.log(`  ${c.red}✗${c.reset} ${failed} critical issue${failed === 1 ? '' : 's'} ${c.dim}(${warned} warning${warned === 1 ? '' : 's'})${c.reset}`);
  }
  console.log();
  console.log(hr());

  process.exit(failed > 0 ? 1 : 0);
}
