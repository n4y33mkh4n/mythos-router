import {
  listReceipts,
  readReceipt,
  verifyReceipt,
  verifyReceiptIntegrity,
  type ReceiptSummary,
  type SWDReceipt,
} from '../receipts.js';
import {
  generateKeyPair,
  hasKeyPair,
  loadKeyMetadata,
  loadPublicKeyPem,
  getKeysDir,
  getPrivateKeyPath,
  getPublicKeyPath,
} from '../crypto/keys.js';
import { c, error, heading, hr, info, success, theme, warn } from '../utils.js';

interface ReceiptsOptions {
  limit?: string;
  json?: boolean;
  force?: boolean;
}

export async function receiptsCommand(
  action?: string,
  target?: string,
  options: ReceiptsOptions = {},
): Promise<void> {
  const normalizedAction = (action ?? 'list').toLowerCase();

  if (normalizedAction === 'list') {
    printReceiptList(parseLimit(options.limit), options.json);
    return;
  }

  if (normalizedAction === 'latest') {
    printReceipt('latest', options.json);
    return;
  }

  if (normalizedAction === 'show') {
    printReceipt(target ?? 'latest', options.json);
    return;
  }

  if (normalizedAction === 'verify') {
    printReceiptVerification(target ?? 'latest', options.json);
    return;
  }

  if (normalizedAction === 'keygen') {
    runKeygen(options.force === true, options.json);
    return;
  }

  if (normalizedAction === 'pubkey') {
    printPublicKey(options.json);
    return;
  }

  warn(`Unknown receipts action: ${normalizedAction}`);
  info('Usage: mythos receipts | mythos receipts show latest | mythos receipts verify latest | mythos receipts keygen | mythos receipts pubkey');
}

function runKeygen(force: boolean, asJson?: boolean): void {
  if (hasKeyPair() && !force) {
    const msg =
      `A signing key already exists at ${getPrivateKeyPath()}. ` +
      `Pass --force to overwrite (this invalidates all prior signatures).`;
    if (asJson) {
      console.log(JSON.stringify({ ok: false, reason: 'exists', path: getPrivateKeyPath() }, null, 2));
      process.exitCode = 1;
      return;
    }
    error(msg);
    process.exitCode = 1;
    return;
  }

  try {
    const kp = generateKeyPair(force);
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        keyId: kp.keyId,
        publicKeyPath: kp.publicKeyPath,
        privateKeyPath: kp.privateKeyPath,
        created: kp.created,
      }, null, 2));
      return;
    }
    console.log(heading('Signing Keypair Generated'));
    success(`keyId:      ${c.bold}${kp.keyId}${c.reset}`);
    console.log(`  ${c.dim}Private:   ${kp.privateKeyPath} (mode 0600)${c.reset}`);
    console.log(`  ${c.dim}Public:    ${kp.publicKeyPath}${c.reset}`);
    console.log(`  ${c.dim}Created:   ${kp.created}${c.reset}`);
    console.log();
    info('All future SWD receipts on this machine will be signed automatically.');
    info(`Share your public key with auditors via: ${c.cyan}mythos receipts pubkey${c.reset}`);
    warn('Treat the private key like an SSH key. Never commit or share it.');
  } catch (err: any) {
    error(`Keygen failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function printPublicKey(asJson?: boolean): void {
  if (!hasKeyPair()) {
    const msg = 'No signing key found. Run `mythos receipts keygen` to create one.';
    if (asJson) {
      console.log(JSON.stringify({ ok: false, reason: 'no-key' }, null, 2));
      process.exitCode = 1;
      return;
    }
    warn(msg);
    process.exitCode = 1;
    return;
  }
  const pem = loadPublicKeyPem();
  const meta = loadKeyMetadata();
  if (!pem || !meta) {
    error(`Could not read key material from ${getKeysDir()}`);
    process.exitCode = 1;
    return;
  }
  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      keyId: meta.keyId,
      algorithm: meta.algorithm,
      created: meta.created,
      publicKey: pem,
      publicKeyPath: getPublicKeyPath(),
    }, null, 2));
    return;
  }
  console.log(heading('Mythos Signing Public Key'));
  console.log(`  ${c.dim}keyId:${c.reset}     ${c.bold}${meta.keyId}${c.reset}`);
  console.log(`  ${c.dim}algorithm:${c.reset} ${meta.algorithm}`);
  console.log(`  ${c.dim}created:${c.reset}   ${meta.created}`);
  console.log(`  ${c.dim}path:${c.reset}      ${getPublicKeyPath()}`);
  console.log();
  console.log(pem.trim());
}

function printReceiptList(limit: number, asJson?: boolean): void {
  const receipts = listReceipts(limit);

  if (asJson) {
    console.log(JSON.stringify(receipts, null, 2));
    return;
  }

  console.log(heading('SWD Receipts'));
  if (receipts.length === 0) {
    info('No SWD receipts found yet.');
    return;
  }

  for (const receipt of receipts) {
    const status = formatStatus(receipt);
    const provider = receipt.provider ? `${receipt.provider}/${receipt.model ?? 'unknown'}` : 'unknown';
    console.log(
      `  ${status} ${c.bold}${receipt.id}${c.reset} ${theme.muted}${formatDate(receipt.timestamp)}${c.reset} ` +
      `${theme.info}${receipt.fileCount}${theme.muted} file(s)${c.reset}`,
    );
    console.log(`     ${c.dim}${receipt.summary}${c.reset}`);
    console.log(`     ${c.dim}provider: ${provider} | branch: ${receipt.branch ?? 'none'}${c.reset}`);
  }
}

function printReceipt(target: string, asJson?: boolean): void {
  const receipt = readReceipt(target);
  if (!receipt) {
    error(`Receipt not found: ${target}`);
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  console.log(heading(`SWD Receipt ${receipt.id}`));
  printReceiptHeader(receipt);
  console.log(hr());
  console.log(`${c.bold}Files${c.reset}`);

  for (const file of receipt.files) {
    const icon = file.status === 'verified' || file.status === 'noop'
      ? `${theme.success}OK${c.reset}`
      : `${theme.warning}${file.status.toUpperCase()}${c.reset}`;
    const expectedHash = file.expected?.sha256 ? file.expected.sha256.slice(0, 12) : 'none';
    console.log(`  ${icon} ${c.cyan}${file.operation}${c.reset} ${file.path}`);
    console.log(`     ${c.dim}${file.detail}${c.reset}`);
    console.log(`     ${c.dim}expected: ${file.expectedSource} ${expectedHash}${c.reset}`);
  }
}

function printReceiptVerification(target: string, asJson?: boolean): void {
  const receipt = readReceipt(target);
  if (!receipt) {
    error(`Receipt not found: ${target}`);
    return;
  }

  const verification = verifyReceipt(receipt);
  const integrityOk = verifyReceiptIntegrity(receipt);

  if (asJson) {
    console.log(JSON.stringify({ ...verification, integrityOk }, null, 2));
    return;
  }

  console.log(heading(`Verify Receipt ${receipt.id}`));
  printReceiptHeader(receipt);
  console.log(hr());

  if (integrityOk) {
    success('Receipt integrity hash matches.');
  } else {
    warn('Receipt integrity hash does not match. The receipt file may have been edited.');
  }

  if (verification.signed) {
    if (verification.signatureOk) {
      success(`Signature OK (${verification.signerKeyId}).`);
    } else {
      error(`Signature INVALID (${verification.signerKeyId ?? 'unknown key'}).`);
    }
  } else {
    info('Receipt is unsigned. Run `mythos receipts keygen` to enable signing on future receipts.');
  }

  for (const file of verification.files) {
    if (file.status === 'ok') {
      success(`${file.path} - ${file.detail}`);
    } else if (file.status === 'unknown') {
      warn(`${file.path} - ${file.detail}`);
    } else {
      error(`${file.path} - ${file.detail}`);
    }
  }

  console.log();
  const sigPart = verification.signed && verification.signatureOk === false ? ' or invalid signature' : '';
  if (verification.ok && integrityOk) {
    success('Receipt verification passed.');
  } else {
    warn(`Receipt verification found drift, integrity${sigPart} issues.`);
  }
}

function printReceiptHeader(receipt: SWDReceipt): void {
  const provider = receipt.provider
    ? `${receipt.provider.providerId}/${receipt.provider.modelId}`
    : 'unknown';
  const tokens = receipt.usage
    ? `${receipt.usage.totalTokens.toLocaleString()} tokens`
    : 'unknown';
  const cost = receipt.budget
    ? `~$${receipt.budget.estimatedCostUSD.toFixed(4)} session`
    : 'unknown';

  console.log(`  ${c.dim}Time:${c.reset}     ${formatDate(receipt.timestamp)}`);
  console.log(`  ${c.dim}Status:${c.reset}   ${receipt.swd.success ? theme.success + 'verified' : theme.warning + 'issues'}${c.reset}${receipt.swd.rolledBack ? ` ${theme.warning}(rolled back)${c.reset}` : ''}`);
  console.log(`  ${c.dim}Summary:${c.reset}  ${receipt.summary}`);
  console.log(`  ${c.dim}Provider:${c.reset} ${provider}`);
  console.log(`  ${c.dim}Usage:${c.reset}    ${tokens} | ${cost}`);
  console.log(`  ${c.dim}Git:${c.reset}      ${receipt.git?.branch ?? 'none'} @ ${receipt.git?.commit?.slice(0, 12) ?? 'none'}`);
  if (receipt.test) {
    console.log(`  ${c.dim}Test:${c.reset}     ${receipt.test.command} -> ${receipt.test.status}`);
  }
}

function formatStatus(receipt: ReceiptSummary): string {
  if (receipt.rolledBack) return `${theme.warning}ROLLBACK${c.reset}`;
  return receipt.success ? `${theme.success}VERIFIED${c.reset}` : `${theme.warning}ISSUES${c.reset}`;
}

function formatDate(timestamp: string): string {
  return timestamp.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function parseLimit(raw?: string): number {
  const parsed = parseInt(raw ?? '10', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(parsed, 100);
}
