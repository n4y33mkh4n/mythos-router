# BACKLOG.md — mythos-router

> Engineering work that's correct but not user-impacting today.
> Review when: SDK adoption exists, or during a dedicated hardening cycle.

---

## Runtime Hygiene

### Dream duration tracking
`dream.ts` hardcodes `durationMs: 0` in the session metric. Capture `Date.now()` before the spinner and use it. Pure correctness, no user impact.

---

## System Robustness (Future Scale)

### Orchestrator test coverage
608 lines of scoring, fallback, circuit breaker, and retry logic with zero tests. Create a `MockProvider` implementing `BaseProvider` and test: provider selection by score, fallback chains, circuit breaker trips/resets, retry backoff, deterministic selection.

**When it matters**: Before any significant refactor of the orchestrator, or when adding a new provider.

### Concurrent safety guarantees
After fixing concurrency tracking, add `Promise.all`-based test cases to verify the counter behaves correctly under parallel `streamMessage` calls.

**When it matters**: Only if SDK usage becomes part of the product promise.

---

## Nice-to-Have

| Item | Note |
|------|------|
| `--json` flag for `stats` and `providers` | Machine-readable output for CI/dashboards |
| `mythos init` command | Scaffold `.mythosignore`, `MEMORY.md`, detect project stack |
| Structured error codes in orchestrator | Replace string-matching (`msg.includes('overloaded')`) with typed error categories |
| Telemetry retention query improvement | Current `MAX(id) - N` is fragile with ID gaps; use `ORDER BY id DESC LIMIT` subquery |
| Metrics storage migration | Current JSON read-parse-write-all is fine for years at CLI scale. Revisit if session count exceeds ~5,000 |
