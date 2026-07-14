import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let authToken = '';

  async function request<T>(method: string, url: string, body?: unknown, admin = false): Promise<T> {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}), ...(admin && env.ADMIN_API_KEY ? { 'x-admin-api-key': env.ADMIN_API_KEY } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  try {
    const email = `support+${Date.now()}@sivan.test`;
    const started: any = await request('POST', '/api/auth/email/start', { email, fullName: 'Support User', intent: 'signup' });
    const verified: any = await request('POST', '/api/auth/email/verify', { email, code: started.data.devCode });
    authToken = verified.data.token;
    const user = verified.data.user;
    assert(Boolean(user.id), 'created user for support test');

    const upload: any = await request('POST', '/api/support/attachments/upload-url', { userId: user.id, fileName: 'receipt.png', contentType: 'image/png', sizeBytes: 1000 });
    assert(upload.data.provider === 'mock' && upload.data.uploadUrl, 'support attachment upload URL can be created');

    const ticketResponse: any = await request('POST', '/api/support/tickets', {
      userId: user.id,
      type: 'wrong_token_or_network',
      subject: 'I sent funds on the wrong network',
      description: 'I may have sent a test deposit on the wrong network and need help reviewing recovery options.',
      resourceType: 'general'
    });
    const ticket = ticketResponse.data;
    assert(ticket.priority === 'urgent', 'wrong-network ticket auto-prioritizes as urgent');
    assert(ticket.status === 'open', 'new support ticket starts open');
    assert(ticket.messages.length === 1, 'ticket creates initial user message');

    const list: any = await request('GET', `/api/users/${user.id}/support/tickets`);
    assert(list.data.some((item: any) => item.id === ticket.id), 'user can list own support tickets');

    const fetched: any = await request('GET', `/api/support/tickets/${ticket.id}`);
    assert(fetched.data.id === ticket.id, 'user can fetch own support ticket');

    const userReply: any = await request('POST', `/api/support/tickets/${ticket.id}/messages`, { message: 'Here is an extra detail from the user side.' });
    assert(userReply.data.senderType === 'user', 'user can add ticket reply');

    const adminList: any = await request('GET', '/api/admin/support/tickets', undefined, true);
    assert(adminList.data.some((item: any) => item.id === ticket.id), 'admin can list support tickets');
    const filteredList: any = await request('GET', '/api/admin/support/tickets?priority=urgent&type=wrong_token_or_network&search=wrong', undefined, true);
    assert(filteredList.data.some((item: any) => item.id === ticket.id), 'admin can filter support tickets by priority type and search');
    const analytics: any = await request('GET', '/api/admin/support/analytics', undefined, true);
    assert(analytics.data.urgentTickets >= 1, 'admin support analytics counts urgent tickets');

    const updated: any = await request('PUT', `/api/admin/support/tickets/${ticket.id}`, { status: 'in_review', priority: 'urgent', assignedTo: 'ops' }, true);
    assert(updated.data.status === 'in_review', 'admin can update ticket status');

    const adminReply: any = await request('POST', `/api/admin/support/tickets/${ticket.id}/messages`, { message: 'We are reviewing this with the provider.', internalNote: false }, true);
    assert(adminReply.data.senderType === 'admin', 'admin can reply to ticket');

    const adminNote: any = await request('POST', `/api/admin/support/tickets/${ticket.id}/messages`, { message: 'Internal provider escalation started.', internalNote: true }, true);
    assert(adminNote.data.internalNote === true, 'admin can add internal note');

    const resolved: any = await request('PUT', `/api/admin/support/tickets/${ticket.id}`, { status: 'resolved' }, true);
    assert(Boolean(resolved.data.closedAt), 'resolved ticket records closedAt');

    await app.close();
    console.log('\n✅ Support ticket E2E passed');
    console.log(JSON.stringify({ userId: user.id, ticketId: ticket.id, status: resolved.data.status }, null, 2));
  } catch (error) {
    await app.close();
    throw error;
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
