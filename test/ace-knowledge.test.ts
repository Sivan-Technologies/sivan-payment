import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const tempDbFile = path.join(os.tmpdir(), `sivan-ace-knowledge-${Date.now()}.json`);
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.USER_JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_12345';
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = tempDbFile;

const { db } = await import('../src/database/json-database.js');
const { querySivanKnowledgeBase, listPublicKnowledgeArticles } = await import('../src/ace/service/ace-knowledge.service.js');
const { answerAceSupport } = await import('../src/ace/service/ace-support.service.js');

async function runTests() {
  console.log('Running Sivan Ai Knowledge Base & Gateway Assistance Tests...');

  // 1. Verify public knowledge articles list
  const articles = listPublicKnowledgeArticles();
  assert.ok(articles.length >= 8, 'Expected at least 8 core protocol knowledge articles');

  // 2. Verify guest sign-in & onboarding question ("Need assistance?" on /signin)
  const signinAnswer = await querySivanKnowledgeBase({
    question: 'How do I sign in or create a Sivan Ai workspace account?',
    context: 'web_gateway',
  });
  assert.equal(signinAnswer.articleId, 'onboarding.signin_methods');
  assert.equal(signinAnswer.category, 'onboarding');
  assert.equal(signinAnswer.confidence, 'high');
  assert.ok(signinAnswer.answer.includes('Instant Phone & Bot Login'));
  assert.ok(signinAnswer.answer.includes('Work Email OTP'));

  // 3. Verify QR expired question
  const qrExpiredAnswer = await querySivanKnowledgeBase({
    question: 'What if the login QR code says expired or waiting for confirmation?',
    context: 'web_gateway',
  });
  assert.equal(qrExpiredAnswer.articleId, 'onboarding.qr_expired');
  assert.ok(qrExpiredAnswer.answer.includes('5 minutes'));

  // 4. Verify Service Agreements question
  const agreementAnswer = await querySivanKnowledgeBase({
    question: 'How do Sivan Service Agreements protect my funds?',
    context: 'web_gateway',
  });
  assert.equal(agreementAnswer.articleId, 'agreements.milestone_flow');
  assert.equal(agreementAnswer.category, 'service_agreements');
  assert.ok(agreementAnswer.answer.includes('4-digit security PIN'));

  // 5. Verify Supported Networks question
  const networksAnswer = await querySivanKnowledgeBase({
    question: 'Which blockchain networks and stablecoins does Sivan Ai support?',
    context: 'web_gateway',
  });
  assert.equal(networksAnswer.articleId, 'networks.dynamic_supported');
  assert.ok(networksAnswer.answer.includes('Arc'));
  assert.ok(networksAnswer.answer.includes('Arbitrum One'));
  assert.ok(networksAnswer.answer.includes('Solana'));

  // 6. Verify authenticated user asking a general knowledge question via answerAceSupport
  const now = new Date().toISOString();
  await db.insertUserRecord({
    id: 'usr_kb_001',
    email: 'freelancer@example.com',
    fullName: 'Tunde Bakare',
    country: 'NG',
    createdAt: now,
    updatedAt: now,
  });

  const supportKbAnswer = await answerAceSupport({
    userId: 'usr_kb_001',
    message: 'How do Sivan Service Agreements protect my funds?',
    resourceType: 'general',
    channel: 'web_dashboard',
  });
  assert.ok(supportKbAnswer.answer.includes('4-digit security PIN'));
  assert.ok(supportKbAnswer.evidenceChecked.includes('knowledge.agreements.milestone_flow'));

  await fs.unlink(tempDbFile).catch(() => { });
  console.log('All Sivan Ai Knowledge Base & Gateway Assistance tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

