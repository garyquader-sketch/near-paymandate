import assert from 'node:assert/strict';
import test from 'node:test';
import { fromYocto, toYocto } from '../src/lib/domain.ts';
import { settlementOutcome } from '../src/lib/settlement.ts';
import type { Attempt } from '../src/lib/domain.ts';

test('10,000 reproducible monetary samples round-trip with exact integer precision', () => {
  const limit = 10n ** 30n;
  let state = 0x5eedn;
  for (let i = 0; i < 10_000; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % (1n << 128n);
    const units = 1n + state % (limit - 1n);
    assert.equal(toYocto(fromYocto(units.toString())), units.toString());
  }
  for (const units of [1n, 10n ** 24n - 1n, 10n ** 24n, limit - 1n]) {
    assert.equal(toYocto(fromYocto(units.toString())), units.toString());
  }
});

test('only one of 128 settlement evidence combinations establishes payment', () => {
  const attempt: Attempt = {
    hash: 'hash', mandate: 'mandate', scenario: 'valid', created: '', status: 'PENDING', message: '',
    contract_id: 'contract.testnet', signer_id: 'agent.testnet', finalized: false,
  };
  const success = { SuccessValue: '' };
  const receipt = (event: string, id: string, executor: string, status: object) => ({ outcome: {
    executor_id: executor, status, logs: ['EVENT_JSON:' + JSON.stringify({
      standard: 'paymandate', event, data: [{ mandate_id: attempt.mandate, attempt: id }],
    })],
  } });
  let verified = 0;
  for (let mask = 0; mask < 128; mask++) {
    const has = (bit: number) => (mask & (1 << bit)) !== 0;
    const outcome = settlementOutcome({
      final_execution_status: has(0) ? 'FINAL' : 'EXECUTED',
      transaction: {
        hash: has(1) ? attempt.hash : 'other',
        signer_id: has(2) ? attempt.signer_id : 'other.testnet',
        receiver_id: has(3) ? attempt.contract_id : 'other.testnet',
      },
      status: success,
      receipts_outcome: [
        receipt('processing', '1', attempt.contract_id, { SuccessReceiptId: 'settlement' }),
        receipt('paid', has(4) ? '1' : '2', has(5) ? attempt.contract_id : 'other.testnet',
          has(6) ? success : { Failure: {} }),
      ],
    }, attempt);
    if (outcome.status === 'PAID') {
      verified++;
      assert.equal(mask, 127);
    }
  }
  assert.equal(verified, 1);
});
