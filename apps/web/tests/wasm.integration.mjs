import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wasm = await WebAssembly.compile(await readFile(new URL('../../../artifacts/paymandate.wasm', import.meta.url)));
const near = 10n ** 24n;
const owner = 'owner.testnet';
const agent = 'agent.testnet';
const contract = 'contract.testnet';
const vendor = 'vendor.testnet';

function testHost() {
  let state = new Map();
  let instance, registers, args, caller, deposit, receipt, output, actions;
  const memory = () => Buffer.from(instance.exports.memory.buffer);
  const bytes = (len, ptr) => len === -1n ? registers.get(ptr)
    : Buffer.from(memory().subarray(Number(ptr), Number(ptr + len)));
  const text = (len, ptr) => bytes(len, ptr).toString();
  const put = (id, data) => registers.set(id, Buffer.from(data));
  const amountAt = ptr => memory().readBigUInt64LE(Number(ptr)) | memory().readBigUInt64LE(Number(ptr) + 8) << 64n;
  const writeAmount = (ptr, amount) => {
    memory().writeBigUInt64LE(BigInt.asUintN(64, amount), Number(ptr));
    memory().writeBigUInt64LE(amount >> 64n, Number(ptr) + 8);
  };
  const api = {
    input: id => put(id, JSON.stringify(args)),
    register_len: id => BigInt(registers.get(id)?.length ?? -1),
    read_register: (id, ptr) => registers.get(id).copy(memory(), Number(ptr)),
    value_return: (len, ptr) => { output = JSON.parse(text(len, ptr)); },
    panic_utf8: (len, ptr) => { throw new Error(text(len, ptr)); },
    log_utf8: () => {},
    predecessor_account_id: id => put(id, caller),
    current_account_id: id => put(id, contract),
    attached_deposit: ptr => writeAmount(ptr, deposit),
    account_balance: ptr => writeAmount(ptr, 10n * near),
    block_timestamp: () => 100n,
    storage_usage: () => BigInt([...state].reduce((sum, [key, value]) => sum + key.length / 2 + value.length, 0)),
    storage_has_key: (len, ptr) => state.has(bytes(len, ptr).toString('hex')) ? 1n : 0n,
    storage_read: (len, ptr, id) => {
      const previous = state.get(bytes(len, ptr).toString('hex'));
      if (!previous) return 0n;
      put(id, previous);
      return 1n;
    },
    storage_write: (len, ptr, valueLen, valuePtr, id) => {
      const key = bytes(len, ptr).toString('hex');
      const previous = state.get(key);
      state.set(key, Buffer.from(bytes(valueLen, valuePtr)));
      if (!previous) return 0n;
      put(id, previous);
      return 1n;
    },
    promise_batch_create: (len, ptr) => {
      actions.push({ recipient: text(len, ptr) });
      return 0n;
    },
    promise_batch_action_transfer: (index, ptr) => { actions.push({ index, amount: amountAt(ptr) }); },
    promise_batch_then: (index, len, ptr) => {
      actions.push({ after: index, recipient: text(len, ptr) });
      return 1n;
    },
    promise_batch_action_function_call_weight: (index, len, ptr, argsLen, argsPtr, amountPtr, gas) => {
      actions.push({ index, method: text(len, ptr), args: JSON.parse(text(argsLen, argsPtr)), deposit: amountAt(amountPtr), gas });
    },
    promise_return: index => { actions.push({ returned: index }); },
    promise_results_count: () => receipt === undefined ? 0n : 1n,
    promise_result: (_index, id) => {
      if (receipt === 'failed') return 2n;
      assert.equal(receipt, 'success');
      put(id, Buffer.alloc(0));
      return 1n;
    },
  };
  const env = Object.fromEntries(WebAssembly.Module.imports(wasm).map(({ name }) => [
    name, api[name] ?? (() => { throw new Error('Unexpected host call: ' + name); }),
  ]));

  return (method, input = {}, context = {}) => {
    const previous = new Map(state);
    instance = new WebAssembly.Instance(wasm, { env });
    args = input;
    caller = context.caller ?? owner;
    deposit = context.deposit ?? 0n;
    receipt = context.receipt;
    registers = new Map();
    actions = [];
    output = undefined;
    try {
      instance.exports[method]();
      return { value: output, actions };
    } catch (error) {
      state = previous;
      throw error;
    }
  };
}

const amount = near / 100n;
const init = { owner_id: owner, agent_id: agent };
const terms = { mandate_id: 'invoice-wasm', recipient_id: vendor, amount_yocto: String(amount), invoice_hash: 'a'.repeat(64) };
const callback = { mandate_id: terms.mandate_id, attempt: '1' };

function approvedHost() {
  const call = testHost();
  assert.throws(() => call('new', init), /DEPLOYER_ONLY/);
  call('new', init, { caller: contract });
  call('fund', {}, { deposit: 2n * amount });
  assert.throws(() => call('approve_mandate', { ...terms, expires_at_ns: '500' }), /1 yocto/i);
  call('approve_mandate', { ...terms, expires_at_ns: '500' }, { deposit: 1n });
  return call;
}

test('compiled WASM authorizes, schedules an exact transfer and settles only once', () => {
  const call = approvedHost();
  const before = call('get_config').value;
  assert.equal(before.reserved_yocto, terms.amount_yocto);
  assert.throws(() => call('execute_mandate', terms), /AGENT_ONLY/);
  assert.throws(() => call('execute_mandate', { ...terms, amount_yocto: '1' }, { caller: agent }), /AMOUNT_MISMATCH/);
  assert.deepEqual(call('get_config').value, before);
  assert.deepEqual(call('execute_mandate', terms, { caller: agent }).actions, [
    { recipient: vendor },
    { index: 0n, amount },
    { after: 0n, recipient: contract },
    { index: 1n, method: 'settle', args: callback, deposit: 0n, gas: 15_000_000_000_000n },
    { returned: 1n },
  ]);
  assert.throws(() => call('settle', callback, { caller: agent, receipt: 'success' }), /private/i);
  assert.throws(() => call('execute_mandate', terms, { caller: agent }), /NOT_APPROVED/);
  assert.equal(call('settle', callback, { caller: contract, receipt: 'success' }).value, 'PAID');
  assert.equal(call('get_mandate', { mandate_id: terms.mandate_id }).value.status, 'PAID');
  assert.equal(call('get_config').value.reserved_yocto, '0');
  assert.throws(() => call('settle', callback, { caller: contract, receipt: 'success' }), /STALE_CALLBACK/);
});

test('compiled WASM preserves reservation on failure and rejects stale retry callbacks', () => {
  const call = approvedHost();
  call('execute_mandate', terms, { caller: agent });
  assert.equal(call('settle', callback, { caller: contract, receipt: 'failed' }).value, 'APPROVED');
  assert.equal(call('get_config').value.reserved_yocto, terms.amount_yocto);
  const retry = call('execute_mandate', terms, { caller: agent }).actions.find(action => action.method === 'settle');
  assert.equal(retry.args.attempt, '2');
  assert.throws(() => call('settle', callback, { caller: contract, receipt: 'success' }), /STALE_CALLBACK/);
  assert.equal(call('settle', retry.args, { caller: contract, receipt: 'success' }).value, 'PAID');
});
