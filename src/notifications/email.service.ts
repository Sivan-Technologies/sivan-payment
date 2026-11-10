import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resend } from 'resend';
import { env } from '../config/env.js';
import type { VirtualAccountRecord } from '../virtual-accounts/types/virtual-account.types.js';

let cachedLogoBuffer: Buffer | null = null;
export function getSivanLogoBuffer(): Buffer | null {
  if (cachedLogoBuffer) return cachedLogoBuffer;
  const candidates = [
    path.resolve(process.cwd(), 'asset/sivan-logo.png'),
    path.resolve(process.cwd(), '../asset/sivan logo.png'),
    path.resolve(process.cwd(), '../asset/sivan_logo.png'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../asset/sivan-logo.png'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../asset/sivan logo.png'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../asset/sivan_logo.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedLogoBuffer = fs.readFileSync(candidate);
        return cachedLogoBuffer;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename?: string | false;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
    contentId?: string;
  }>;
}

export async function sendEmail(input: SendEmailInput) {
  if (env.EMAIL_PROVIDER === 'console') {
    console.info('[email:console]', {
      to: input.to,
      from: env.EMAIL_FROM,
      subject: input.subject,
      text: input.text
    });
    return { provider: 'console', id: `console_${Date.now()}` };
  }

  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
    }

    const resend = new Resend(env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    });

    if (error) {
      throw new Error(`Resend email failed: ${error.message}`);
    }

    return { provider: 'resend', id: data?.id, raw: data };
  }

  throw new Error(`Unsupported EMAIL_PROVIDER: ${env.EMAIL_PROVIDER}`);
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function appUrl(path = '/') {
  try {
    const url = new URL(env.CUSTOMER_APP_URL || 'https://app.sivantech.online');
    url.pathname = path;
    return url.toString();
  } catch {
    return `https://app.sivantech.online${path}`;
  }
}

function brandShell(input: {
  eyebrow: string;
  title: string;
  intro: string;
  badge?: string;
  rows?: Array<{ label: string; value?: string | number | null }>;
  ctaLabel?: string;
  ctaUrl?: string;
  note?: string;
}) {
  const rows = (input.rows ?? [])
    .filter((row) => row.value !== undefined && row.value !== null && String(row.value).trim() !== '')
    .map((row) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #EEF3F8;color:#8B96A7;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(row.label)}</td>
        <td style="padding:12px 0;border-bottom:1px solid #EEF3F8;color:#10182B;font-size:14px;font-weight:800;text-align:right;">${escapeHtml(row.value)}</td>
      </tr>
    `).join('');
  const ctaUrl = input.ctaUrl?.startsWith('http') ? input.ctaUrl : input.ctaUrl ? appUrl(input.ctaUrl) : undefined;
  const cta = ctaUrl && input.ctaLabel
    ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#018EE8;color:#FFFFFF;text-decoration:none;font-weight:900;border-radius:10px;padding:13px 18px;box-shadow:0 6px 18px rgba(1,142,232,.28);">${escapeHtml(input.ctaLabel)}</a>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;background:#F7FAFD;padding:28px 14px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#10182B;">
    <div style="max-width:620px;margin:0 auto;">
      <div style="background:#FFFFFF;border:1px solid #E6EDF5;border-radius:18px;box-shadow:0 24px 60px rgba(16,24,43,.08);overflow:hidden;">
        <div style="background:linear-gradient(135deg,#E9F4FD,#E6FBF6);padding:24px 24px 18px;border-bottom:1px solid #E6EDF5;">
          <div style="color:#018EE8;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.11em;margin-bottom:10px;">${escapeHtml(input.eyebrow)}</div>
          <h1 style="margin:0;color:#10182B;font-size:28px;line-height:1.12;letter-spacing:-.04em;">${escapeHtml(input.title)}</h1>
          <p style="margin:12px 0 0;color:#5A6678;font-size:15px;line-height:1.65;">${escapeHtml(input.intro)}</p>
          ${input.badge ? `<div style="margin-top:16px;display:inline-block;background:#FFFFFF;color:#007BD1;border:1px solid #CFE6F9;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:900;">${escapeHtml(input.badge)}</div>` : ''}
        </div>
        <div style="padding:22px 24px 24px;">
          ${rows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:22px;">${rows}</table>` : ''}
          ${cta ? `<div style="margin:4px 0 20px;">${cta}</div>` : ''}
          ${input.note ? `<div style="background:#F7FAFD;border:1px solid #E6EDF5;border-radius:14px;padding:14px;color:#5A6678;font-size:13px;line-height:1.6;">${escapeHtml(input.note)}</div>` : ''}
        </div>
      </div>
      <p style="margin:18px 4px 0;color:#8B96A7;font-size:12px;line-height:1.6;">You are receiving this because this activity happened on your Sivan account. Sivan will never ask for your password, OTP, or wallet seed phrase by email.</p>
    </div>
  </body>
</html>`;
}

export function buildSivanBrandedEmail(input: Parameters<typeof brandShell>[0]) {
  return brandShell(input);
}

export function buildOtpEmail(input: { code: string; expiresInMinutes: number; intent: 'signup' | 'signin' }) {
  const title = input.intent === 'signup' ? 'Verify your Sivan account' : 'Sign in to Sivan';
  const text = `${title}\n\nYour Sivan verification code is ${input.code}. It expires in ${input.expiresInMinutes} minutes.\n\nSivan staff will never ask for your code, PIN, or wallet seed phrase.\nIf you did not request this, you can safely ignore this email.`;

  const logoSrc = 'https://payment.sivantech.online/sivan-logo.png';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark only">
  <meta name="supported-color-schemes" content="dark only">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#06090e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#e2e8f0;">
  
  <!-- Hidden Preheader for Inbox Preview -->
  <div style="display:none;font-size:1px;color:#06090e;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    Your Sivan verification code is ${escapeHtml(input.code)} (valid for ${input.expiresInMinutes} minutes).
  </div>

  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#06090e;padding:40px 16px;">
    <tr>
      <td align="center">
        
        <!-- Header / Logo -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:540px;margin-bottom:24px;">
          <tr>
            <td align="center">
              <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="display:inline-table;">
                <tr>
                  <td style="vertical-align:middle;padding-right:10px;">
                    <img src="${logoSrc}" alt="Sivan" width="34" height="34" style="display:block;border-radius:8px;border:0;" />
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.2px;">Sivan</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Main Card -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:540px;background-color:#0d141f;border:1px solid rgba(16,185,129,0.22);border-radius:18px;overflow:hidden;box-shadow:0 20px 40px rgba(0,0,0,0.5);">
          <tr>
            <td style="padding:36px 28px;text-align:center;">
              
              <!-- Badge -->
              <div style="display:inline-block;background-color:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);border-radius:100px;padding:4px 12px;margin-bottom:20px;">
                <span style="font-size:11px;font-weight:700;color:#34d399;letter-spacing:1px;text-transform:uppercase;">
                  ONE-TIME PASSCODE
                </span>
              </div>

              <!-- Heading -->
              <h1 style="margin:0 0 10px 0;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.4px;">
                ${escapeHtml(title)}
              </h1>
              
              <!-- Subtitle -->
              <p style="margin:0 0 24px 0;font-size:14px;line-height:1.55;color:#94a3b8;">
                Enter this verification code to ${input.intent === 'signup' ? 'verify your account' : 'complete your sign-in'}:
              </p>

              <!-- Single Continuous Copyable Container (1-Tap Selection) -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#06090e;border:1px solid rgba(16,185,129,0.35);border-radius:12px;margin-bottom:20px;">
                <tr>
                  <td style="padding:20px 16px;text-align:center;">
                    <div style="font-size:11px;font-weight:600;color:#64748b;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">
                      Verification Code
                    </div>
                    <!-- SINGLE STRING: 1-TAP COPY ON MOBILE -->
                    <div style="font-family:'JetBrains Mono','SF Mono',Consolas,Menlo,monospace;font-size:38px;font-weight:700;color:#10b981;letter-spacing:10px;text-indent:10px;user-select:all;-webkit-user-select:all;">
                      ${escapeHtml(input.code)}
                    </div>
                    <div style="font-size:11px;color:#64748b;margin-top:8px;">
                      Tap code to copy
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Expiry Meta -->
              <p style="margin:0 0 24px 0;font-size:12px;color:#64748b;">
                ⏱ Valid for ${input.expiresInMinutes} minutes
              </p>

              <!-- Security Notice -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#080d15;border:1px solid rgba(255,255,255,0.05);border-radius:10px;">
                <tr>
                  <td style="padding:14px 16px;text-align:left;font-size:12px;line-height:1.5;color:#94a3b8;">
                    <strong style="color:#cbd5e1;">Security Notice:</strong> Never share this code with anyone. Sivan staff will never ask for your code or PIN. If you didn't request this, you can safely ignore this email.
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>

        <!-- Protocol Footer -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:540px;margin-top:24px;text-align:center;">
          <tr>
            <td>
              <p style="margin:0 0 8px 0;font-size:12px;color:#64748b;">
                &copy; 2026 Sivan Technology. All rights reserved.
              </p>
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Need help? Contact <a href="mailto:support@sivantech.online" style="color:#10b981;text-decoration:none;">support@sivantech.online</a>
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;

  return { subject: title, text, html };
}

export function buildVirtualAccountAssignedEmail(account: VirtualAccountRecord) {
  const currency = account.currency.toUpperCase();
  const subject = `${currency} virtual account ready`;
  const detail = account.ibanMasked || account.accountNumberMasked || 'Ready in your Sivan app';
  const text =
    `Your ${currency} virtual account is ready.\n\n` +
    `Bank: ${account.bankName || 'Partner bank'}\n` +
    `Account name: ${account.accountName || 'Sivan account'}\n` +
    `Account: ${detail}\n\n` +
    `Open Sivan to view and copy the full account details: ${appUrl('/virtual-account')}\n\n` +
    `Sivan`;
  const html = brandShell({
    eyebrow: 'Virtual account ready',
    title: `Your ${currency} account is ready`,
    intro: 'Your receiving account has been assigned. Open Sivan to view, copy, and share the full bank details safely.',
    badge: `${currency} account assigned`,
    rows: [
      { label: 'Bank', value: account.bankName || 'Partner bank' },
      { label: 'Account name', value: account.accountName || 'Sivan account' },
      { label: account.ibanMasked ? 'IBAN' : 'Account', value: detail },
      { label: 'Status', value: account.status === 'active' ? 'Active' : account.status },
    ],
    ctaLabel: 'View account details',
    ctaUrl: appUrl('/virtual-account'),
    note: 'For your safety, this email only shows a short account summary. Copy the full details from your signed-in Sivan dashboard.'
  });
  return { subject, text, html };
}

export function buildP2pReceivedEmail(input: {
  recipientName: string;
  senderName: string;
  amount: number;
  asset: string;
  transferId: string;
}) {
  const amountStr = `${input.amount.toFixed(2)} ${input.asset.toUpperCase()}`;
  const subject = `You received ${amountStr} from ${input.senderName}`;
  const text =
    `Hi ${input.recipientName},\n\n` +
    `You have received an instant P2P transfer of ${amountStr} from ${input.senderName} on Sivan.\n\n` +
    `Transfer ID: ${input.transferId}\n` +
    `Status: Completed (Delivered Instantly)\n\n` +
    `The funds are immediately available in your Sivan spendable balance.\n\n` +
    `View your balance: ${appUrl('/dashboard')}\n\n` +
    `Sivan`;
  const html = brandShell({
    eyebrow: 'Instant P2P Transfer',
    title: `You received ${amountStr}`,
    intro: `${input.senderName} just sent ${amountStr} directly to your Sivan account balance.`,
    badge: 'Delivered Instantly',
    rows: [
      { label: 'Amount', value: amountStr },
      { label: 'Sender', value: input.senderName },
      { label: 'Transfer ID', value: input.transferId },
      { label: 'Status', value: 'Completed' },
    ],
    ctaLabel: 'View Your Balance',
    ctaUrl: appUrl('/dashboard'),
    note: 'These funds are credited to your Sivan spendable balance and can be transferred, sent on-chain, or withdrawn to a bank account anytime.'
  });
  return { subject, text, html };
}
