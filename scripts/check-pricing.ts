#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────
//  scripts/check-pricing.ts
//  Weekly pricing freshness check.
//
//  Cross-references the prices encoded in src/providers/pricing.ts
//  against Anthropic's published pricing docs. Used by the
//  Pricing Freshness Check GitHub workflow to flag silent drift.
//
//  Run locally:   npm run pricing:check
//  JSON output:   npm run pricing:check -- --json
// ─────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { getModelsForProvider, getModelPricing } from '../src/providers/pricing.js';

const ANTHROPIC_PRICING_URL = 'https://docs.anthropic.com/en/docs/about-claude/pricing';
const USER_AGENT = 'mythos-router-pricing-check (https://github.com/n4y33mkh4n/mythos-router)';
const PRICING_FILE = 'src/providers/pricing.ts';
const STALENESS_WARN_DAYS = 90;
const STALENESS_FAIL_DAYS = 180;
const FETCH_TIMEOUT_MS = 20_000;

type Severity = 'fail' | 'warn' | 'info';

interface Finding {
  severity: Severity;
  message: string;
}

interface Report {
  ok: boolean;
  url: string;
  stalenessDays: number;
  findings: Finding[];
}

// ── Helpers ──────────────────────────────────────────────────
function daysSinceLastUpdate(file: string): number {
  try {
    const ts = execFileSync('git', ['log', '-1', '--format=%ct', '--', file], {
      encoding: 'utf-8',
    }).trim();
    if (!ts) return Infinity;
    const lastCommitMs = parseInt(ts, 10) * 1000;
    return Math.floor((Date.now() - lastCommitMs) / (1000 * 60 * 60 * 24));
  } catch {
    return Infinity;
  }
}

// Map an Anthropic API model ID to the display name used on the docs page.
// We use the API ID for sorting but match against the display name in HTML.
function modelToDisplayName(modelId: string): string | null {
  // claude-opus-4-7              → "Claude Opus 4.7"
  // claude-haiku-4-5-20251001    → "Claude Haiku 4.5"
  // claude-haiku-3               → "Claude Haiku 3"     (single-digit version)
  const match = modelId.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i);
  if (!match) return null;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  const major = match[2]!;
  const minor = match[3];
  return minor ? `Claude ${family} ${major}.${minor}` : `Claude ${family} ${major}`;
}

interface RowPrices {
  inputPer1M: number | null;
  outputPer1M: number | null;
}

// Parse the first occurrence of a model's pricing row from the docs HTML.
// The base pricing table has 6 cells: name, base input, 5m cache writes,
// 1h cache writes, cache hits, output. We want cells 1 (input) and 5 (output).
function parseFirstRowPrices(html: string, displayName: string): RowPrices | null {
  const escapedName = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRe = new RegExp(
    `<td[^>]*>${escapedName}<\\/td>(?:(?!<td[^>]*>Claude).)*?<\\/tr>`,
    's',
  );
  const m = rowRe.exec(html);
  if (!m) return null;

  const priceMatches = [
    ...m[0].matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok/g),
  ].map((mm) => parseFloat(mm[1]!));

  if (priceMatches.length < 5) return null;
  // Cells in the row: [base input, 5m cache, 1h cache, cache hits, output]
  return {
    inputPer1M: priceMatches[0] ?? null,
    outputPer1M: priceMatches[4] ?? null,
  };
}

function pricesEqual(a: number, b: number): boolean {
  // Tolerate float vs. integer formatting (e.g. 5 vs 5.00)
  return Math.abs(a - b) < 1e-9;
}

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main(): Promise<Report> {
  const findings: Finding[] = [];
  const stalenessDays = daysSinceLastUpdate(PRICING_FILE);

  if (stalenessDays >= STALENESS_FAIL_DAYS) {
    findings.push({
      severity: 'fail',
      message:
        `${PRICING_FILE} hasn't been touched in ${stalenessDays} days ` +
        `(threshold: ${STALENESS_FAIL_DAYS}). Even if prices haven't changed, ` +
        `please re-verify and bump the file's mtime via a no-op edit.`,
    });
  } else if (stalenessDays >= STALENESS_WARN_DAYS) {
    findings.push({
      severity: 'warn',
      message:
        `${PRICING_FILE} hasn't been touched in ${stalenessDays} days ` +
        `(threshold: ${STALENESS_WARN_DAYS}).`,
    });
  }

  let html: string;
  try {
    html = await fetchWithTimeout(ANTHROPIC_PRICING_URL, FETCH_TIMEOUT_MS);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    findings.push({
      severity: 'warn',
      message: `Failed to fetch ${ANTHROPIC_PRICING_URL}: ${msg}. ` +
        `Cannot verify prices live this run.`,
    });
    return {
      ok: findings.every((f) => f.severity !== 'fail'),
      url: ANTHROPIC_PRICING_URL,
      stalenessDays,
      findings,
    };
  }

  // Cross-check every Claude model in our pricing table.
  const claudeModels = getModelsForProvider('claude-');
  if (claudeModels.length === 0) {
    findings.push({
      severity: 'fail',
      message: 'No Claude models found in the pricing registry. ' +
        'Did the registry move or get cleared?',
    });
  }

  for (const modelId of claudeModels) {
    const display = modelToDisplayName(modelId);
    if (!display) {
      findings.push({
        severity: 'warn',
        message: `${modelId}: cannot derive a display name to look up on the page.`,
      });
      continue;
    }

    const ourPricing = getModelPricing(modelId);
    const ourInputPer1M = ourPricing.inputPerToken * 1_000_000;
    const ourOutputPer1M = ourPricing.outputPerToken * 1_000_000;

    const parsed = parseFirstRowPrices(html, display);
    if (!parsed) {
      findings.push({
        severity: 'warn',
        message: `${modelId} ("${display}"): not found on the pricing page. ` +
          'Model may have been retired by Anthropic, or the page layout changed.',
      });
      continue;
    }

    if (parsed.inputPer1M === null || parsed.outputPer1M === null) {
      findings.push({
        severity: 'warn',
        message: `${modelId} ("${display}"): pricing row found but prices ` +
          'could not be parsed. Page layout may have changed.',
      });
      continue;
    }

    if (!pricesEqual(parsed.inputPer1M, ourInputPer1M)) {
      findings.push({
        severity: 'fail',
        message:
          `${modelId} ("${display}") input price drift: ` +
          `docs say $${parsed.inputPer1M}/MTok, ` +
          `${PRICING_FILE} encodes $${ourInputPer1M}/MTok.`,
      });
    }
    if (!pricesEqual(parsed.outputPer1M, ourOutputPer1M)) {
      findings.push({
        severity: 'fail',
        message:
          `${modelId} ("${display}") output price drift: ` +
          `docs say $${parsed.outputPer1M}/MTok, ` +
          `${PRICING_FILE} encodes $${ourOutputPer1M}/MTok.`,
      });
    }
  }

  const report: Report = {
    ok: findings.every((f) => f.severity !== 'fail'),
    url: ANTHROPIC_PRICING_URL,
    stalenessDays,
    findings,
  };
  return report;
}

// ── Output ───────────────────────────────────────────────────
function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`Pricing freshness check`);
  lines.push(`  Source: ${report.url}`);
  lines.push(`  ${PRICING_FILE} last modified: ${report.stalenessDays} days ago`);
  if (report.findings.length === 0) {
    lines.push(`  Result: OK — all prices verified`);
    return lines.join('\n');
  }
  for (const f of report.findings) {
    const icon = f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '⚠' : 'ℹ';
    lines.push(`  ${icon} [${f.severity}] ${f.message}`);
  }
  const failCount = report.findings.filter((f) => f.severity === 'fail').length;
  const warnCount = report.findings.filter((f) => f.severity === 'warn').length;
  lines.push(`  Result: ${failCount} failure${failCount === 1 ? '' : 's'}, ${warnCount} warning${warnCount === 1 ? '' : 's'}`);
  return lines.join('\n');
}

const json = process.argv.includes('--json');
main()
  .then((report) => {
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(formatReport(report) + '\n');
      // GitHub Actions annotations
      if (process.env.GITHUB_ACTIONS) {
        for (const f of report.findings) {
          const level = f.severity === 'fail' ? 'error' : 'warning';
          process.stdout.write(`::${level}::${f.message}\n`);
        }
      }
    }
    process.exit(report.ok ? 0 : 1);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Pricing check crashed: ${msg}\n`);
    process.exit(2);
  });
