import { z } from 'zod';

export const workspaceHeader = 'X-PayMandate-Request';
export const workspaceHeaderValue = 'workspace';

export const accountId = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const mandateId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const amountText = z.string().max(31).regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,24})?$/)
  .refine(value => /[1-9]/.test(value), 'Amount must be positive');
export const date = z.iso.date();
export const invoiceFields = z.object({
  supplier: z.string().trim().min(1).max(100),
  number: z.string().trim().min(1).max(80),
  date,
  amount: amountText,
  currency: z.literal('NEAR'),
  recipient: accountId,
  description: z.string().max(500),
  due: date,
}).refine(value => value.due >= value.date, 'Due date precedes invoice date');

const uint = z.string().regex(/^\d{1,39}$/);
export const mandateSchema = z.object({
  mandate_id: mandateId, owner_id: accountId, recipient_id: accountId, amount_yocto: uint,
  invoice_hash: hash, expires_at_ns: uint, created_at_ns: uint, execution_attempt_id: uint,
  reservation_active: z.boolean(), status: z.enum(['APPROVED', 'PROCESSING', 'PAID', 'CANCELLED', 'EXPIRED']),
});
export const configSchema = z.object({
  owner_id: accountId, agent_id: accountId, available_yocto: uint, reserved_yocto: uint, mandate_count: uint,
});
export const scenarioSchema = z.enum(['valid', 'recipient', 'duplicate', 'injection']);
export type Scenario = z.infer<typeof scenarioSchema>;
export type Mandate = z.infer<typeof mandateSchema>;
export type Config = z.infer<typeof configSchema>;
export type Invoice = {
  id: string; hash: string; filename: string; text: string; added: string;
  fields: z.infer<typeof invoiceFields> | null; mode: 'demo' | 'cloud'; warnings: string[]; error?: string;
};
export type Attempt = {
  hash: string; mandate: string; scenario: Scenario; created: string;
  contract_id: string; signer_id: string; finalized: boolean;
  status: 'PENDING' | 'REJECTED' | 'PAID' | 'TRANSFER_FAILED' | 'UNKNOWN'; message: string;
};

export function toYocto(value: string): string {
  const [whole, fraction = ''] = amountText.parse(value).split('.');
  return BigInt(whole + fraction.padEnd(24, '0')).toString();
}

export function fromYocto(value: string): string {
  const digits = BigInt(value).toString().padStart(25, '0');
  const fraction = digits.slice(-24).replace(/0+$/, '');
  return digits.slice(0, -24) + (fraction ? '.' + fraction : '');
}

export function possibleDuplicate(a: Invoice, b: Invoice) {
  if (a.hash === b.hash || !a.fields || !b.fields) return false;
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(a.fields.supplier) === normalize(b.fields.supplier)
    && normalize(a.fields.number) === normalize(b.fields.number);
}