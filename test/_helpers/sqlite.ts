// ─────────────────────────────────────────────────────────────
//  test/_helpers/sqlite.ts
//  Runtime detection of node:sqlite availability for conditional
//  test skipping. node:sqlite is Node 22.5+ only; the CLI is
//  expected to degrade gracefully on older runtimes (Node 20).
// ─────────────────────────────────────────────────────────────

import { createRequire } from 'node:module';

let _cached: boolean | null = null;

export function hasNodeSqlite(): boolean {
  if (_cached !== null) return _cached;
  try {
    const req = createRequire(import.meta.url);
    req('node:sqlite');
    _cached = true;
  } catch {
    _cached = false;
  }
  return _cached;
}
