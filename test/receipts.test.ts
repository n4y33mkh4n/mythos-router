import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSWDReceipt,
  listReceipts,
  readReceipt,
  saveSWDReceipt,
  verifyReceipt,
  verifyReceiptIntegrity,
  verifyReceiptSignature,
  sanitizeReceiptOutputTail,
  RECEIPT_OUTPUT_TAIL_MAX_CHARS,
} from '../src/receipts.js';
import { generateKeyPair, hasKeyPair, getKeysDir } from '../src/crypto/keys.js';
import type { SWDRunResult } from '../src/swd.js';

const originalCwd = process.cwd();
let tempDir = '';

describe('SWD receipts', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-receipts-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves, lists, reads, and verifies a receipt', () => {
    const beforeContent = 'before';
    const afterContent = 'after';
    const filePath = 'sample.txt';
    const absPath = join(tempDir, filePath);

    writeFileSync(absPath, afterContent, 'utf-8');

    const runResult: SWDRunResult = {
      success: true,
      rolledBack: false,
      rollbackErrors: [],
      errors: [],
      results: [
        {
          action: {
            path: filePath,
            operation: 'MODIFY',
            intent: 'MUTATE',
            description: 'Update sample file',
          },
          status: 'verified',
          detail: `Verified: MODIFY ${filePath}`,
          before: {
            path: absPath,
            exists: true,
            size: beforeContent.length,
            mtime: 1,
            hash: sha256(beforeContent),
          },
          after: {
            path: absPath,
            exists: true,
            size: afterContent.length,
            mtime: 2,
            hash: sha256(afterContent),
          },
        },
      ],
    };

    const receipt = createSWDReceipt({
      request: 'change sample',
      summary: 'MODIFY: sample.txt',
      result: runResult,
      usage: {
        inputTokens: 100,
        outputTokens: 25,
      },
    });

    const savedPath = saveSWDReceipt(receipt);
    assert.ok(savedPath?.endsWith(`${receipt.id}.json`));

    const listed = listReceipts();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, receipt.id);

    const loaded = readReceipt(receipt.id);
    assert.equal(loaded?.id, receipt.id);
    assert.equal(loaded ? verifyReceiptIntegrity(loaded) : false, true);

    const verification = verifyReceipt(receipt);
    assert.equal(verification.ok, true);
    assert.equal(verification.files[0]!.status, 'ok');
    assert.equal(receipt.files[0]!.after?.path, filePath);
  });

  it('normalizes receipt paths even when cwd is a symlinked project root', (t) => {
    const filePath = 'linked-root.txt';
    const absPath = join(tempDir, filePath);
    const linkParent = mkdtempSync(join(tmpdir(), 'mythos-receipts-link-'));
    const linkDir = join(linkParent, 'project');

    try {
      symlinkSync(tempDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      rmSync(linkParent, { recursive: true, force: true });
      t.skip('Directory symlinks are not available in this environment');
      return;
    }

    try {
      process.chdir(linkDir);
      writeFileSync(absPath, 'linked content', 'utf-8');

      const receipt = createSWDReceipt({
        request: 'change linked file',
        summary: 'MODIFY: linked-root.txt',
        result: {
          success: true,
          rolledBack: false,
          rollbackErrors: [],
          errors: [],
          results: [
            {
              action: {
                path: filePath,
                operation: 'MODIFY',
                intent: 'MUTATE',
                description: 'Update linked-root file',
              },
              status: 'verified',
              detail: `Verified: MODIFY ${filePath}`,
              before: {
                path: absPath,
                exists: true,
                size: 0,
                mtime: 1,
                hash: sha256(''),
              },
              after: {
                path: absPath,
                exists: true,
                size: 'linked content'.length,
                mtime: 2,
                hash: sha256('linked content'),
              },
            },
          ],
        },
      });

      assert.equal(receipt.files[0]!.path, filePath);
      assert.equal(receipt.files[0]!.before?.path, filePath);
      assert.equal(receipt.files[0]!.after?.path, filePath);
      assert.equal(verifyReceipt(receipt).ok, true);
    } finally {
      process.chdir(tempDir);
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it('detects drift from the expected receipt state', () => {
    const filePath = 'drift.txt';
    const absPath = join(tempDir, filePath);
    writeFileSync(absPath, 'expected', 'utf-8');

    const receipt = createSWDReceipt({
      request: 'create drift file',
      summary: 'CREATE: drift.txt',
      result: {
        success: true,
        rolledBack: false,
        rollbackErrors: [],
        errors: [],
        results: [
          {
            action: {
              path: filePath,
              operation: 'CREATE',
              intent: 'MUTATE',
              description: 'Create drift file',
            },
            status: 'verified',
            detail: `Verified: CREATE ${filePath}`,
            before: {
              path: absPath,
              exists: false,
              size: 0,
              mtime: 0,
              hash: '',
            },
            after: {
              path: absPath,
              exists: true,
              size: 'expected'.length,
              mtime: 1,
              hash: sha256('expected'),
            },
          },
        ],
      },
    });

    writeFileSync(absPath, 'changed', 'utf-8');

    const verification = verifyReceipt(receipt);
    assert.equal(verification.ok, false);
    assert.equal(verification.files[0]!.status, 'drifted');
  });

  it('sanitizes receipt test output tails before storage', () => {
    const longPrefix = 'a'.repeat(RECEIPT_OUTPUT_TAIL_MAX_CHARS + 25);
    const output = `${longPrefix}
OPENAI_API_KEY=sk-proj-${'x'.repeat(32)}
Authorization: Bearer ${'y'.repeat(40)}
`;

    const tail = sanitizeReceiptOutputTail(output);

    assert.ok(tail.length <= RECEIPT_OUTPUT_TAIL_MAX_CHARS + '[REDACTED_SECRET]'.length * 2);
    assert.doesNotMatch(tail, /sk-proj-/);
    assert.doesNotMatch(tail, /Bearer y/);
    assert.match(tail, /\[REDACTED_SECRET\]/);
  });

});

describe('SWD receipts — Ed25519 signing', () => {
  const originalHome = process.env.HOME;
  const originalUserprofile = process.env.USERPROFILE;
  let homeDir = '';
  let workDir = '';

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'mythos-signing-home-'));
    workDir = mkdtempSync(join(tmpdir(), 'mythos-signing-work-'));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserprofile;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function buildRunResult(filePath: string, content: string): SWDRunResult {
    const absPath = join(workDir, filePath);
    writeFileSync(absPath, content, 'utf-8');
    return {
      success: true,
      rolledBack: false,
      rollbackErrors: [],
      errors: [],
      results: [
        {
          action: {
            path: filePath,
            operation: 'MODIFY',
            intent: 'MUTATE',
            description: 'Test write',
          },
          status: 'verified',
          detail: `Verified: MODIFY ${filePath}`,
          before: { path: absPath, exists: true, size: 0, mtime: 1, hash: sha256('') },
          after: { path: absPath, exists: true, size: content.length, mtime: 2, hash: sha256(content) },
        },
      ],
    };
  }

  it('produces unsigned receipts when no key exists', () => {
    assert.equal(hasKeyPair(), false);
    const receipt = createSWDReceipt({
      request: 'unsigned-test',
      summary: 'MODIFY: sample.txt',
      result: buildRunResult('sample.txt', 'after'),
    });
    saveSWDReceipt(receipt);
    const persisted = readReceipt(receipt.id);
    assert.ok(persisted, 'receipt should round-trip from disk');
    assert.equal(persisted!.signature, undefined);

    const v = verifyReceipt(persisted!);
    assert.equal(v.signed, false);
    assert.equal(v.signatureOk, null);
    assert.equal(v.ok, true);
    assert.equal(verifyReceiptSignature(persisted!), null);
  });

  it('signs new receipts when a local key exists, and verifies them', () => {
    const kp = generateKeyPair();
    assert.ok(kp.keyId.startsWith('sha256:'));
    assert.ok(kp.privateKeyPath.startsWith(getKeysDir()));

    const receipt = createSWDReceipt({
      request: 'signed-test',
      summary: 'MODIFY: signed.txt',
      result: buildRunResult('signed.txt', 'signed-after'),
    });
    saveSWDReceipt(receipt);
    const persisted = readReceipt(receipt.id);
    assert.ok(persisted, 'receipt should round-trip from disk');
    assert.ok(persisted!.signature, 'signed receipt should embed a signature block');
    assert.equal(persisted!.signature!.algorithm, 'ed25519');
    assert.equal(persisted!.signature!.keyId, kp.keyId);
    assert.ok(persisted!.signature!.publicKey.includes('BEGIN PUBLIC KEY'));

    const v = verifyReceipt(persisted!);
    assert.equal(v.signed, true);
    assert.equal(v.signatureOk, true);
    assert.equal(v.signerKeyId, kp.keyId);
    assert.equal(v.ok, true);
    assert.equal(verifyReceiptSignature(persisted!), true);
  });

  it('detects integrity tampering on a signed receipt', () => {
    generateKeyPair();
    const receipt = createSWDReceipt({
      request: 'tamper-test',
      summary: 'MODIFY: tamper.txt',
      result: buildRunResult('tamper.txt', 'original'),
    });
    saveSWDReceipt(receipt);

    // Tamper: edit the receipt JSON to claim a different request.
    const receiptPath = join(workDir, '.mythos', 'receipts', `${receipt.id}.json`);
    const parsed = JSON.parse(readFileSync(receiptPath, 'utf-8'));
    parsed.request = 'malicious-rewrite';
    writeFileSync(receiptPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');

    const tampered = readReceipt(receipt.id);
    assert.ok(tampered);
    assert.equal(verifyReceiptIntegrity(tampered!), false);

    // The signature was over the *original* integrity hash, so an attacker
    // that also re-hashes the payload still can't produce a matching signature.
    parsed.integrity = { sha256: createHash('sha256').update(JSON.stringify({
      ...parsed,
      integrity: undefined,
      signature: undefined,
    })).digest('hex') };
    writeFileSync(receiptPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');

    const reTampered = readReceipt(receipt.id);
    assert.ok(reTampered);
    // Integrity hash now matches the tampered body but signature was over the original.
    assert.equal(verifyReceiptIntegrity(reTampered!), true);
    assert.equal(verifyReceiptSignature(reTampered!), false);
    assert.equal(verifyReceipt(reTampered!).signatureOk, false);
  });

  it('detects signature tampering', () => {
    generateKeyPair();
    const receipt = createSWDReceipt({
      request: 'sig-tamper',
      summary: 'MODIFY: sig.txt',
      result: buildRunResult('sig.txt', 'whatever'),
    });
    saveSWDReceipt(receipt);

    const receiptPath = join(workDir, '.mythos', 'receipts', `${receipt.id}.json`);
    const parsed = JSON.parse(readFileSync(receiptPath, 'utf-8'));
    // Flip a base64 char near the middle of the signature. Avoid the
    // trailing characters because those may be padding (`==`) on
    // Ed25519's 64-byte signature, where a flip is a no-op after decode.
    const sig = parsed.signature.signature as string;
    const mid = Math.floor(sig.length / 2);
    const flipped = sig.slice(0, mid) + (sig[mid] === 'A' ? 'B' : 'A') + sig.slice(mid + 1);
    parsed.signature.signature = flipped;
    writeFileSync(receiptPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');

    const persisted = readReceipt(receipt.id);
    assert.ok(persisted);
    assert.equal(verifyReceiptSignature(persisted!), false);
    assert.equal(verifyReceipt(persisted!).ok, false);
  });

  it('refuses to overwrite an existing key without force', () => {
    generateKeyPair();
    assert.throws(() => generateKeyPair(), /already exists/);
    // force=true succeeds.
    const replaced = generateKeyPair(true);
    assert.ok(replaced.keyId);
  });

  it('lists unsigned receipts alongside signed ones without errors', () => {
    // First: unsigned receipt.
    const r1 = createSWDReceipt({
      request: 'r1',
      summary: 'MODIFY: a.txt',
      result: buildRunResult('a.txt', 'one'),
    });
    saveSWDReceipt(r1);

    // Then keygen and a signed receipt.
    generateKeyPair();
    const r2 = createSWDReceipt({
      request: 'r2',
      summary: 'MODIFY: b.txt',
      result: buildRunResult('b.txt', 'two'),
    });
    saveSWDReceipt(r2);

    const all = listReceipts(10);
    assert.equal(all.length, 2);
  });
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
