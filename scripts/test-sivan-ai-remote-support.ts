import assert from 'node:assert/strict';
import http from 'node:http';

let capturedBody: any = null;
const sivanAi = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/ace/support/answer') {
    let raw = '';
    req.on('data', (chunk) => raw += chunk);
    req.on('end', () => {
      capturedBody = JSON.parse(raw || '{}');
      const authorized = req.headers['x-sivan-ai-key'] === 'remote-test-key';
      res.writeHead(authorized ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(authorized ? {
        data: {
          requestId: 'ai_req_remote_test',
          answer: 'Sivan Assistant checked the transaction evidence. Your withdrawal is still being processed by the provider. No action is needed right now.',
          confidence: 'high',
          needsHuman: false,
          currentStage: 'Provider processing',
          estimatedCompletion: 'usually 2–5 minutes after provider confirmation',
          evidenceUsed: ['transaction.id', 'transaction.status', 'timeline.currentStage'],
          suggestedActions: [{ label: 'Answer user', actionType: 'answer', priority: 'normal', reason: 'Evidence is sufficient.' }],
          safetyNotes: ['Customer-visible answer; internal details hidden.'],
          aiTrace: { provider: 'local', model: 'deterministic-ace-v1', fallbackUsed: false, latencyMs: 1, generatedAt: new Date().toISOString() }
        }
      } : { error: 'unauthorized' }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

await new Promise<void>((resolve) => sivanAi.listen(0, '127.0.0.1', resolve));
const address = sivanAi.address();
if (!address || typeof address === 'string') throw new Error('Could not start fake Sivan AI');

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-sivan-ai-remote-support.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.ACE_PROVIDER = 'remote';
process.env.SIVAN_AI_API_URL = `http://127.0.0.1:${address.port}`;
process.env.SIVAN_AI_API_KEY = 'remote-test-key';
process.env.SIVAN_AI_FALLBACK_ENABLED = 'true';

try {
  const { db } = await import('../src/database/json-database.js');
  const { answerAceSupport } = await import('../src/ace/service/ace-support.service.js');
  const now = new Date().toISOString();
  await db.mutate((data) => {
    data.users = [{ id: 'usr_remote_ai', email: 'remote-ai@sivan.test', fullName: 'Remote AI User', createdAt: now, updatedAt: now } as any];
    data.customers = [{ id: 'cus_remote_ai', userId: 'usr_remote_ai', provider: 'bridge', providerCustomerId: 'bridge_remote_ai', kycStatus: 'kyc_approved', tosStatus: 'approved', createdAt: now, updatedAt: now } as any];
    data.liquidationAddresses = [{ id: 'la_remote_ai', userId: 'usr_remote_ai', customerId: 'cus_remote_ai', externalAccountId: 'ea_remote_ai', provider: 'bridge', providerLiquidationAddressId: 'pla_remote_ai', address: '0xabc', chain: 'avalanche_c_chain', sourceCurrency: 'usdc', destinationCurrency: 'usd', destinationPaymentRail: 'ach', status: 'active', createdAt: now, updatedAt: now } as any];
    data.withdrawals = [{ id: 'wd_remote_ai', userId: 'usr_remote_ai', customerId: 'cus_remote_ai', externalAccountId: 'ea_remote_ai', liquidationAddressId: 'la_remote_ai', provider: 'bridge', providerDrainId: 'drain_remote_ai', sourceCurrency: 'usdc', destinationCurrency: 'usd', sourceAmount: '100', destinationAmount: '99', status: 'payout_processing', createdAt: now, updatedAt: now } as any];
    data.systemIncidents = [];
    data.webhookEvents = [];
    data.transactionReferences = [];
    data.reconciliationFindings = [];
    data.supportTickets = [];
    data.supportTicketMessages = [];
    data.aceSupportSessions = [];
    data.aceSupportMessages = [];
    data.aceToolCalls = [];
    data.aceSupportResolutions = [];
  });

  const answer = await answerAceSupport({ userId: 'usr_remote_ai', message: 'Where is my withdrawal?', resourceType: 'withdrawal', resourceId: 'wd_remote_ai', channel: 'web_dashboard' });
  assert.equal(answer.answer.includes('Sivan Assistant checked'), true, 'remote Sivan AI answer is used');
  assert.equal((answer as any).remoteTrace.provider, 'local', 'remote trace is retained');
  assert.equal(capturedBody.policy.customerVisible, true, 'remote request is customer-visible');
  assert.equal(capturedBody.policy.allowInternalDetails, false, 'customer remote request disallows internal details');
  assert.equal(capturedBody.policy.allowActions, false, 'remote request disallows actions');
  assert.equal(capturedBody.evidence.some((item: any) => item.source === 'user.email'), false, 'customer remote evidence excludes user email');
  assert.equal(capturedBody.evidence.some((item: any) => item.metadata), false, 'customer remote evidence excludes metadata');

  const data = await db.read();
  assert.equal((data.aceSupportSessions[0].evidenceSnapshot as any).aceProvider, 'remote', 'support evidence records remote provider');
  console.log(JSON.stringify({ ok: true, provider: 'remote', evidenceCount: capturedBody.evidence.length, answer: answer.answer }, null, 2));
} finally {
  await new Promise<void>((resolve) => sivanAi.close(() => resolve()));
}
