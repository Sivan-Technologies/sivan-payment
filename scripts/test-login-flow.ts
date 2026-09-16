import { startEmailAuth, verifyEmailAuth } from '../src/auth/auth.service.js';

async function main() {
  console.log('Starting Email Auth for sivantech@gmail.com with signup intent...');
  const res = await startEmailAuth({
    email: 'sivantech@gmail.com',
    fullName: 'Sivan Tech',
    intent: 'signup',
    legalAcceptance: {
      accepted: true,
      termsVersion: '2026-03-01',
      privacyVersion: '2026-03-01',
      riskDisclosureVersion: '2026-03-01'
    }
  });
  console.log('AUTH CHALLENGE RESULT:', JSON.stringify(res, null, 2));

  if (res.devCode) {
    console.log('Verifying with devCode:', res.devCode);
    const session = await verifyEmailAuth({ email: 'sivantech@gmail.com', code: res.devCode });
    console.log('SESSION CREATED SUCCESSFULLY:', JSON.stringify(session, null, 2));
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
