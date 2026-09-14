import { Resend } from 'resend';
import { env } from '../config/env.js';
import type { VirtualAccountRecord } from '../virtual-accounts/types/virtual-account.types.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
      html: input.html
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
  const text = `${title}\n\nYour verification code is ${input.code}. It expires in ${input.expiresInMinutes} minutes.\n\nIf you did not request this, you can ignore this email.`;
  const html = `
    <div style="font-family: Inter, Arial, sans-serif; background:#07090d; color:#eef3f7; padding:32px;">
      <div style="max-width:560px; margin:0 auto; background:#0e141b; border:1px solid rgba(154,179,202,.18); border-radius:16px; padding:28px;">
        <p style="color:#74ddbe; text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:800; margin:0 0 12px;">Sivan Payments</p>
        <h1 style="margin:0 0 12px; font-size:28px; line-height:1.1;">${title}</h1>
        <p style="color:#a9b8c7; line-height:1.6;">Use this code to ${input.intent === 'signup' ? 'verify your account' : 'sign in'}.</p>
        <div style="font-size:34px; letter-spacing:.24em; font-weight:900; color:#74ddbe; background:rgba(116,221,190,.08); border:1px solid rgba(116,221,190,.28); border-radius:12px; padding:18px 20px; text-align:center; margin:24px 0;">${input.code}</div>
        <p style="color:#a9b8c7;">This code expires in ${input.expiresInMinutes} minutes.</p>
        <p style="color:#71809c; font-size:13px; line-height:1.6;">If you did not request this, you can safely ignore this email.</p>
      </div>
    </div>`;
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
