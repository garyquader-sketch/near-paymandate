import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas } from 'near-api-js';
import { settlementOutcome } from '../src/lib/settlement.ts';

const wasm = process.env.PAYMANDATE_WASM
  ? await readFile(process.env.PAYMANDATE_WASM)
  : await readFile(new URL('../../../artifacts/paymandate.wasm', import.meta.url));
const gas = teraToGas('60');
const payment = nearToYocto('0.01');
const invoiceHash = (text) => createHash('sha256').update(text).digest('hex');
const expiry = () => ((BigInt(Date.now()) + 3_600_000n) * 1_000_000n).toString();

function failure(outcome) {
  return (typeof outcome.status === 'object' && 'Failure' in outcome.status) || outcome.receipts_outcome.some(
    receipt => typeof receipt.outcome.status === 'object' && 'Failure' in receipt.outcome.status,
  );
}

test('Sandbox funds, approves, enforces a restricted key and settles exactly once', { timeout: 300_000 }, async () => {
  const sandbox = await Sandbox.start({});
  try {
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    assert.match(sandbox.rpcUrl, /^http:\/\/127\.0\.0\.1:/);
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
    const create = async (label) => {
      const key = KeyPair.fromRandom('ed25519');
      const result = await root.createSubAccount({
        accountOrPrefix: label, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto('5'),
      });
      assert.equal(failure(result), false);
      return new Account(label + '.' + DEFAULT_ACCOUNT_ID, provider, new KeyPairSigner(key));
    };
    const contract = await create('contract');
    const owner = await create('owner');
    const agent = await create('agent');
    const vendor = await create('vendor');
    const other = await create('other');
    const signers = [];
    for (let i = 0; i < 2; i++) {
      const key = KeyPair.fromRandom('ed25519');
      const outcome = await agent.addFunctionCallAccessKey({
        publicKey: key.getPublicKey(), contractId: contract.accountId,
        methodNames: ['execute_mandate'], allowance: nearToYocto('0.5'),
      });
      assert.equal(failure(outcome), false);
      const access = await provider.viewAccessKey({ accountId: agent.accountId, publicKey: key.getPublicKey() });
      assert.equal(access.permission.FunctionCall.receiver_id, contract.accountId);
      assert.deepEqual(access.permission.FunctionCall.method_names, ['execute_mandate']);
      signers.push(new Account(agent.accountId, provider, new KeyPairSigner(key)));
    }
    const invoke = (who, methodName, args = {}, deposit = 0n) => who.signAndSendTransaction({
      receiverId: contract.accountId, actions: [actions.functionCall(methodName, args, gas, deposit)],
      waitUntil: 'FINAL', throwOnFailure: false,
    });
    const verifyReceipt = async (outcome, terms) => {
      const hash = outcome.transaction.hash;
      const finalized = await provider.sendJsonRpc('tx', {
        tx_hash: hash, sender_account_id: agent.accountId, wait_until: 'FINAL',
      });
      return settlementOutcome(finalized, {
        hash, mandate: terms.mandate_id, scenario: 'valid', created: '', status: 'PENDING', message: '',
        contract_id: contract.accountId, signer_id: agent.accountId, finalized: false,
      });
    };
    const view = (method, args = {}) => provider.callFunction({ contractId: contract.accountId, method, args });
    const setup = await contract.signAndSendTransaction({
      receiverId: contract.accountId, actions: [
        actions.deployContract(wasm),
        actions.functionCall('new', { owner_id: owner.accountId, agent_id: agent.accountId }, gas, 0n),
      ],
    });
    assert.equal(failure(setup), false);
    assert.equal(failure(await invoke(owner, 'fund', {}, 3n * payment)), false);
    const base = { mandate_id: 'invoice-1', recipient_id: vendor.accountId, amount_yocto: payment.toString(), invoice_hash: invoiceHash('invoice-1') };
    assert.equal(failure(await invoke(owner, 'approve_mandate', { ...base, expires_at_ns: expiry() }, 1n)), false);
    assert.equal((await view('get_config')).reserved_yocto, payment.toString());
    await assert.rejects(() => invoke(signers[0], 'cancel_mandate', { mandate_id: base.mandate_id }));
    await assert.rejects(() => invoke(signers[0], 'execute_mandate', base, 1n));
    const before = await vendor.getBalance();
    const otherBefore = await other.getBalance();
    for (const proposed of [{ ...base, recipient_id: other.accountId }, { ...base, amount_yocto: '1' },
      { ...base, invoice_hash: invoiceHash('wrong') }]) {
      assert.equal(failure(await invoke(signers[0], 'execute_mandate', proposed)), true);
      assert.equal((await view('get_mandate', { mandate_id: base.mandate_id })).status, 'APPROVED');
    }
    const attempts = await Promise.all(signers.map(signer => invoke(signer, 'execute_mandate', base)));
    assert.equal(attempts.filter(result => !failure(result)).length, 1);
    const verified = await Promise.all(attempts.map(outcome => verifyReceipt(outcome, base)));
    assert.deepEqual(verified.map(result => result.status).sort(), ['PAID', 'REJECTED']);
    assert.equal((await view('get_mandate', { mandate_id: base.mandate_id })).status, 'PAID');
    assert.equal(await vendor.getBalance(), before + payment);
    assert.equal(await other.getBalance(), otherBefore);
    assert.equal((await view('get_config')).reserved_yocto, '0');
    assert.equal(failure(await invoke(signers[0], 'execute_mandate', base)), true);
    assert.equal(failure(await invoke(owner, 'approve_mandate', { ...base, mandate_id: 'duplicate-hash', expires_at_ns: expiry() }, 1n)), true);

    const missing = { ...base, mandate_id: 'missing-vendor', recipient_id: 'missing.' + DEFAULT_ACCOUNT_ID, invoice_hash: invoiceHash('missing') };
    assert.equal(failure(await invoke(owner, 'approve_mandate', { ...missing, expires_at_ns: expiry() }, 1n)), false);
    const failed = await invoke(signers[0], 'execute_mandate', missing);
    assert.equal((await verifyReceipt(failed, missing)).status, 'TRANSFER_FAILED');
    const retryable = await view('get_mandate', { mandate_id: missing.mandate_id });
    assert.equal(retryable.status, 'APPROVED');
    assert.equal(retryable.execution_attempt_id, '1');
    assert.equal((await view('get_config')).reserved_yocto, payment.toString());
  } finally {
    await sandbox.tearDown();
  }
});
