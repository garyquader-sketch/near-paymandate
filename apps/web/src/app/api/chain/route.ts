import { chainState } from '../../../lib/chain';
import { listAttempts } from '../../../lib/db';
import { json, loopbackRequest } from '../../../lib/operator-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!loopbackRequest(request)) return json({ error: 'Open the local workspace directly.' }, 403);
  const { agentReady: _agentReady, agentStatus: _agentStatus, ...chain } = await chainState();
  const attempts = listAttempts(chain.contractId).filter(attempt => ['PAID', 'REJECTED', 'TRANSFER_FAILED'].includes(attempt.status));
  return Response.json({ ...chain, attempts }, { headers: { 'Cache-Control': 'no-store' } });
}
