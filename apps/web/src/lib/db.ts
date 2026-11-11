import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Attempt, Invoice } from './domain.ts';

let connection: DatabaseSync | undefined;
function database() {
  if (connection) return connection;
  const dir = process.env.PAYMANDATE_DATA_DIR || join(process.cwd(), '.data');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'workspace.sqlite'));
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS invoices (hash TEXT PRIMARY KEY, added TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invoice_documents (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS suppliers (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS attempts (
        hash TEXT PRIMARY KEY, mandate TEXT NOT NULL, created TEXT NOT NULL,
        scenario TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
        contract_id TEXT NOT NULL DEFAULT '', signer_id TEXT NOT NULL DEFAULT '', finalized INTEGER NOT NULL DEFAULT 0
      );
    `);
    const columns = db.prepare('PRAGMA table_info(attempts)').all().map(column => column.name);
    if (!columns.includes('contract_id')) db.exec("ALTER TABLE attempts ADD COLUMN contract_id TEXT NOT NULL DEFAULT ''");
    if (!columns.includes('signer_id')) db.exec("ALTER TABLE attempts ADD COLUMN signer_id TEXT NOT NULL DEFAULT ''");
    if (!columns.includes('finalized')) db.exec('ALTER TABLE attempts ADD COLUMN finalized INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      DROP INDEX IF EXISTS one_pending_attempt;
      CREATE UNIQUE INDEX IF NOT EXISTS unresolved_mandate ON attempts(contract_id, mandate)
        WHERE status IN ('PENDING', 'UNKNOWN');
      CREATE UNIQUE INDEX IF NOT EXISTS unresolved_broadcast ON attempts(signer_id)
        WHERE finalized = 0 AND signer_id <> '' AND status IN ('PENDING', 'UNKNOWN');
      COMMIT;
    `);
    connection = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeDatabase() {
  connection?.close();
  connection = undefined;
}

export function getInvoice(hash: string) {
  const row = database().prepare('SELECT data FROM invoices WHERE hash = ?').get(hash);
  return row ? JSON.parse(String(row.data)) as Invoice : null;
}

export function saveInvoice(invoice: Invoice, bytes: Buffer) {
  const db = database();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO invoices VALUES (?, ?, ?)')
      .run(invoice.hash, invoice.added, JSON.stringify(invoice));
    db.prepare('INSERT OR IGNORE INTO invoice_documents VALUES (?, ?)').run(invoice.hash, bytes);
    if (invoice.fields) db.prepare('INSERT OR IGNORE INTO suppliers VALUES (?)').run(invoice.fields.supplier);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getInvoice(invoice.hash)!;
}

export function listInvoices() {
  return database().prepare('SELECT data FROM invoices ORDER BY added DESC LIMIT 200').all()
    .map(row => JSON.parse(String(row.data)) as Invoice);
}

type AttemptRow = Omit<Attempt, 'finalized'> & { finalized: number };
function readAttempt(row: unknown): Attempt {
  const record = row as AttemptRow;
  return { ...record, finalized: record.finalized === 1 };
}

export function listAttempts(contractId: string) {
  if (!contractId) return [];
  return database().prepare('SELECT * FROM attempts WHERE contract_id = ? ORDER BY created DESC LIMIT 200')
    .all(contractId).map(readAttempt);
}

export function pendingAttempt(contractId: string, mandate: string) {
  const row = database().prepare("SELECT * FROM attempts WHERE contract_id = ? AND mandate = ? AND status IN ('PENDING','UNKNOWN')")
    .get(contractId, mandate);
  return row ? readAttempt(row) : undefined;
}

export function pendingBroadcast(signerId: string) {
  const row = database().prepare("SELECT * FROM attempts WHERE signer_id = ? AND finalized = 0 AND status IN ('PENDING','UNKNOWN')")
    .get(signerId);
  return row ? readAttempt(row) : undefined;
}

export function insertAttempt(attempt: Attempt) {
  database().prepare(`INSERT INTO attempts (hash, mandate, created, scenario, status, message, contract_id, signer_id, finalized)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(attempt.hash, attempt.mandate, attempt.created, attempt.scenario, attempt.status, attempt.message,
      attempt.contract_id, attempt.signer_id, Number(attempt.finalized));
}

export function getAttempt(hash: string, contractId: string) {
  if (!contractId) return undefined;
  const row = database().prepare('SELECT * FROM attempts WHERE hash = ? AND contract_id = ?').get(hash, contractId);
  return row ? readAttempt(row) : undefined;
}

export function updateAttempt(attempt: Attempt) {
  database().prepare(`UPDATE attempts SET status = ?, message = ?, finalized = MAX(finalized, ?)
    WHERE hash = ? AND contract_id = ? AND signer_id = ? AND status IN ('PENDING','UNKNOWN')`)
    .run(attempt.status, attempt.message, Number(attempt.finalized), attempt.hash, attempt.contract_id, attempt.signer_id);
  return getAttempt(attempt.hash, attempt.contract_id)!;
}
