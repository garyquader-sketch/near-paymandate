import { Account, baseEncode, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { z } from 'zod';
import { accountId, configSchema, mandateSchema, type Attempt, type Scenario } from './domain';
import { getInvoice, insertAttempt, pendingAttempt, pendingBroadcast, updateAttempt } from './db';
import { settlementOutcome } from './settlement';

const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const key = () => process.env.NEAR_TESTNET_AGENT_KEY?.trim() || '';
const methodName = 'execute_mandate';
let executing = false;

export function configuredContract() {
  return process.env.NEAR_TESTNET_CONTRACT?.trim() || '';
}

async function view(contractId: string, method: string, args: Record<string, unknown>) {
  if (!accountId.safeParse(contractId).success || !contractId.endsWith('.testnet')) {
    throw new Error('Set NEAR_TESTNET_CONTRACT to a named Testnet account.');
  }
  return provider.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } });
}

async function agentSigner(agentId: string, contractId: string) {
  if (!key()) throw new Error('Configure an execute-only Testnet agent key first.');
  const signer = KeyPairSigner.fromSecretKey(key() as KeyPairString);
  const publicKey = await signer.getPublicKey();
  const accessKey = await provider.viewAccessKey({ accountId: agentId, publicKey: publicKey.toString() });
  const permission = accessKey.permission;
  if (typeof permission === 'string' || !('FunctionCall' in permission) || permission.FunctionCall.receiver_id !== contractId
      || permission.FunctionCall.method_names.join(',') !== methodName || permission.FunctionCall.allowance == null
      || BigInt(permission.FunctionCall.allowance) <= 0n) {
    throw new Error('Agent key must have a positive finite allowance and be scoped to execute_mandate on this contract.');
  }
  return { signer, publicKey };
}

export async function chainState(checkAgent = false) {
  const contractId = configuredContract();
  const empty = { contractId, config: null, mandates: [], agentReady: false, agentStatus: 'UNAVAILABLE' as const };
  if (!contractId) return { ...empty, connection: 'UNCONFIGURED' as const };
  try {
    const config = configSchema.parse(await view(contractId, 'get_config', {}));
    const total = BigInt(config.mandate_count);
    const offset = (total > 100n ? total - 100n : 0n).toString();
    const mandates = z.array(mandateSchema).parse(await view(contractId, 'list_mandates', { offset, limit: 100 })).reverse();
    const agentStatus = !checkAgent || !key() ? 'UNCONFIGURED' as const
      : await agentSigner(config.agent_id, contractId).then(() => 'READY' as const, () => 'UNVERIFIED' as const);
    return { connection: 'CONNECTED' as const, contractId, config, mandates, agentReady: agentStatus === 'READY', agentStatus };
  } catch {
    return { ...empty, connection: 'UNAVAILABLE' as const };
  }
}

export async function reconcile(attempt: Attempt): Promise<Attempt> {
  if (attempt.status !== 'PENDING' && attempt.status !== 'UNKNOWN') return attempt;
  try {
    const final = await provider.sendJsonRpc('tx', {
      tx_hash: attempt.hash, sender_account_id: attempt.signer_id, wait_until: 'FINAL',
    });
    const resolved = settlementOutcome(final, attempt);
    return resolved === attempt ? attempt : updateAttempt(resolved);
  } catch {
    return attempt;
  }
}

export async function execute(mandateId: string, scenario: Scenario): Promise<Attempt> {
  if (!key()) throw new Error('Configure an execute-only Testnet agent key first.');
  if (executing) throw new Error('An agent request is already running. Check Activity before trying again.');
  executing = true;
  try {
    const contractId = configuredContract();
    const existing = pendingAttempt(contractId, mandateId);
    if (existing) {
      const updated = await reconcile(existing);
      if (updated.status === 'PENDING' || updated.status === 'UNKNOWN') return updated;
    }

    const config = configSchema.parse(await view(contractId, 'get_config', {}));
    const waiting = pendingBroadcast(config.agent_id);
    if (waiting && !(await reconcile(waiting)).finalized) {
      throw new Error('An earlier agent broadcast is unresolved. Check its transaction in Activity before sending another.');
    }
    const mandate = mandateSchema.parse(await view(contractId, 'get_mandate', { mandate_id: mandateId }));
    if (scenario === 'duplicate' ? mandate.status !== 'PAID' : mandate.status !== 'APPROVED') {
      throw new Error(scenario === 'duplicate' ? 'Choose a paid mandate.' : 'Choose an approved mandate.');
    }
    if (scenario === 'injection' && !getInvoice(mandate.invoice_hash)?.warnings.length) {
      throw new Error('Choose a mandate linked to an invoice flagged during analysis.');
    }

    const { signer, publicKey } = await agentSigner(config.agent_id, contractId);
    const account = new Account(config.agent_id, provider, signer);
    const args = {
      mandate_id: mandateId,
      recipient_id: scenario === 'recipient' || scenario === 'injection' ? contractId : mandate.recipient_id,
      amount_yocto: mandate.amount_yocto,
      invoice_hash: mandate.invoice_hash,
    };
    const transaction = await account.createTransaction({
      receiverId: contractId, publicKey,
      actions: [actions.functionCall(methodName, args, teraToGas('60'), 0n)],
    });
    const { signedTransaction, txHash } = await signer.signTransaction(transaction);
    const attempt: Attempt = {
      hash: baseEncode(txHash), mandate: mandateId, scenario, created: new Date().toISOString(),
      contract_id: contractId, signer_id: config.agent_id, finalized: false,
      status: 'PENDING', message: 'Submission prepared. Awaiting final Testnet receipts.',
    };
    try {
      insertAttempt(attempt);
    } catch (error) {
      const pending = pendingAttempt(contractId, mandateId);
      if (pending) return pending;
      if (pendingBroadcast(config.agent_id)) throw new Error('An agent request is already running. Check Activity before trying again.');
      throw error;
    }
    try {
      await provider.sendTransaction(signedTransaction);
    } catch {
      const uncertain = updateAttempt({ ...attempt, status: 'UNKNOWN', message: 'Broadcast result is uncertain. Check the final receipt before taking action.' });
      return reconcile(uncertain);
    }
    return reconcile(attempt);
  } finally {
    executing = false;
  }
}
