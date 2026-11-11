import assert from 'node:assert/strict';
import test from 'node:test';
import type { Attempt } from '../src/lib/domain.ts';
import { settlementOutcome } from '../src/lib/settlement.ts';

const contract = 'paymandate.testnet';
const signer = 'agent.testnet';
const attempt: Attempt = {
  hash: 'tx', mandate: 'one', scenario: 'valid', created: '', status: 'PENDING', message: '',
  contract_id: contract, signer_id: signer, finalized: false,
};
const success = { SuccessValue: '' };
const failed = { Failure: { ActionError: 'RECIPIENT_MISMATCH' } };
const receipt = (event: string, status: object, id = '1', executor_id = contract, mandate_id = 'one') => ({
  outcome: { executor_id, status, logs: ['EVENT_JSON:' + JSON.stringify({
    standard: 'paymandate', event, data: [{ mandate_id, attempt: id }],
  })] },
});
const outcome = (status: object, receipts_outcome: object[], final_execution_status = 'FINAL') => ({
  status, receipts_outcome, final_execution_status,
  transaction: { hash: attempt.hash, receiver_id: contract, signer_id: signer },
});
const processing = receipt('processing', { SuccessReceiptId: 'receipt' });
const paid = receipt('paid', success);

test('requires final, matched settlement from the correct contract and mandate', () => {
  const result = settlementOutcome(outcome(success, [processing, paid]), attempt);
  assert.equal(result.status, 'PAID');
  assert.equal(result.finalized, true);
  assert.equal(settlementOutcome(outcome(success, [processing, paid], 'EXECUTED'), attempt), attempt);
  assert.equal(settlementOutcome(outcome(success, [processing, receipt('paid', success, '1', 'other.testnet')]), attempt).status, 'UNKNOWN');
  assert.equal(settlementOutcome(outcome(success, [processing, receipt('paid', success, '1', contract, 'other')]), attempt).status, 'UNKNOWN');
});

test('requires the exact transaction hash, signer and receiver', () => {
  const final = outcome(success, [processing, paid]);
  for (const field of ['hash', 'signer_id', 'receiver_id'] as const) {
    assert.equal(settlementOutcome({ ...final, transaction: { ...final.transaction, [field]: 'different' } }, attempt), attempt);
  }
});

test('requires one processing event and one terminal event for the same attempt', () => {
  for (const receipts of [[paid], [processing, paid, paid], [processing, receipt('paid', success, '2')]]) {
    const result = settlementOutcome(outcome(success, receipts), attempt);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.finalized, true);
  }
});

test('logs from a failed receipt cannot mark a payment as paid', () => {
  const result = settlementOutcome(outcome(failed, [processing, receipt('paid', failed)]), attempt);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.finalized, true);
});

test('reports rejection before scheduling and proven transfer failure after scheduling', () => {
  const rejected = settlementOutcome(outcome(failed, [receipt('processing', failed)]), attempt);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.message, 'RECIPIENT_MISMATCH');
  assert.equal(settlementOutcome(outcome(success, [processing, receipt('transfer_failed', success)]), attempt).status, 'TRANSFER_FAILED');
});
