import { z } from 'zod';
import {
  activeSession, createSession, endSession, json, limitedJson,
  loopbackRequest, recordSessionFailure, sessionRateLimited, validToken, workspaceBrowserRequest,
} from '../../../../lib/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  if (!loopbackRequest(request)) return json({ error: 'Open the local workspace directly.' }, 403);
  return json({ unlocked: workspaceBrowserRequest(request) && activeSession(request) });
}

export async function POST(request: Request) {
  if (!loopbackRequest(request, true) || !workspaceBrowserRequest(request)) return json({ error: 'Open the local workspace directly.' }, 403);
  if (sessionRateLimited()) return json({ error: 'Too many attempts. Try again in one minute.' }, 429, { 'Retry-After': '60' });
  let token: string;
  try {
    token = z.object({ token: z.string().min(1).max(256) }).parse(await limitedJson(request, 512)).token;
  } catch {
    return json({ error: 'Invalid workspace sign-in request.' }, 400);
  }
  if (sessionRateLimited()) return json({ error: 'Too many attempts. Try again in one minute.' }, 429, { 'Retry-After': '60' });
  if (!validToken(token)) {
    recordSessionFailure();
    return json({ error: 'The workspace token is incorrect.' }, 401);
  }
  return json({ unlocked: true }, 200, { 'Set-Cookie': createSession(request) });
}

export function DELETE(request: Request) {
  if (!loopbackRequest(request, true) || !workspaceBrowserRequest(request)) return json({ error: 'Open the local workspace directly.' }, 403);
  return json({ unlocked: false }, 200, { 'Set-Cookie': endSession(request) });
}
