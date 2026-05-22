// ─────────────────────────────────────────────────────────────
//  mythos-router :: crypto/keys.ts
//  Ed25519 keypair management for SWD receipt signing.
//
//  Keys live at ~/.mythos-router/keys/ and are local-first by
//  design. Treat the private key like an SSH key — it identifies
//  you as the signer of every receipt produced on this machine.
//
//  Public-API surface is intentionally small. The signing flow:
//   1. generateKeyPair() once per machine
//   2. createSWDReceipt() picks up the key automatically
//   3. Receipts get a `signature` block with the public key embedded
//   4. Verifiers run `mythos receipts verify` to check
// ─────────────────────────────────────────────────────────────

import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Storage layout ───────────────────────────────────────────
// Paths are computed on each call rather than memoized so that tests
// can redirect via HOME / USERPROFILE without re-importing the module.
const PRIVATE_KEY_FILE = 'ed25519.priv';
const PUBLIC_KEY_FILE = 'ed25519.pub';
const KEY_META_FILE = 'key.json';

export interface KeyMetadata {
  keyId: string;
  algorithm: 'ed25519';
  created: string;
}

export interface KeyPair {
  keyId: string;
  publicKeyPem: string;
  privateKeyPath: string;
  publicKeyPath: string;
  metadataPath: string;
  created: string;
}

// ── Public surface ───────────────────────────────────────────
export function getKeysDir(): string {
  return join(homedir(), '.mythos-router', 'keys');
}

export function getPrivateKeyPath(): string {
  return join(getKeysDir(), PRIVATE_KEY_FILE);
}

export function getPublicKeyPath(): string {
  return join(getKeysDir(), PUBLIC_KEY_FILE);
}

export function getKeyMetadataPath(): string {
  return join(getKeysDir(), KEY_META_FILE);
}

export function hasKeyPair(): boolean {
  return existsSync(getPrivateKeyPath()) && existsSync(getPublicKeyPath());
}

/**
 * Derive a stable, short identifier from a public key. SHA-256 of the
 * raw public key bytes, first 16 hex chars. Distinct from the integrity
 * hash inside receipts so the two can't be confused.
 */
export function computeKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const fingerprint = createHash('sha256').update(der).digest('hex');
  return `sha256:${fingerprint.slice(0, 16)}`;
}

/**
 * Generate a new Ed25519 keypair on disk. Refuses to overwrite an
 * existing key unless `force` is true — accidentally regenerating a key
 * invalidates every receipt previously produced on this machine.
 */
export function generateKeyPair(force = false): KeyPair {
  if (hasKeyPair() && !force) {
    throw new Error(
      `A signing key already exists at ${getPrivateKeyPath()}. ` +
      `Pass force=true to overwrite (this invalidates prior signatures).`
    );
  }

  const keysDir = getKeysDir();
  mkdirSync(keysDir, { recursive: true });
  // Tighten directory perms when possible — best effort on POSIX,
  // no-op on Windows.
  try { chmodSync(keysDir, 0o700); } catch { /* ignore */ }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const keyId = computeKeyId(publicKey);
  const created = new Date().toISOString();

  const privPath = getPrivateKeyPath();
  const pubPath = getPublicKeyPath();
  const metaPath = getKeyMetadataPath();

  writeFileSync(privPath, privatePem, { encoding: 'utf-8' });
  writeFileSync(pubPath, publicPem, { encoding: 'utf-8' });
  writeFileSync(metaPath, JSON.stringify({ keyId, algorithm: 'ed25519', created }, null, 2) + '\n', 'utf-8');

  // Owner-only read/write on the private key. Best-effort on Windows.
  try { chmodSync(privPath, 0o600); } catch { /* ignore */ }
  try { chmodSync(pubPath, 0o644); } catch { /* ignore */ }
  try { chmodSync(metaPath, 0o644); } catch { /* ignore */ }

  return {
    keyId,
    publicKeyPem: publicPem,
    privateKeyPath: privPath,
    publicKeyPath: pubPath,
    metadataPath: metaPath,
    created,
  };
}

export function loadPrivateKey(): KeyObject | null {
  const path = getPrivateKeyPath();
  if (!existsSync(path)) return null;
  try {
    return createPrivateKey({ key: readFileSync(path, 'utf-8'), format: 'pem' });
  } catch {
    return null;
  }
}

export function loadPublicKey(): KeyObject | null {
  const path = getPublicKeyPath();
  if (!existsSync(path)) return null;
  try {
    return createPublicKey({ key: readFileSync(path, 'utf-8'), format: 'pem' });
  } catch {
    return null;
  }
}

export function loadPublicKeyPem(): string | null {
  const path = getPublicKeyPath();
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function loadKeyMetadata(): KeyMetadata | null {
  const path = getKeyMetadataPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as KeyMetadata;
  } catch {
    return null;
  }
}

/**
 * Sign arbitrary bytes with the local Ed25519 private key.
 * Returns a base64-encoded signature, or null if no key is configured.
 */
export function signData(data: string | Buffer): string | null {
  const priv = loadPrivateKey();
  if (!priv) return null;
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const sig = cryptoSign(null, buf, priv);
  return sig.toString('base64');
}

/**
 * Verify an Ed25519 signature using a caller-supplied public key (PEM).
 * Verifiers may consume receipts produced on machines other than their own,
 * so this function never reads the local key.
 */
export function verifySignature(
  data: string | Buffer,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    const pub = createPublicKey({ key: publicKeyPem, format: 'pem' });
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const sig = Buffer.from(signatureBase64, 'base64');
    return cryptoVerify(null, buf, pub, sig);
  } catch {
    return false;
  }
}
