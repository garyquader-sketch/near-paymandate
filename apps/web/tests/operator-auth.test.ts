import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeSession, authorized, createSession, endSession, limitedJson, loopbackRequest,
  recordSessionFailure, sessionRateLimited,
} from '../src/lib/operator-auth.ts';

const host = '127.0.0.1:4319';
const url = 'http://' + host;
const local = (headers: HeadersInit = {}) => new Request(url, { headers: { Host: host, ...headers } });
const extractCookie = (value: string) => value.split(';', 1)[0];

test('origin and host gates preserve local reads and require a mutation origin or bearer header', () => {
  assert.equal(loopbackRequest(local()), true);
  assert.equal(loopbackRequest(local(), true), false);
  assert.equal(loopbackRequest(local({ Origin: url }), true), true);
  assert.equal(loopbackRequest(local({ Authorization: 'Bearer test' }), true), true);
  for (const headers of [
    { Origin: 'https://example.test' },
    { Origin: 'null' },
    { Origin: url, 'Sec-Fetch-Site': 'cross-site' },
    { Host: 'example.test:4319' },
  ]) assert.equal(loopbackRequest(local(headers)), false);
});

test('sessions rotate, expire exactly at four hours, and revoke on logout', context => {
  let now = 100_000;
  context.mock.method(Date, 'now', () => now);
  const first = extractCookie(createSession(local()));
  const second = extractCookie(createSession(local({ Cookie: first })));
  assert.notEqual(first, second);
  assert.equal(activeSession(local({ Cookie: first })), false);
  assert.equal(activeSession(local({ Cookie: second })), true);
  assert.equal(authorized(local({ Cookie: second })), false);
  assert.equal(authorized(local({ Cookie: second, 'X-PayMandate-Request': 'workspace' })), true);
  assert.equal(authorized(local({ Cookie: second, Authorization: 'Bearer incorrect' })), false);
  now += 4 * 60 * 60 * 1000 - 1;
  assert.equal(activeSession(local({ Cookie: second })), true);
  assert.equal(authorized(local({ Cookie: second })), false);
  assert.equal(authorized(local({ Cookie: second, 'X-PayMandate-Request': 'workspace' })), true);
  now += 1;
  assert.equal(activeSession(local({ Cookie: second })), false);
  const third = extractCookie(createSession(local()));
  assert.match(endSession(local({ Cookie: third })), /Max-Age=0/);
  assert.equal(activeSession(local({ Cookie: third })), false);
  assert.match(createSession(new Request('https://' + host)), /; Secure$/);
});

test('eight failures trigger throttling and leave the window after one minute', context => {
  let now = 10_000;
  context.mock.method(Date, 'now', () => now);
  createSession(local());
  for (let i = 0; i < 8; i++) {
    assert.equal(sessionRateLimited(), false);
    recordSessionFailure();
  }
  assert.equal(sessionRateLimited(), true);
  now += 59_999;
  assert.equal(sessionRateLimited(), true);
  now++;
  assert.equal(sessionRateLimited(), false);
});

test('bounded request parser accepts the exact byte limit and rejects bad MIME and JSON', async () => {
  const request = (body: string, mime = 'application/json') => new Request(url, {
    method: 'POST', body, headers: { 'Content-Type': mime },
  });
  const body = JSON.stringify({ value: '界' });
  assert.deepEqual(await limitedJson(request(body, 'application/json; charset=utf-8'), Buffer.byteLength(body)), { value: '界' });
  await assert.rejects(limitedJson(request(body), Buffer.byteLength(body) - 1), /too large/);
  await assert.rejects(limitedJson(request(body, 'text/plain'), 512), /Expected JSON/);
  await assert.rejects(limitedJson(request('{'), 512), SyntaxError);
});
