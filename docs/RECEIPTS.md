# SWD Receipts — Verification Protocol

This document describes the on-disk shape of a Mythos Router SWD receipt and the steps required to verify one independently of the `mythos` CLI.

A receipt is the audit artifact of a single AI-assisted file-operation turn. It records:

- **Request context** — the user prompt, model, provider, token usage
- **File changes** — per-file `before` and `after` SHA-256 snapshots
- **SWD outcome** — verification status, errors, rollback status
- **Integrity** — SHA-256 over the receipt payload
- **Signature** (optional) — Ed25519 signature over the integrity hash, plus the embedded public key

Receipts are stored locally at `.mythos/receipts/<id>.json`. They are not transmitted to any remote service.

## Receipt JSON Schema (v1)

```jsonc
{
  "id": "swd-20260522T143012-1a2b3c4d5e",
  "version": 1,
  "timestamp": "2026-05-22T14:30:12.123Z",
  "request": "...the user prompt (with secrets redacted)...",
  "summary": "MODIFY: src/index.ts; CREATE: src/utils.ts",
  "fileCount": 2,
  "files": [
    {
      "path": "src/index.ts",
      "operation": "MODIFY",
      "intent": "MUTATE",
      "status": "verified",
      "detail": "Verified: MODIFY src/index.ts",
      "before": { "path": "src/index.ts", "exists": true, "size": 1832, "mtime": 1716392812000, "sha256": "..." },
      "after":  { "path": "src/index.ts", "exists": true, "size": 1904, "mtime": 1716392832000, "sha256": "..." },
      "expected": { "...": "same as `after` for non-DELETE operations" },
      "expectedSource": "after"
    }
  ],
  "swd": {
    "success": true,
    "rolledBack": false,
    "errors": [],
    "rollbackErrors": []
  },
  "provider": { "providerId": "anthropic", "modelId": "claude-opus-4-7", "latencyMs": 4321 },
  "usage":    { "inputTokens": 12345, "outputTokens": 6789, "totalTokens": 19134 },
  "budget":   { "sessionTotalTokens": 19134, "sessionTurns": 1, "estimatedCostUSD": 0.2312 },
  "git":      { "branch": "main", "commit": "abc123..." },
  "integrity": { "sha256": "<sha256(payload)>" },
  "signature": {
    "algorithm": "ed25519",
    "keyId": "sha256:1a2b3c4d5e6f7890",
    "publicKey": "-----BEGIN PUBLIC KEY-----\nMC...==\n-----END PUBLIC KEY-----\n",
    "signature": "<base64-encoded 64-byte Ed25519 signature>",
    "signedAt": "2026-05-22T14:30:12.456Z"
  }
}
```

## Verification Steps

You can verify a receipt without the `mythos` CLI installed — only Node.js (or any environment with a SHA-256 hasher and an Ed25519 verifier) is required.

### 1. Integrity check

The integrity hash is `sha256(json_payload)` where `json_payload` is the receipt object with `integrity` and `signature` fields removed.

```javascript
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receipt = JSON.parse(readFileSync('path/to/receipt.json', 'utf-8'));
const { integrity, signature, ...payload } = receipt;
const computed = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const integrityOk = computed === integrity.sha256;
```

If `integrityOk` is false, the receipt body has been edited since it was written.

### 2. Signature check (if signed)

The signature is computed as `ed25519_sign(privateKey, integrity.sha256)` — that is, the signature attests to the integrity hash, which transitively attests to the payload.

```javascript
import { verify, createPublicKey } from 'node:crypto';

if (receipt.signature) {
  const pub = createPublicKey({ key: receipt.signature.publicKey, format: 'pem' });
  const sig = Buffer.from(receipt.signature.signature, 'base64');
  const data = Buffer.from(receipt.integrity.sha256, 'utf-8');
  const signatureOk = verify(null, data, pub, sig);
}
```

A valid signature combined with a valid integrity hash means: the receipt body has not been edited **and** the receipt was produced by the holder of the private key matching the embedded public key.

### 3. File-state check (optional)

To confirm the on-disk files still match what the receipt recorded, compute SHA-256 of each file in `receipt.files[*].path` and compare against `expected.sha256` (which equals `after.sha256` for CREATE/MODIFY operations, or `after.sha256` for DELETE — i.e. the state expected to result from the operation).

## Trust Model

- **Tamper-evident**: the integrity hash detects any byte-level change to the receipt body.
- **Tamper-resistant**: when signed, the receipt is bound to a specific private key. An attacker who modifies the body and re-hashes will not have the private key to produce a matching signature.
- **Trust on first sign**: the public key is embedded in the receipt itself. An external auditor must verify out-of-band that the embedded public key actually belongs to the claimed signer — for example, by checking the key fingerprint (`keyId`) against a known-good registry, a developer's profile, or a GPG-signed publication.
- **No transparency log** in this release. A receipt cannot prove "this is the only receipt that was signed by this key" — that requires sigstore/Rekor or an equivalent append-only log, planned for a later iteration.

## Key Management

Keys live at `~/.mythos-router/keys/` with mode `0600` on the private key. The CLI never transmits the private key. If you want to provide a portable identity (e.g. a CI service account), copy the key files to the equivalent path on the target machine; permissions are re-applied on subsequent `keygen` runs but not on copy — set them manually with `chmod 600`.

To rotate: `mythos receipts keygen --force`. All receipts signed by the previous key remain verifiable (the public key is embedded in each receipt), but new receipts will be signed by the new key. There is no automatic notification to downstream verifiers — communicate rotations out-of-band.

## What Receipts Are Not

- Not a replacement for `git`: receipts attest to what the AI tool claimed to do, not the canonical project history.
- Not a substitute for code review: a signed receipt with `swd.success: true` only means the model's claims matched the filesystem at the moment of writing; it does not imply the changes are correct, safe, or aligned with project goals.
- Not encrypted: receipts are plaintext JSON. The user prompt and file paths are visible to anyone who can read the receipt file. The CLI redacts obvious secrets (API keys) before writing, but the redaction is best-effort.
