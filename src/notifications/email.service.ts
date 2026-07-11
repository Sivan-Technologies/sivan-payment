import { env } from '../config/env.js';

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

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html
      })
    });

    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Resend email failed: ${data?.message || response.statusText}`);
    }

    return { provider: 'resend', id: data.id, raw: data };
  }

  throw new Error(`Unsupported EMAIL_PROVIDER: ${env.EMAIL_PROVIDER}`);
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
