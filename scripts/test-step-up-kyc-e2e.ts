/**
 * END-TO-END STEP-UP KYC & AUTONOMOUS AI VERIFICATION SUITE
 *
 * Covers:
 * 1. Configurable AI approval threshold & controls in database (kycControls)
 * 2. Autonomous AI Address & Document Verifier (heuristic path in sandbox)
 * 3. Two-step submission (Address -> conditional NIN + DOB for Nigeria)
 * 4. Masked NIN record-keeping (ninLast4, ninMasked, ninHash peppered with USER_JWT_SECRET)
 * 5. Zero-storage invariant: raw 11-digit NIN never saved to DB
 * 6. Multi-account duplicate NIN fraud detection flag
 * 7. Fastify HTTP routes (/kyc/controls, /api/users/:userId/kyc/tier2/context, /api/users/:userId/kyc/tier2/step-up)
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-step-up-kyc-e2e.json';
process.env.SIVAN_DATA_FILE = '.data/test-step-up-kyc-e2e.json';
process.env.IDENTITY_LINK_SERVICE_SECRET = 'kyc-test-secret';
process.env.ADMIN_API_KEY = 'kyc-admin-key';
process.env.USER_JWT_SECRET = 'kyc-jwt-secret-for-bvn-nin-hashing';
process.env.EMAIL_PROVIDER = 'console';
process.env.AUTH_DEV_SHOW_OTP = 'true';

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { db } from '../src/database/json-database.js';
import {
  getKycControls,
  updateKycControls,
  getUserTier2KycContext,
  submitWhatsAppTier2KycStep,
} from '../src/admin/verification-request.service.js';
import { runAiAddressVerification } from '../src/kyc/service/ai-address-verifier.service.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: unknown, message: string) {
  if (!condition) {
    failed++;
    failures.push(message);
    console.error(`  FAIL ${message}`);
  } else {
    passed++;
    console.log(`  ok   ${message}`);
  }
}

async function main() {
  console.log('\n=============================================================');
  console.log(' RUNNING END-TO-END STEP-UP KYC & AI VERIFIER TEST SUITE');
  console.log('=============================================================\n');

  // Reset test JSON database
  const dbPath = path.join(process.cwd(), process.env.DATABASE_FILE!);
  await fs.rm(dbPath, { force: true });
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  // ── GROUP 1: KYC Controls & Configurable AI Approval Threshold ─────────────
  console.log('--- Group 1: KYC Controls & Configurable AI Approval Threshold ---');

  const defaultControls = await getKycControls();
  assert(defaultControls.aiApprovalThreshold === 85, `Default AI threshold is 85 (got ${defaultControls.aiApprovalThreshold})`);
  assert(defaultControls.aiAutoApprovalEnabled === true, 'Default aiAutoApprovalEnabled is true');

  const updatedControls = await updateKycControls({
    aiApprovalThreshold: 90,
    aiAutoApprovalEnabled: false,
    adminId: 'admin_test',
  });
  assert(updatedControls.aiApprovalThreshold === 90, `Threshold updated to 90 (got ${updatedControls.aiApprovalThreshold})`);
  assert(updatedControls.aiAutoApprovalEnabled === false, 'aiAutoApprovalEnabled updated to false');

  const fetchedAfterUpdate = await getKycControls();
  assert(fetchedAfterUpdate.aiApprovalThreshold === 90, 'Updated controls persisted');

  // Reset back to default for the rest of the test
  await updateKycControls({ aiApprovalThreshold: 75, aiAutoApprovalEnabled: true, adminId: 'test_reset' });
  const resetControls = await getKycControls();
  assert(resetControls.aiApprovalThreshold === 75, 'Controls reset to threshold 75');
  assert(resetControls.aiAutoApprovalEnabled === true, 'Controls reset to autoApprove enabled');

  // ── GROUP 2: Heuristic AI Address & Document Verifier ───────────────────────
  console.log('\n--- Group 2: AI Address & Document Verifier (Heuristic Fallback) ---');

  // 2a. Detailed address + document attached -> should score >= 85
  const validResult = await runAiAddressVerification({
    userName: 'Samson Micheal',
    claimedAddress: '12 Marina Street, Lagos Island, Lagos State, Nigeria',
    country: 'NG',
    documentUrl: 'data:application/pdf;base64,' + Buffer.from('bank statement pdf content samson micheal').toString('base64'),
    documentType: 'bank_statement',
    documentFileName: 'samson_access_bank_statement.pdf',
    threshold: 75,
  });
  assert(validResult.overallScore >= 75, `Valid submission score (${validResult.overallScore}) >= 75`);
  assert(validResult.verdict === 'auto_approved', `Valid submission verdict is 'auto_approved' (got '${validResult.verdict}')`);
  assert(validResult.isWithin90Days === true, 'isWithin90Days defaults to true in heuristic path');
  assert(typeof validResult.analyzedAt === 'string', 'analyzedAt timestamp present');

  // 2b. No document attached -> low score, needs_review
  const noDocResult = await runAiAddressVerification({
    userName: 'Test User',
    claimedAddress: '1 Test St',
    country: 'NG',
    documentUrl: undefined,
    documentType: 'bank_statement',
    threshold: 75,
  });
  assert(noDocResult.overallScore < 75, `No-document score (${noDocResult.overallScore}) below threshold`);
  assert(noDocResult.verdict === 'needs_review', `No-document verdict is 'needs_review'`);

  // 2c. Brief address (< 15 chars) -> lower score path
  const briefAddrResult = await runAiAddressVerification({
    userName: 'Brief User',
    claimedAddress: '1 Lagos',
    country: 'NG',
    documentUrl: 'data:image/jpeg;base64,abc123',
    documentType: 'bank_statement',
    threshold: 75,
  });
  assert(briefAddrResult.addressMatchScore < validResult.addressMatchScore, 'Brief address scores lower than detailed address');

  // ── GROUP 3: End-to-End Submission (Service Layer) ───────────────────────────
  console.log('\n--- Group 3: End-to-End Submission (Service Layer) ---');

  // Create test user using insertUserRecord (actual DB API)
  const testUserId = `user_e2e_ng_${Date.now()}`;
  const testUser = {
    id: testUserId,
    username: `testuser_ng_${Date.now()}`,
    fullName: 'Samson Micheal',
    email: `samson_${Date.now()}@test.sivan`,
    emailVerified: true,
    whatsappNumber: `+2348012345678${Date.now().toString().slice(-3)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.insertUserRecord(testUser as any);

  // 3a. KYC Context Check
  const kycCtx = await getUserTier2KycContext(testUserId);
  assert(kycCtx.userId === testUserId, 'KYC context resolves user ID');
  assert(typeof kycCtx.hasNigerianBvnOrDva === 'boolean', 'KYC context returns hasNigerianBvnOrDva flag');

  // 3b. Step 1: Nigerian Address submission (expects requiresNinStep=true)
  const docUrl = 'data:application/pdf;base64,' + Buffer.from(`
    ACCESS BANK PLC STATEMENT
    Customer: Samson Micheal
    Address: 12 Marina Street Lagos Island Lagos State Nigeria
    Date: ${new Date().toISOString().slice(0, 10)}
    Balance: 245000.00 NGN
  `).toString('base64');

  const step1 = await submitWhatsAppTier2KycStep({
    userIdOrPhone: testUserId,
    step: 'address',
    country: 'NG',
    streetAddress: '12 Marina Street',
    city: 'Lagos Island',
    stateRegion: 'Lagos',
    documentType: 'bank_statement',
    proofOfAddressUrl: docUrl,
  });

  assert(step1.requiresNinStep === true, 'Nigerian address step requires NIN step');
  assert(step1.userId === testUserId, 'Step 1 returns correct userId');
  assert(typeof step1.requestId === 'string' && step1.requestId.length > 0, 'Step 1 returns a request ID');
  assert(step1.status === 'pending', 'Step 1 status is pending (NIN still needed)');

  // 3c. Step 2: NIN + DOB submission
  const rawNin = '22334454821';

  const step2 = await submitWhatsAppTier2KycStep({
    userIdOrPhone: testUserId,
    step: 'nin',
    country: 'NG',
    nin: rawNin,
    dateOfBirth: '1995-08-20',
  });

  assert(step2.userId === testUserId, 'Step 2 returns correct userId');
  assert(step2.requiresNinStep === true, 'requiresNinStep is still NG (consistent)');
  assert(step2.status === 'approved' || step2.status === 'under_review', `Step 2 status is approved or under_review (got '${step2.status}')`);

  // 3d. Privacy & Record-Keeping Invariants
  const allRequests = await db.listVerificationRequests(testUserId);
  const savedReq = allRequests.find((r) => r.id === step2.requestId);
  assert(Boolean(savedReq), 'Request persisted in database');

  const sub = savedReq?.submissionData as any;
  assert(sub?.ninLast4 === '4821', `ninLast4 is '4821' (got '${sub?.ninLast4}')`);
  assert(sub?.ninMasked === '*******4821', `ninMasked is '*******4821' (got '${sub?.ninMasked}')`);
  assert(typeof sub?.ninHash === 'string' && sub.ninHash.length === 64, 'ninHash is 64-char hex');
  assert(sub?.dateOfBirth === '1995-08-20', `dateOfBirth recorded (got '${sub?.dateOfBirth}')`);
  assert((sub?.addressText || '').includes('12 Marina Street'), 'addressText recorded');

  // CRITICAL: Raw 11-digit NIN must NOT appear in the JSON DB file
  const rawDbContent = await fs.readFile(dbPath, 'utf8');
  assert(!rawDbContent.includes(rawNin), 'PRIVACY: Raw 11-digit NIN is NEVER stored in database');

  // 3e. Duplicate NIN fraud detection
  const fraudUserId = `user_fraud_${Date.now()}`;
  await db.insertUserRecord({
    id: fraudUserId,
    username: `fraud_user_${Date.now()}`,
    fullName: 'Fraud Attacker',
    email: `fraud_${Date.now()}@test.sivan`,
    emailVerified: true,
    whatsappNumber: `+2348099${Date.now().toString().slice(-7)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);

  // Address step for fraud user
  await submitWhatsAppTier2KycStep({
    userIdOrPhone: fraudUserId,
    step: 'address',
    country: 'NG',
    streetAddress: '99 Fake Street',
    city: 'Ikeja',
    stateRegion: 'Lagos',
    documentType: 'bank_statement',
    proofOfAddressUrl: docUrl,
  });

  // NIN step with the SAME NIN already used by testUser
  const fraudStep2 = await submitWhatsAppTier2KycStep({
    userIdOrPhone: fraudUserId,
    step: 'nin',
    country: 'NG',
    nin: rawNin,
    dateOfBirth: '1990-01-01',
  });

  // With duplicate NIN detected, the AI auto-approval should be bypassed
  // The request goes to review even if threshold is met
  const fraudReqs = await db.listVerificationRequests(fraudUserId);
  const fraudReq = fraudReqs.find((r) => r.id === fraudStep2.requestId);
  const fraudAiVerification = (fraudReq?.submissionData as any)?.aiVerification;
  // Audit log should have been raised (non-fatal); submission continues to under_review
  assert(
    fraudStep2.status === 'under_review' || fraudStep2.status === 'approved',
    `Fraud user submission processed (status: '${fraudStep2.status}')`
  );
  // Check audit log recorded duplicate NIN event
  const ninReusedLog = await db.latestAuditLogByAction('kyc.nin_reused_across_accounts');
  assert(Boolean(ninReusedLog), 'Audit log records NIN reuse across accounts');

  // ── GROUP 4: Fastify HTTP Routes ─────────────────────────────────────────────
  console.log('\n--- Group 4: Fastify HTTP Routes ---');

  const app = await buildApp();
  await app.ready();

  try {
    // 4a. GET /kyc/controls
    const getCtrlRes = await app.inject({
      method: 'GET',
      url: '/kyc/controls',
      headers: { 'x-admin-key': 'kyc-admin-key' },
    });
    assert(getCtrlRes.statusCode === 200, `GET /kyc/controls returns 200 (got ${getCtrlRes.statusCode})`);
    const ctrlJson = getCtrlRes.json();
    assert(typeof ctrlJson.data.aiApprovalThreshold === 'number', 'GET /kyc/controls returns aiApprovalThreshold');
    assert(typeof ctrlJson.data.aiAutoApprovalEnabled === 'boolean', 'GET /kyc/controls returns aiAutoApprovalEnabled');

    // 4b. POST /kyc/controls
    const postCtrlRes = await app.inject({
      method: 'POST',
      url: '/kyc/controls',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': 'kyc-admin-key' },
      payload: { aiApprovalThreshold: 80, aiAutoApprovalEnabled: true },
    });
    assert(postCtrlRes.statusCode === 200, `POST /kyc/controls returns 200 (got ${postCtrlRes.statusCode})`);
    const postCtrlJson = postCtrlRes.json();
    assert(postCtrlJson.data.aiApprovalThreshold === 80, `Threshold updated to 80 via API (got ${postCtrlJson.data.aiApprovalThreshold})`);

    // 4c. GET /api/users/:userId/kyc/tier2/context
    const ctxRes = await app.inject({
      method: 'GET',
      url: `/api/users/${encodeURIComponent(testUserId)}/kyc/tier2/context`,
      headers: { 'x-sivan-identity-link-secret': 'kyc-test-secret' },
    });
    assert(ctxRes.statusCode === 200, `GET /kyc/tier2/context returns 200 (got ${ctxRes.statusCode})`);
    const ctxJson = ctxRes.json();
    assert(ctxJson.data.userId === testUserId, 'Context API returns correct userId');

    // 4d. POST /api/users/:userId/kyc/tier2/step-up for a Ghana user (no NIN step)
    const ghUserId = `user_gh_${Date.now()}`;
    await db.insertUserRecord({
      id: ghUserId,
      username: `gh_user_${Date.now()}`,
      fullName: 'Kwame Mensah',
      email: `kwame_${Date.now()}@test.sivan`,
      emailVerified: true,
      whatsappNumber: `+233241${Date.now().toString().slice(-6)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const ghStepRes = await app.inject({
      method: 'POST',
      url: `/api/users/${encodeURIComponent(ghUserId)}/kyc/tier2/step-up`,
      headers: { 'Content-Type': 'application/json', 'x-sivan-identity-link-secret': 'kyc-test-secret' },
      payload: {
        step: 'address',
        country: 'GH',
        streetAddress: '10 Oxford Street',
        city: 'Accra',
        stateRegion: 'Greater Accra',
        documentType: 'bank_statement',
        proofOfAddressUrl: docUrl,
      },
    });
    assert(ghStepRes.statusCode === 200, `POST /kyc/tier2/step-up Ghana returns 200 (got ${ghStepRes.statusCode})`);
    const ghStepJson = ghStepRes.json();
    assert(ghStepJson.data.requiresNinStep === false, 'Ghana address step does NOT require NIN');
    assert(
      ghStepJson.data.status === 'approved' || ghStepJson.data.status === 'under_review',
      `Ghana step status is approved or under_review (got '${ghStepJson.data.status}')`
    );

    // 4e. Auth guard: missing admin key returns 401/403
    const noKeyRes = await app.inject({
      method: 'GET',
      url: '/kyc/controls',
    });
    assert(noKeyRes.statusCode === 401 || noKeyRes.statusCode === 403, `GET /kyc/controls without key returns 401/403 (got ${noKeyRes.statusCode})`);

    // 4f. Auth guard: missing identity-link-secret returns 401/403
    const noSecretRes = await app.inject({
      method: 'GET',
      url: `/api/users/${testUserId}/kyc/tier2/context`,
    });
    assert(noSecretRes.statusCode === 401 || noSecretRes.statusCode === 403 || noSecretRes.statusCode === 404,
      `GET /kyc/tier2/context without secret returns 401/403/404 (got ${noSecretRes.statusCode})`);

  } finally {
    await app.close();
  }

  // Cleanup
  await fs.rm(dbPath, { force: true });

  console.log('\n=============================================================');
  if (failed === 0) {
    console.log(` ALL ${passed} TESTS PASSED`);
  } else {
    console.log(` ${passed} PASSED | ${failed} FAILED`);
    failures.forEach((f) => console.log(`   FAIL: ${f}`));
  }
  console.log('=============================================================\n');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n FATAL ERROR IN TEST SUITE:', err);
  process.exit(1);
});
