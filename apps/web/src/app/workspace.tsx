'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { NearConnector } from '@hot-labs/near-connect';
import { accountId, toYocto, fromYocto, possibleDuplicate, workspaceHeader, workspaceHeaderValue, type Attempt, type Config, type Invoice, type Mandate, type Scenario } from '../lib/domain';

const browserHeaders = { [workspaceHeader]: workspaceHeaderValue };
const tabs = ['Dashboard', 'Invoices', 'Mandates', 'Activity', 'Security Demo'] as const;
type Tab = typeof tabs[number];
type Chain = {
  contractId: string; connection: 'CONNECTED' | 'UNAVAILABLE' | 'UNCONFIGURED';
  config: Config | null; mandates: Mandate[]; agentReady?: boolean; agentStatus?: 'READY' | 'UNAVAILABLE' | 'UNCONFIGURED' | 'UNVERIFIED';
};
type Workspace = { chain: Chain; invoices: Invoice[]; attempts: Attempt[]; analysis: 'cloud' | 'demo' };
const empty: Chain = { contractId: '', connection: 'UNCONFIGURED', config: null, mandates: [] };
const scenarios: { id: Scenario; title: string; instruction: string; expected: string }[] = [
  { id: 'valid', title: 'Valid payment', instruction: 'Choose an approved mandate and send its exact terms.', expected: 'Transfer settles and the mandate becomes PAID.' },
  { id: 'recipient', title: 'Recipient tampering', instruction: 'Choose an approved mandate. The test request substitutes the contract address for the vendor.', expected: 'The contract returns RECIPIENT_MISMATCH.' },
  { id: 'duplicate', title: 'Duplicate execution', instruction: 'Choose a paid mandate and submit the same payment again.', expected: 'The contract returns NOT_APPROVED.' },
  { id: 'injection', title: 'Prompt injection', instruction: 'Upload the flagged example and approve the reviewed vendor. Choose that mandate to test a substituted recipient.', expected: 'The contract returns RECIPIENT_MISMATCH even if an agent proposes the wrong address.' },
];
const explorer = (hash: string) => 'https://testnet.nearblocks.io/txns/' + encodeURIComponent(hash);
const readable = (date: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(date));
const dateNs = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString();
const clip = (text: string) => text.length <= 22 ? text : text.slice(0, 10) + '…' + text.slice(-8);

function Badge({ text }: { text: string }) {
  return <span className={'badge ' + text.toLowerCase().replaceAll(' ', '-')}>{text.replaceAll('_', ' ')}</span>;
}

export default function WorkspacePage({ nonce }: { nonce: string }) {
  const [tab, setTab] = useState<Tab>('Dashboard');
  const [workspace, setWorkspace] = useState<Workspace>();
  const [publicChain, setPublicChain] = useState<Chain & { attempts?: Attempt[] }>(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean; href?: string }>();
  const [invoiceHash, setInvoiceHash] = useState('');
  const [mandateId, setMandateId] = useState('');
  const [walletId, setWalletId] = useState('');
  const [demoIds, setDemoIds] = useState<Partial<Record<Scenario, string>>>({});
  const connector = useRef<NearConnector | null>(null);
  const actionInFlight = useRef(false);
  const invoiceHeading = useRef<HTMLHeadingElement>(null);
  const chain = workspace?.chain ?? publicChain;
  const invoices = workspace?.invoices ?? [];
  const attempts = workspace?.attempts ?? publicChain.attempts ?? [];
  const invoice = invoices.find(item => item.hash === invoiceHash);
  const duplicate = invoice ? invoices.find(item => possibleDuplicate(invoice, item)) : undefined;
  const mandate = chain.mandates.find(item => item.mandate_id === mandateId);
  const owner = Boolean(walletId && walletId === chain.config?.owner_id);

  const api = useCallback(async (body?: unknown) => {
    const response = await fetch('/api/workspace', {
      method: body ? 'POST' : 'GET',
      headers: body ? { ...browserHeaders, 'Content-Type': 'application/json' } : browserHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (response.status === 401) {
      setWorkspace(undefined);
      setInvoiceHash('');
      setMandateId('');
      setDemoIds({});
    }
    if (!response.ok) throw new Error(data.error || 'Workspace request failed.');
    return data;
  }, []);

  const refresh = useCallback(async (operator: boolean) => {
    if (operator) {
      setWorkspace(await api());
    } else {
      const response = await fetch('/api/chain');
      if (!response.ok) throw new Error('Unable to load Testnet status.');
      setPublicChain(await response.json());
    }
  }, [api]);

  useEffect(() => {
    try { sessionStorage.removeItem('paymandate-session'); } catch { /* Storage is optional. */ }
    async function load() {
      const response = await fetch('/api/workspace/session', { headers: browserHeaders });
      if (!response.ok) throw new Error('Unable to read the local workspace session.');
      const session = await response.json();
      await refresh(session.unlocked === true);
    }
    load().catch(error => {
      setNotice({ text: error.message, error: true });
      return refresh(false).catch(() => {});
    }).finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (tab === 'Invoices' && invoiceHash) invoiceHeading.current?.focus();
  }, [tab, invoiceHash]);

  async function run(action: () => Promise<void>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setNotice(undefined);
    try { await action(); }
    catch (error) { setNotice({ text: error instanceof Error ? error.message : 'Request failed.', error: true }); }
    finally { actionInFlight.current = false; setBusy(false); }
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const secret = String(new FormData(form).get('secret') ?? '');
    await run(async () => {
      const response = await fetch('/api/workspace/session', {
        method: 'POST', headers: { ...browserHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to unlock the workspace.');
      form.reset();
      await refresh(true);
    });
  }

  function lockWorkspace() {
    void run(async () => {
      const response = await fetch('/api/workspace/session', { method: 'DELETE', headers: browserHeaders });
      if (!response.ok) throw new Error('Unable to lock the workspace. Try again.');
      setWorkspace(undefined);
      setInvoiceHash('');
      setMandateId('');
      setDemoIds({});
      setTab('Dashboard');
      await refresh(false);
    });
  }

  async function walletConnector() {
    if (!connector.current) {
      const { NearConnector } = await import('@hot-labs/near-connect');
      const instance = new NearConnector({ network: 'testnet', cspNonce: nonce, features: { testnet: true, signAndSendTransaction: true } });
      instance.on('wallet:signIn', result => setWalletId(result.accounts[0]?.accountId ?? ''));
      instance.on('wallet:signOut', () => setWalletId(''));
      connector.current = instance;
    }
    return connector.current;
  }

  async function walletCall(methodName: string, args: Record<string, unknown>, deposit: string) {
    if (!workspace || !owner || chain.connection !== 'CONNECTED') throw new Error('Connect the configured owner wallet.');
    const instance = await walletConnector();
    const { accounts, wallet } = await instance.getConnectedWallet();
    if (accounts[0]?.accountId !== chain.config?.owner_id) throw new Error('The selected wallet account is no longer the owner.');
    const outcome = await wallet.signAndSendTransaction({
      network: 'testnet', receiverId: chain.contractId, signerId: walletId,
      actions: [{ type: 'FunctionCall', params: { methodName, args, gas: '60000000000000', deposit } }],
    });
    const hash = outcome?.transaction?.hash;
    if (outcome && typeof outcome.status === 'object' && 'Failure' in outcome.status) {
      setNotice({ text: 'Testnet rejected the owner transaction. See the transaction details.', error: true, href: hash ? explorer(hash) : undefined });
    } else {
      setNotice({ text: hash ? 'Wallet returned a transaction hash. Review refreshed on-chain state.' : 'Check your wallet and refresh on-chain state after confirmation.', href: hash ? explorer(hash) : undefined });
    }
    await refresh(true);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get('file');
    const text = String(data.get('text') ?? '');
    await run(async () => {
      if (file instanceof File && file.size > 32_768) throw new Error('Choose a UTF-8 text invoice up to 32 KB.');
      if (file instanceof File && file.size && text.trim()) throw new Error('Choose a file or paste invoice text.');
      const bytes = file instanceof File && file.size ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(text);
      if (!bytes.length || bytes.length > 32_768) throw new Error('Choose or paste a UTF-8 text invoice up to 32 KB.');
      const filename = file instanceof File && file.size ? file.name : 'pasted-invoice.txt';
      const saved: Invoice = await api({ action: 'upload', filename, data: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) });
      form.reset();
      setInvoiceHash(saved.hash);
      await refresh(true);
    });
  }

  async function approve(event: FormEvent<HTMLFormElement>, selected: Invoice) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(async () => {
      const expiry = new Date(String(data.get('expiry'))).getTime();
      if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Choose a future expiry.');
      await walletCall('approve_mandate', {
        mandate_id: crypto.randomUUID(), recipient_id: accountId.parse(data.get('recipient')),
        amount_yocto: toYocto(String(data.get('amount'))), invoice_hash: selected.hash,
        expires_at_ns: (BigInt(expiry) * 1_000_000n).toString(),
      }, '1');
    });
  }

  async function execute(mandate: string, scenario: Scenario) {
    await run(async () => {
      const result: Attempt = await api({ action: 'execute', mandate, scenario });
      setNotice({ text: result.message, href: explorer(result.hash), error: result.status === 'REJECTED' });
      await refresh(true);
    });
  }

  function openMandate(id: string) { setMandateId(id); setTab('Mandates'); }
  const awaiting = chain.mandates.filter(item => item.status === 'APPROVED').length;
  const paid = chain.mandates.filter(item => item.status === 'PAID').length;
  const flagged = invoices.filter(item => item.warnings.length > 0).length;
  const amount = (value?: string) => value === undefined ? '—' : fromYocto(value) + ' NEAR';
  const canExecute = Boolean(workspace && chain.agentReady && chain.connection === 'CONNECTED');
  const hasMore = BigInt(chain.config?.mandate_count ?? '0') > 100n;
  const queue = invoices.filter(item => item.warnings.length || item.error).slice(0, 4);
  const related = invoice ? chain.mandates.find(item => item.invoice_hash === invoice.hash) : undefined;
  const canApprove = owner && (!related || !related.reservation_active && related.status !== 'PAID');

  return <div className="shell">
    <a className="skip-link" href="#content">Skip to content</a>
    <aside className="sidebar">
      <div className="brand"><span className="mark" aria-hidden="true">N</span><div>PayMandate<small>NEAR TESTNET</small></div></div>
      <nav aria-label="Workspace">{tabs.map(name => <button key={name} className={tab === name ? 'selected' : ''} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}>{name}</button>)}</nav>
      <div className="sidebar-foot"><span className={'dot ' + (chain.connection === 'CONNECTED' ? 'online' : '')}/>{chain.connection === 'CONNECTED' ? 'Testnet connected' : chain.connection === 'UNAVAILABLE' ? 'Testnet unavailable' : 'Testnet setup required'}</div>
    </aside>
    <main id="content" tabIndex={-1}>
      <header className="topbar">
        <div className="topbar-context"><span>{workspace ? 'Operator workspace' : 'Auditor view'}</span><span className="network-tag">NEAR Testnet</span></div>
        <div className="actions">
          <button className="secondary" disabled={busy || loading} onClick={() => void run(() => refresh(Boolean(workspace)))}>Refresh</button>
          {workspace && <button className="secondary" disabled={busy} onClick={lockWorkspace}>Lock workspace</button>}
          {workspace && chain.config && <button className="secondary" disabled={busy} onClick={() => void run(async () => {
            const instance = await walletConnector();
            if (walletId) await instance.disconnect();
            else await instance.connect();
          })}>{walletId ? clip(walletId) + ' · Disconnect' : 'Connect owner wallet'}</button>}
        </div>
      </header>
      <section className="content" aria-labelledby="page-title">
        <div className="heading"><div><h1 id="page-title">{tab}</h1><p>{{
          Dashboard: 'Review invoices and track approved payments on NEAR.',
          Invoices: 'Upload an invoice and review its payment details.',
          Mandates: 'Review the exact payment terms recorded on NEAR.',
          Activity: 'Follow invoice analysis and Testnet transaction results.',
          'Security Demo': 'Check how the contract handles four payment requests.',
        }[tab]}</p></div>{workspace && <Badge text={workspace.analysis === 'cloud' ? 'NEAR AI Cloud' : 'Demo analysis mode'}/>}</div>
        {notice && <div className={'notice ' + (notice.error ? 'warning' : '')} role={notice.error ? 'alert' : 'status'}>{notice.text} {notice.href && <a href={notice.href} target="_blank" rel="noreferrer">View transaction ↗</a>}</div>}
        {loading && <p role="status">Loading workspace…</p>}
        {!workspace && !loading && <section className="panel unlock"><div><h2>Operator access</h2><p>Unlock invoice review and agent execution.</p></div>
          <form onSubmit={unlock} className="inline"><label className="sr-only" htmlFor="secret">Workspace token</label><input id="secret" name="secret" type="password" placeholder="Workspace access token" required autoComplete="off"/><button disabled={busy}>Unlock</button></form>
        </section>}
        {tab === 'Dashboard' && <>
          <section className="treasury" aria-label="Payment balances">
            <div className="treasury-main">
              <div className="treasury-title"><span>Available balance</span><Badge text={chain.connection}/></div>
              <strong>{amount(chain.config?.available_yocto)}</strong>
              <p>{chain.config ? 'Available to reserve for new mandates' : 'Balances appear when a Testnet contract is connected.'}</p>
            </div>
            <div className="treasury-side">
              <span>Reserved for payment</span><strong>{amount(chain.config?.reserved_yocto)}</strong>
              {workspace && <button onClick={() => setTab('Invoices')}>Review invoices <span aria-hidden="true">↗</span></button>}
            </div>
          </section>
          <div className="metrics">
            {[
              [hasMore ? 'Approved · latest 100' : 'Approved mandates', chain.config ? String(awaiting) : '—'],
              [hasMore ? 'Paid · latest 100' : 'Paid mandates', chain.config ? String(paid) : '—'],
              ['Flagged invoices', workspace ? String(flagged) : '—'],
            ].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}
          </div>
          <div className="dashboard-grid">
            <section className="panel"><div className="panel-head"><h2>Invoice review</h2>
              {workspace && <button className="secondary" onClick={() => setTab('Invoices')}>All invoices</button>}</div>
              {queue.length ? <ul className="activity">{queue.map(item => <li key={item.hash}>
                <div><strong>{item.fields?.number ?? item.filename}</strong><small>{item.fields?.supplier ?? 'Manual review required'}</small></div>
                <div className="actions"><Badge text={item.warnings.length ? 'FLAGGED' : 'REVIEW'}/><button className="secondary"
                  onClick={() => { setInvoiceHash(item.hash); setTab('Invoices'); }}
                  aria-label={'Review invoice ' + (item.fields?.number ?? item.filename)}>Review</button></div>
              </li>)}</ul> : <p>{workspace ? 'Invoices with warnings or incomplete terms will appear here.' : 'Unlock the workspace to view private invoices.'}</p>}
            </section>
            <section className="panel">
              <div className="panel-head"><h2>Testnet setup</h2><Badge text={chain.connection}/></div>
              {chain.config ? <dl className="details"><dt>Contract</dt><dd>{chain.contractId}</dd><dt>Owner</dt><dd>{chain.config.owner_id}</dd><dt>Agent</dt><dd>{chain.config.agent_id}</dd>
                {workspace && <><dt>Signing key</dt><dd>{chain.agentStatus === 'READY' ? 'Verified' : chain.agentStatus === 'UNVERIFIED' ? 'Could not verify access or allowance' : 'Setup required'}</dd></>}
              </dl> : <p>{chain.connection === 'UNAVAILABLE' ? 'The contract or RPC could not be read. Refresh to try again.' : 'Deploy the payment contract and configure its Testnet account to enable payments.'}</p>}
              {owner && <form className="inline fund" onSubmit={event => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void run(() => walletCall('fund', {}, toYocto(String(data.get('fund')))));
              }}><label htmlFor="fund">Fund in NEAR</label><input id="fund" name="fund" placeholder="0.25" inputMode="decimal" required/><button disabled={busy}>Review in wallet</button></form>}
            </section>
          </div>
          <section className="panel"><div className="panel-head"><h2>Recent agent activity</h2><button className="secondary" onClick={() => setTab('Activity')}>View activity</button></div>
            {attempts.length ? <AttemptList items={attempts.slice(0, 5)}/> : <p>No agent attempts recorded in this workspace.</p>}
          </section>
        </>}
        {tab === 'Invoices' && <>
          {workspace && <section className="panel"><h2>Add invoice</h2><form onSubmit={upload} className="form">
            <label>UTF-8 text file<input name="file" type="file" accept=".txt,text/plain"/></label>
            <label>Or paste invoice text<textarea name="text" rows={4} placeholder="Supplier: …"/></label>
            <button disabled={busy}>{busy ? 'Working…' : 'Analyze invoice'}</button>
          </form></section>}
          <section className="panel"><h2>Invoices</h2>
            {invoices.length ? <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Supplier</th><th>Amount</th><th>Analysis</th><th>Mandate</th><th>Added</th><th>Action</th></tr></thead><tbody>
              {invoices.map(row => <tr key={row.hash}><td>{row.fields?.number ?? row.filename}</td><td>{row.fields?.supplier ?? '—'}</td><td>{row.fields ? row.fields.amount + ' NEAR' : '—'}</td><td><Badge text={row.warnings.length ? 'FLAGGED' : row.error ? 'REVIEW' : 'PARSED'}/></td><td>{chain.mandates.find(item => item.invoice_hash === row.hash)?.status ?? '—'}</td><td>{readable(row.added)}</td><td><button className="secondary" onClick={() => setInvoiceHash(row.hash)}>Review</button></td></tr>)}
            </tbody></table></div> : <p>{workspace ? 'Upload a text invoice to begin.' : 'Unlock the workspace to view private invoices.'}</p>}
          </section>
          {invoice && <section key={invoice.hash} className="panel"><h2 ref={invoiceHeading} tabIndex={-1}>Review {invoice.fields?.number ?? invoice.filename}</h2>
            <p>Analysis: {invoice.mode === 'demo' ? 'deterministic demo parser' : 'NEAR AI Cloud'}</p>
            {invoice.error && <p className="warning notice">{invoice.error}</p>}
            {duplicate && <p className="warning notice">Another document has this supplier and invoice number. Verify that it represents a separate obligation before approving.</p>}
            {invoice.warnings.map(warning => <p key={warning} className="warning notice">{warning}</p>)}
            <dl className="details"><dt>SHA-256</dt><dd><code>{invoice.hash}</code></dd>{invoice.fields && <>
              <dt>Supplier</dt><dd>{invoice.fields.supplier}</dd><dt>Invoice date</dt><dd>{invoice.fields.date}</dd><dt>Due</dt><dd>{invoice.fields.due}</dd><dt>Description</dt><dd>{invoice.fields.description}</dd>
            </>}</dl>
            <details><summary>Original invoice</summary><pre>{invoice.text}</pre></details>
            <form className="form" onSubmit={event => void approve(event, invoice)}>
              <label>Verified recipient<input name="recipient" required defaultValue={invoice.fields?.recipient} placeholder="vendor.testnet"/></label>
              <label>Exact amount in NEAR<input name="amount" required inputMode="decimal" defaultValue={invoice.fields?.amount}/></label>
              <label>Mandate expiry (local time)<input name="expiry" type="datetime-local" required/></label>
              <label className="confirm"><input type="checkbox" required/>I verified the recipient and amount against the original invoice.</label>
              <button disabled={busy || !canApprove}>Review approval in wallet</button>
              {!owner && <p>{chain.config ? 'Connect the configured owner wallet to approve.' : 'Connect a Testnet contract before approving.'}</p>}
              {owner && !canApprove && <p>This document already has a payment or an active reservation.</p>}
            </form>
          </section>}
        </>}
        {tab === 'Mandates' && <>
          <section className="panel"><h2>On-chain mandates</h2>{chain.mandates.length ?
            <div className="table-wrap"><table><thead><tr><th>Mandate</th><th>Recipient</th><th>Amount</th><th>Status</th><th>Expiry</th><th>Action</th></tr></thead><tbody>
              {chain.mandates.map(item => <tr key={item.mandate_id}><td><code>{clip(item.mandate_id)}</code></td><td>{item.recipient_id}</td><td>{amount(item.amount_yocto)}</td><td><Badge text={item.status}/></td><td>{dateNs(item.expires_at_ns)}</td><td><button className="secondary" onClick={() => setMandateId(item.mandate_id)}>Details</button></td></tr>)}
            </tbody></table></div> : <p>No on-chain mandates loaded.</p>}</section>
          {mandate && <section className="panel"><div className="panel-head"><h2>Mandate details</h2><Badge text={mandate.status}/></div>
            <dl className="details"><dt>ID</dt><dd>{mandate.mandate_id}</dd><dt>Owner</dt><dd>{mandate.owner_id}</dd><dt>Recipient</dt><dd>{mandate.recipient_id}</dd><dt>Amount</dt><dd>{amount(mandate.amount_yocto)} · {mandate.amount_yocto} yoctoNEAR</dd><dt>Invoice hash</dt><dd><code>{mandate.invoice_hash}</code></dd><dt>Expires</dt><dd>{dateNs(mandate.expires_at_ns)}</dd><dt>Attempt</dt><dd>{mandate.execution_attempt_id}</dd></dl>
            <div className="actions">
              {canExecute && mandate.status === 'APPROVED' && <button disabled={busy} onClick={() => void execute(mandate.mandate_id, 'valid')}>Run agent execution</button>}
              {owner && mandate.reservation_active && (mandate.status === 'APPROVED' || mandate.status === 'EXPIRED') && <button className="secondary" disabled={busy} onClick={() => void run(() => walletCall('cancel_mandate', { mandate_id: mandate.mandate_id }, '1'))}>{mandate.status === 'EXPIRED' ? 'Release expired reservation' : 'Review cancellation in wallet'}</button>}
            </div>
            <AttemptList items={attempts.filter(item => item.mandate === mandate.mandate_id)}/>
          </section>}
        </>}
        {tab === 'Activity' && <>
          <section className="panel"><h2>Testnet execution attempts</h2>{attempts.length ? <AttemptList items={attempts} open={openMandate} reconcile={workspace ? hash => void run(async () => {
            const result: Attempt = await api({ action: 'reconcile', hash });
            setNotice({ text: result.message });
            await refresh(true);
          }) : undefined} busy={busy}/> : <p>No execution attempts recorded in this workspace.</p>}</section>
          <section className="panel"><h2>Local invoice analysis</h2>{invoices.length ? <ul className="activity">{invoices.map(item => <li key={item.hash}><div><strong>{item.fields?.number ?? item.filename}</strong><small>{item.mode === 'demo' ? 'Demo parser' : 'NEAR AI Cloud'} · {readable(item.added)}</small></div><Badge text={item.warnings.length ? 'FLAGGED' : item.error ? 'REVIEW' : 'PARSED'}/></li>)}</ul> : <p>No local analysis activity.</p>}</section>
        </>}
        {tab === 'Security Demo' && <>{!canExecute && <div className="notice">Testnet execution requires a connected contract, an operator session and a verified agent key.</div>}<div className="scenario-grid">{scenarios.map(scenario => {
          const eligible = chain.mandates.filter(item => scenario.id === 'duplicate' ? item.status === 'PAID' :
            item.status === 'APPROVED' && (scenario.id !== 'injection' || invoices.some(row => row.hash === item.invoice_hash && row.warnings.length)));
          const observed = attempts.find(item => item.scenario === scenario.id);
          const selected = eligible.find(item => item.mandate_id === demoIds[scenario.id]);
          return <section className="panel scenario" key={scenario.id}><h2>{scenario.title}</h2><p>{scenario.instruction}</p><div className="expected"><strong>Expected result</strong><p>{scenario.expected}</p></div>
            <label>Mandate<select value={demoIds[scenario.id] ?? ''} onChange={event => setDemoIds({ ...demoIds, [scenario.id]: event.target.value })}><option value="">Choose mandate</option>{eligible.map(item => <option value={item.mandate_id} key={item.mandate_id}>{clip(item.mandate_id)} · {item.recipient_id}</option>)}</select></label>
            {selected && <dl className="details"><dt>Approved payee</dt><dd>{selected.recipient_id}</dd><dt>Amount</dt><dd>{amount(selected.amount_yocto)}</dd></dl>}
            <button disabled={!canExecute || busy || !selected} onClick={() => { if (selected) void execute(selected.mandate_id, scenario.id); }}>Run on Testnet</button>
            {observed ? <AttemptList items={[observed]}/> : <p className="muted">No observed result yet.</p>}
          </section>;
        })}</div></>}
      </section>
    </main>
  </div>;
}

function AttemptList({ items, open, reconcile, busy }: { items: Attempt[]; open?: (id: string) => void; reconcile?: (hash: string) => void; busy?: boolean }) {
  if (!items.length) return null;
  return <ul className="activity">{items.map(item => <li key={item.hash}><div>
    <strong>{scenarios.find(scenario => scenario.id === item.scenario)?.title}</strong>
    <small>{item.message}</small><small>{readable(item.created)} · <a href={explorer(item.hash)} target="_blank" rel="noreferrer">{clip(item.hash)} ↗</a></small>
  </div><div className="actions"><Badge text={item.status}/>{open && <button className="secondary" onClick={() => open(item.mandate)}>Mandate</button>}
    {reconcile && (item.status === 'PENDING' || item.status === 'UNKNOWN') && <button className="secondary" disabled={busy} onClick={() => reconcile(item.hash)}>Check result</button>}</div></li>)}</ul>;
}
