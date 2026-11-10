import { buildOtpEmail, sendEmail } from '../src/notifications/email.service.js';

async function main() {
  const recipient = 'airspexta@gmail.com';
  const testCode = '839201';
  console.log(`Building OTP email for ${recipient} with code ${testCode}...`);

  const emailPayload = buildOtpEmail({
    code: testCode,
    expiresInMinutes: 10,
    intent: 'signin',
  });

  console.log('Sending email via Resend...');
  const res = await sendEmail({
    to: recipient,
    subject: emailPayload.subject,
    text: emailPayload.text,
    html: emailPayload.html,
  });

  console.log('Email sent successfully!', res);
}

main().catch((err) => {
  console.error('Failed to send email:', err);
  process.exit(1);
});
