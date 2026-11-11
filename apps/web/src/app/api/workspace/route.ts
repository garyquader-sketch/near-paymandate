import { createHash } from 'node:crypto';
import { z } from 'zod';
import { chainState, configuredContract, execute, reconcile } from '../../../lib/chain';
import { getAttempt, getInvoice, listAttempts, listInvoices, saveInvoice } from '../../../lib/db';
import { mandateId, scenarioSchema } from '../../../lib/domain';
import { analyzeInvoice } from '../../../lib/invoice';
import { authorized, json, limitedJson, loopbackRequest } from '../../../lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('upload'), filename: z.string().min(1).max(180), data: z.base64().max(43_692) }),
  z.object({ action: z.literal('execute'), mandate: mandateId, scenario: scenarioSchema }),
  z.object({ action: z.literal('reconcile'), hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/) }),
]);

export async function GET(request: Request) {
  if (!loopbackRequest(request)) return json({ error: 'Open the local workspace directly.' }, 403);
  if (!authorized(request)) return json({ error: 'Enter the workspace access token.' }, 401);
  return json({
    chain: await chainState(true), invoices: listInvoices(), attempts: listAttempts(configuredContract()),
    analysis: process.env.NEAR_AI_API_KEY ? 'cloud' : 'demo',
  });
}

export async function POST(request: Request) {
  if (!loopbackRequest(request, true)) return json({ error: 'Open the local workspace directly.' }, 403);
  if (!authorized(request)) return json({ error: 'Enter the workspace access token.' }, 401);
  let input: z.infer<typeof inputSchema>;
  try { input = inputSchema.parse(await limitedJson(request, 48_000)); }
  catch { return json({ error: 'Invalid or oversized request.' }, 400); }

  if (input.action === 'upload') {
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length || bytes.length > 32_768) return json({ error: 'Choose a UTF-8 text invoice up to 32 KB.' }, 400);
    const invoiceHash = createHash('sha256').update(bytes).digest('hex');
    const existing = getInvoice(invoiceHash);
    if (existing) return json(existing);
    try { return json(saveInvoice(await analyzeInvoice(bytes, input.filename), bytes)); }
    catch { return json({ error: 'Invoice could not be read. Use a valid UTF-8 text file.' }, 422); }
  }
  if (input.action === 'reconcile') {
    const attempt = getAttempt(input.hash, configuredContract());
    return attempt ? json(await reconcile(attempt)) : json({ error: 'Unknown attempt.' }, 404);
  }
  try {
    return json(await execute(input.mandate, input.scenario));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const userError = /^(Configure an execute-only|Choose (a|an) |Agent key must have|An agent request|An earlier agent broadcast)/.test(message);
    return json({ error: userError ? message : 'Unable to prepare the Testnet request. Check the contract, RPC and agent key.' }, userError ? 409 : 502);
  }
}
