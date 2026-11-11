import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { workspaceHeader, workspaceHeaderValue } from './domain.ts';

const cookieName = 'paymandate_session';
const lifetime = 4 * 60 * 60;
const failedWindow = 60_000;
const state = globalThis as typeof globalThis & {
  paymandateAuth?: { sessions: Map<string, number>; failures: number[] };
};
const auth: NonNullable<typeof state.paymandateAuth> = state.paymandateAuth ??= { sessions: new Map(), failures: [] };

const digest = (value: string) => createHash('sha256').update(value).digest();

export function validToken(value: string) {
  const token = process.env.PAYMANDATE_WORKSPACE_TOKEN;
  return Boolean(token && token.length >= 24 && value && timingSafeEqual(digest(value), digest(token)));
}

export function loopbackRequest(request: Request, mutation = false) {
  const host = request.headers.get('host')?.toLowerCase();
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== 'http://' + host && origin !== 'https://' + host) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  return !mutation || Boolean(origin) || Boolean(request.headers.get('authorization'));
}

function sessionKey(request: Request) {
  const cookies = request.headers.get('cookie')?.split(';').map(cookie => cookie.trim()) ?? [];
  const candidate = cookies.find(cookie => cookie.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  return candidate && /^[a-f0-9]{64}$/.test(candidate) ? digest(candidate).toString('hex') : undefined;
}

export function activeSession(request: Request) {
  const key = sessionKey(request);
  if (!key) return false;
  const expiry = auth.sessions.get(key);
  if (expiry && expiry > Date.now()) return true;
  auth.sessions.delete(key);
  return false;
}

export function workspaceBrowserRequest(request: Request) {
  return request.headers.get(workspaceHeader) === workspaceHeaderValue;
}

export function authorized(request: Request) {
  const bearer = request.headers.get('authorization');
  return bearer ? bearer.startsWith('Bearer ') && validToken(bearer.slice(7)) : workspaceBrowserRequest(request) && activeSession(request);
}

export function sessionRateLimited() {
  const cutoff = Date.now() - failedWindow;
  auth.failures = auth.failures.filter(time => time > cutoff);
  return auth.failures.length >= 8;
}

export function recordSessionFailure() {
  auth.failures.push(Date.now());
}

function cookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === 'https:' || request.headers.get('origin')?.startsWith('https:');
  return cookieName + '=' + value + '; Path=/api; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure ? '; Secure' : '');
}

export function createSession(request: Request) {
  const now = Date.now();
  for (const [key, expiry] of auth.sessions) if (expiry <= now) auth.sessions.delete(key);
  const old = sessionKey(request);
  if (old) auth.sessions.delete(old);
  if (auth.sessions.size >= 32) auth.sessions.delete(auth.sessions.keys().next().value!);
  const id = randomBytes(32).toString('hex');
  auth.sessions.set(digest(id).toString('hex'), now + lifetime * 1000);
  auth.failures = [];
  return cookie(request, id, lifetime);
}

export function endSession(request: Request) {
  const key = sessionKey(request);
  if (key) auth.sessions.delete(key);
  return cookie(request, '', 0);
}

export function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export async function limitedJson(request: Request, maximum: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0].toLowerCase() !== 'application/json') {
    throw new Error('Expected JSON.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new Error('Request is too large.');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
