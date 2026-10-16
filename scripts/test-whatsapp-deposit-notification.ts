import assert from 'node:assert/strict';
import http from 'node:http';
import { db } from '../src/database/json-database.js';
import { notifyWhatsAppDeposit } from '../src/deposits/deposit-notification.service.js';
import type { WalletDepositRecord } from '../src/database/types.js';

async function main() {
  console.log('Testing WhatsApp deposit notification...');

  // Setup a mock receiver on a local port
  let receivedRequest: { headers: http.IncomingHttpHeaders; body: any } | null = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      receivedRequest = {
        headers: req.headers,
        body: JSON.parse(raw || '{}'),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'queued', to: receivedRequest.body.to }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const mockNotifyBaseUrl = `http://127.0.0.1:${port}`;

  process.env.WHATSAPP_NOTIFICATION_URL = mockNotifyBaseUrl;
  process.env.CORE_API_SECRET = process.env.CORE_API_SECRET || 'test-mock-secret';

  // Seed a user with linked WhatsApp
  const testUserId = `usr_live_deposit_test_${Date.now()}`;
  const targetPhone = '+2348098765432';

  await db.insertUserRecord({
    id: testUserId,
    email: `${testUserId}@example.com`,
    passwordHash: 'dummy',
    kycTier: 'tier_0_unverified',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    role: 'user',
    whatsappNumber: targetPhone,
    fullName: 'Jane Doe',
    status: 'active',
  } as any);

  const depositRecord: WalletDepositRecord = {
    id: `dep_${Date.now()}`,
    userId: testUserId,
    walletAddress: '0x1234567890123456789012345678901234567890',
    chain: 'solana',
    asset: 'USDC',
    amount: '25.00',
    txHash: '5x123...test',
    status: 'confirmed',
    detectedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  };

  try {
    await notifyWhatsAppDeposit(testUserId, depositRecord);

    assert.ok(receivedRequest, 'Mock WhatsApp bot receiver should have received the POST request');
    const expectedSecret = process.env.NOTIFY_SECRET || process.env.CORE_API_SECRET;
    assert.equal(
      receivedRequest.headers['x-notify-secret'],
      expectedSecret,
      'x-notify-secret header must match NOTIFY_SECRET or CORE_API_SECRET'
    );
    assert.equal(
      receivedRequest.body.to,
      `whatsapp:${targetPhone}`,
      'Recipient must be properly normalized to whatsapp:+234...'
    );
    assert.ok(
      receivedRequest.body.message.includes('25.00 USDC'),
      'Message text must include the amount and asset'
    );
    assert.ok(
      receivedRequest.body.message.includes('Solana'),
      'Message text must include human-readable chain name'
    );
    assert.ok(
      receivedRequest.body.message.includes('Jane Doe'),
      'Message text must include user label'
    );

    console.log('✓ notifyWhatsAppDeposit successfully delivered formatted message to recipient');
    console.log('✓ Secret auth header verified');
    console.log('✓ Recipient format verified');
    console.log('✓ Text body verified');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
