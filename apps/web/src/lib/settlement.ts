import { z } from 'zod';
import type { Attempt } from './domain.ts';

const statusSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
const outcomeSchema = z.object({
  final_execution_status: z.string(),
  transaction: z.object({ hash: z.string(), signer_id: z.string(), receiver_id: z.string() }),
  status: statusSchema,
  receipts_outcome: z.array(z.object({ outcome: z.object({
    executor_id: z.string(), logs: z.array(z.string()), status: statusSchema,
  }) })),
});

const eventSchema = z.object({
  standard: z.literal('paymandate'), event: z.string(),
  data: z.array(z.object({ mandate_id: z.string(), attempt: z.string().regex(/^\d+$/) })).min(1),
});

function parseEvent(line: string, mandate: string) {
  if (!line.startsWith('EVENT_JSON:')) return undefined;
  try {
    const parsed = eventSchema.parse(JSON.parse(line.slice(11)));
    const data = parsed.data[0];
    return data.mandate_id === mandate ? { kind: parsed.event, id: data.attempt } : undefined;
  } catch {
    return undefined;
  }
}

export function settlementOutcome(value: unknown, attempt: Attempt): Attempt {
  const result = outcomeSchema.parse(value);
  const tx = result.transaction;
  if (result.final_execution_status !== 'FINAL' || tx.hash !== attempt.hash
      || tx.receiver_id !== attempt.contract_id || tx.signer_id !== attempt.signer_id) return attempt;

  const events = result.receipts_outcome.map(receipt => receipt.outcome).filter(outcome =>
    outcome.executor_id === attempt.contract_id && typeof outcome.status === 'object'
    && ('SuccessValue' in outcome.status || 'SuccessReceiptId' in outcome.status),
  ).flatMap(outcome => outcome.logs.map(line => parseEvent(line, attempt.mandate))).filter(event => event !== undefined);
  const processing = events.filter(event => event.kind === 'processing');
  const terminal = events.filter(event => event.kind === 'paid' || event.kind === 'transfer_failed');
  const verified = { ...attempt, finalized: true };
  if (processing.length === 1 && terminal.length === 1 && processing[0].id === terminal[0].id) {
    if (terminal[0].kind === 'paid') {
      return { ...verified, status: 'PAID', message: 'Transfer and settlement confirmed by Testnet.' };
    }
    return { ...verified, status: 'TRANSFER_FAILED', message: 'Transfer failed. The reservation remains available for an eligible retry.' };
  }
  if (typeof result.status === 'object' && 'Failure' in result.status && !processing.length && !terminal.length) {
    const failure = JSON.stringify(result.status.Failure);
    const code = /\b(RECIPIENT_MISMATCH|AMOUNT_MISMATCH|INVOICE_MISMATCH|NOT_APPROVED|AGENT_ONLY|INSUFFICIENT_LIQUIDITY)\b/.exec(failure)?.[0];
    return { ...verified, status: 'REJECTED', message: code ?? 'Testnet rejected this request.' };
  }
  return { ...verified, status: 'UNKNOWN', message: 'Transaction finalized. Settlement remains unresolved. Do not repeat this payment.' };
}
