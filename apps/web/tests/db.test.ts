import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { closeDatabase, getAttempt, insertAttempt, listAttempts, pendingAttempt, pendingBroadcast, updateAttempt } from '../src/lib/db.ts';
import type { Attempt } from '../src/lib/domain.ts';

test('migrates old journals and isolates broadcast and settlement locks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paymandate-db-test-'));
  const previous = process.env.PAYMANDATE_DATA_DIR;
  process.env.PAYMANDATE_DATA_DIR = dir;
  try {
    const old = new DatabaseSync(join(dir, 'workspace.sqlite'));
    old.exec(`
      CREATE TABLE attempts (hash TEXT PRIMARY KEY, mandate TEXT NOT NULL, created TEXT NOT NULL,
        scenario TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL);
      CREATE UNIQUE INDEX one_pending_attempt ON attempts(mandate) WHERE status IN ('PENDING','UNKNOWN');
      INSERT INTO attempts VALUES ('legacy', 'invoice', '2026-11-11', 'valid', 'UNKNOWN', '');
    `);
    old.close();

    const attempt: Attempt = {
      hash: 'tx-1', mandate: 'invoice', scenario: 'valid', created: '2026-11-11',
      status: 'PENDING', message: '', contract_id: 'one.testnet', signer_id: 'agent.testnet', finalized: false,
    };
    assert.deepEqual(listAttempts(attempt.contract_id), []);
    insertAttempt(attempt);
    assert.equal(getAttempt(attempt.hash, 'other.testnet'), undefined);
    assert.equal(pendingAttempt(attempt.contract_id, 'invoice')?.hash, attempt.hash);
    assert.equal(pendingBroadcast(attempt.signer_id)?.hash, attempt.hash);
    const next = { ...attempt, hash: 'tx-2', mandate: 'different', contract_id: 'other.testnet' };
    assert.throws(() => insertAttempt(next), /UNIQUE/);
    updateAttempt({ ...attempt, status: 'UNKNOWN', finalized: true });
    assert.equal(pendingBroadcast(attempt.signer_id), undefined);
    assert.equal(pendingAttempt(attempt.contract_id, 'invoice')?.status, 'UNKNOWN');
    assert.throws(() => insertAttempt({ ...attempt, hash: 'duplicate', signer_id: 'replacement.testnet' }), /UNIQUE/);
    insertAttempt(next);
    updateAttempt({ ...next, status: 'PAID', finalized: true });
    assert.equal(updateAttempt({ ...next, status: 'UNKNOWN' }).status, 'PAID');
    const audit = new DatabaseSync(join(dir, 'workspace.sqlite'));
    try {
      assert.equal(audit.prepare("SELECT status FROM attempts WHERE hash = 'legacy'").get()?.status, 'UNKNOWN');
    } finally {
      audit.close();
    }
  } finally {
    closeDatabase();
    if (previous === undefined) delete process.env.PAYMANDATE_DATA_DIR;
    else process.env.PAYMANDATE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
