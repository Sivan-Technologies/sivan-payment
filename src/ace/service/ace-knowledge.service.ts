import { env } from '../../config/env.js';
import { id } from '../../shared/id.js';
import type { AceConfidence } from '../types/ace.types.js';

export interface KnowledgeArticleItem {
  id: string;
  title: string;
  category: string;
  answer: string;
  tags: string[];
  pinned?: boolean;
}

export interface KnowledgeAnswerResult {
  answer: string;
  title?: string;
  articleId?: string;
  category: string;
  confidence: AceConfidence;
  needsHuman: boolean;
  evidenceChecked: string[];
  matchedArticles: Array<{
    id: string;
    title: string;
    category: string;
    confidence: number;
  }>;
  suggestedActions: Array<{
    label: string;
    actionType: 'none' | 'open_ticket' | 'human_review';
    priority: 'low' | 'normal' | 'high' | 'urgent';
    reason: string;
  }>;
  sessionId: string;
  source: 'sivan_ai_remote' | 'sivan_knowledge_local';
}

const PROTOCOL_KNOWLEDGE_ARTICLES: KnowledgeArticleItem[] = [
  {
    id: 'onboarding.signin_methods',
    title: 'How do I sign in or create a Sivan Ai workspace account?',
    category: 'onboarding',
    answer:
      'You can sign in or create your Sivan Ai workspace in three ways:\n\n1. Instant Phone & Bot Login: Scan the dynamic QR code with your phone camera, or tap Continue with WhatsApp or Continue with Telegram for 1-tap authentication.\n2. Work Email OTP: Click "Or sign in with Work Email OTP" at the bottom of the login card to receive a 6-digit verification code in your email.\n3. Automatic Non-Custodial Wallet: When you create an account, your non-custodial multi-chain smart wallet is provisioned automatically via Privy HSM enclaves with no browser extension or seed phrase needed.',
    tags: [
      'sign in', 'signin', 'login', 'log in', 'create account', 'register', 'signup',
      'qr', 'qr code', 'expired', 'whatsapp', 'telegram', 'email', 'otp', 'onboarding', 'workspace', 'start'
    ],
    pinned: true,
  },
  {
    id: 'onboarding.qr_expired',
    title: 'What if the login QR code says expired or waiting for confirmation?',
    category: 'onboarding',
    answer:
      'For security, login QR challenges expire after 5 minutes. Simply click the "Refresh" button inside the QR box to generate a fresh challenge code, or switch directly to the WhatsApp, Telegram, or Work Email OTP login option below the QR code.',
    tags: ['qr code expired', 'expired', 'refresh', 'waiting for confirmation', 'scan', 'camera', 'qr'],
    pinned: true,
  },
  {
    id: 'agreements.milestone_flow',
    title: 'How do Sivan Service Agreements protect my funds?',
    category: 'service_agreements',
    answer:
      'Sivan Service Agreements protect both clients and freelancers by locking funds in verifiable smart custody before work begins:\n\n1. Create Agreement: Define the counterparty, project scope, amount (USDC or NGN), and delivery deadline.\n2. Fund Custody: The buyer funds the agreement from their spendable balance, virtual account, or crypto deposit.\n3. Deliver & Approve: Once the freelancer submits proof of delivery, the buyer verifies the work and releases payment instantly using their 4-digit security PIN.\n4. Dispute Protection: If delivery is not fulfilled as agreed, funds remain safely locked in custody until resolved.',
    tags: [
      'service agreement', 'service agreements', 'agreement', 'agreements', 'milestone',
      'lock funds', 'release payment', 'dispute', 'buyer protection', 'seller protection', 'freelancer', 'client', 'pin', 'custody'
    ],
    pinned: true,
  },
  {
    id: 'networks.dynamic_supported',
    title: 'Which blockchain networks and stablecoins does Sivan Ai support?',
    category: 'networks',
    answer:
      'Sivan Ai supports multi-chain settlement across Arc (Circle Layer-1 EVM), Arbitrum One, Stellar, Celo, Base, and Solana. Supported digital assets include USDC, USDT, and USDm (Celo), which can be held in your non-custodial workspace wallet, locked in Service Agreements, or converted directly to local bank accounts.',
    tags: [
      'network', 'networks', 'chain', 'chains', 'blockchain', 'arc', 'arbitrum',
      'stellar', 'celo', 'base', 'solana', 'usdc', 'usdt', 'usdm', 'stablecoin', 'crypto', 'token'
    ],
    pinned: true,
  },
  {
    id: 'withdrawals.settlement_speed',
    title: 'How fast are local bank withdrawals on Sivan Ai?',
    category: 'withdrawals',
    answer:
      'Local bank withdrawals on Sivan Ai settle near-instantly, typically under 1 to 2 minutes via NIBSS / NIP instant clearing rails for Nigerian Naira (NGN) and local instant rails for Ghanaian Cedi (GHS). Internal Sivan ledger and smart account transfers settle sub-second (0.15s).',
    tags: [
      'how fast', 'how long', 'settlement time', 'bank withdrawal', 'withdraw',
      'payout speed', 'nibss', 'nip', 'minutes', 'off-ramp', 'offramp', 'bank account', 'payout'
    ],
    pinned: true,
  },
  {
    id: 'virtual_accounts.scope',
    title: 'How do Global & NGN Virtual Accounts work?',
    category: 'virtual_accounts',
    answer:
      'Sivan Ai provides dedicated bank virtual accounts so you can receive transfers like a local:\n\n• NGN Dedicated Virtual Account: Receive instant Naira bank transfers via Wema Bank / NIBSS straight into your spendable NGN balance.\n• Global Virtual Accounts (USD, EUR, GBP): Receive international client wires (ACH, Wire, SEPA, Faster Payments) with automatic stablecoin ledger settlement.',
    tags: [
      'virtual account', 'virtual accounts', 'dva', 'wema', 'bank transfer',
      'receive', 'deposit', 'usd', 'eur', 'gbp', 'ngn', 'naira', 'iban', 'ach', 'sepa'
    ],
    pinned: true,
  },
  {
    id: 'currencies.active_fiat',
    title: 'Which fiat currencies and corridors does Sivan Ai support?',
    category: 'currencies',
    answer:
      'Sivan Ai supports Nigerian Naira (NGN) and Ghanaian Cedi (GHS) for instant domestic bank transfers and mobile money payouts, alongside USD, EUR, and GBP virtual receiving accounts for international clients.',
    tags: ['currency', 'currencies', 'fiat', 'ngn', 'ghs', 'naira', 'cedi', 'usd', 'eur', 'gbp', 'country', 'countries', 'corridor'],
    pinned: true,
  },
  {
    id: 'kyc.required',
    title: 'Why and when is identity verification (KYC) required?',
    category: 'kyc',
    answer:
      'Identity verification is required before regulated fiat actions such as creating virtual bank accounts, high-tier withdrawals, and fiat on-ramp orders. Individual accounts verify rapidly using government ID / BVN / NIN, while Business accounts can upgrade to Tier 2 high-limit merchant settlement.',
    tags: ['kyc', 'verification', 'verify', 'identity', 'bvn', 'nin', 'tier', 'limit', 'limits', 'compliance', 'document'],
    pinned: true,
  },
  {
    id: 'security.account_recovery_2fa',
    title: 'What if I lost access to my 2FA authenticator, PIN, or email?',
    category: 'safety',
    answer:
      'For your security, Sivan Ai is strictly read-only and never resets 2FA, changes email addresses, or unlocks accounts automatically. If you lost your authenticator device or need an email recovery, use your configured security recovery questions or contact Sivan Support (support@sivantech.online) so our compliance team can verify your identity and initiate an audited recovery.',
    tags: [
      '2fa', 'two factor', 'authenticator', 'lost access', 'forgot', 'recovery',
      'email change', 'locked out', 'reset', 'pin', 'cant sign in', 'cannot sign in', 'help'
    ],
    pinned: true,
  },
  {
    id: 'community.what_is_sivan',
    title: 'What is Sivan Ai?',
    category: 'community',
    answer:
      'Sivan Ai is an autonomous Web3 and fiat settlement workspace built for the global digital workforce, freelancers, and businesses. It combines milestone-backed Service Agreements, multi-chain non-custodial wallets, Global & NGN Virtual Accounts, and near-instant local bank withdrawals in under 1 to 2 minutes.',
    tags: ['what is sivan', 'about sivan', 'who is sivan', 'sivan ai', 'sivan technology', 'overview', 'platform'],
    pinned: true,
  },
];

const STOP_WORDS = new Set([
  'the', 'is', 'a', 'an', 'my', 'of', 'to', 'in', 'on', 'for',
  'with', 'and', 'or', 'why', 'what', 'where', 'has', 'have',
  'do', 'does', 'can', 'i', 'me', 'it', 'how', 'are', 'you'
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export function searchLocalProtocolKnowledge(query: string, limit = 3): Array<KnowledgeArticleItem & { confidence: number }> {
  const qLower = query.trim().toLowerCase();
  const terms = tokenize(query);

  const scored = PROTOCOL_KNOWLEDGE_ARTICLES.map((article) => {
    let score = 0;
    const titleLower = article.title.toLowerCase();
    const answerLower = article.answer.toLowerCase();
    const tagsLower = article.tags.map((t) => t.toLowerCase());

    for (const tag of tagsLower) {
      if (qLower.includes(tag)) {
        score += tag.includes(' ') ? 12 : 6;
      }
    }

    for (const term of terms) {
      if (article.id.includes(term)) score += 4;
      if (titleLower.includes(term)) score += 5;
      if (tagsLower.some((tag) => tag.includes(term) || term.includes(tag))) score += 6;
      if (answerLower.includes(term)) score += 2;
    }

    if (/sign ?in|log ?in|create account|register|qr|whatsapp|telegram|otp/i.test(qLower) && article.id === 'onboarding.signin_methods') {
      score += 12;
    }
    if (/expired|refresh|waiting for confirmation/i.test(qLower) && article.id === 'onboarding.qr_expired') {
      score += 14;
    }
    if (/agreement|milestone|buyer|seller|freelancer|lock|release/i.test(qLower) && article.id === 'agreements.milestone_flow') {
      score += 12;
    }
    if (/network|chain|blockchain|arc|arbitrum|solana|celo|base|stellar|usdc|usdt/i.test(qLower) && article.id === 'networks.dynamic_supported') {
      score += 12;
    }
    if (/how fast|how long|minutes|speed|settlement|withdraw|bank payout|nibss/i.test(qLower) && article.id === 'withdrawals.settlement_speed') {
      score += 12;
    }
    if (/virtual account|dva|wema|receive|usd|eur|gbp/i.test(qLower) && article.id === 'virtual_accounts.scope') {
      score += 12;
    }
    if (/2fa|authenticator|locked|forgot|recover|lost access/i.test(qLower) && article.id === 'security.account_recovery_2fa') {
      score += 12;
    }
    if (/what is sivan|about sivan|who is sivan/i.test(qLower) && article.id === 'community.what_is_sivan') {
      score += 14;
    }

    if (article.pinned) score += 1;

    return { article, score };
  })
    .filter((item) => item.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const maxScore = scored[0]?.score ?? 1;
  return scored.map(({ article, score }) => ({
    ...article,
    confidence: Number(Math.max(0.45, Math.min(0.98, score / Math.max(maxScore, 10))).toFixed(2)),
  }));
}

export function listPublicKnowledgeArticles(): KnowledgeArticleItem[] {
  return PROTOCOL_KNOWLEDGE_ARTICLES;
}

/**
 * Queries the remote `sivan-ai` knowledge base service first (`/ai/query` and `/api/knowledge/search`),
 * and seamlessly blends or falls back to the local Sivan Ai protocol knowledge store so users on
 * `/signin` ("Need assistance?") and in-app ("Ask Sivan Ai") always get an immediate, accurate response.
 */
export async function querySivanKnowledgeBase(input: {
  question: string;
  context?: string;
}): Promise<KnowledgeAnswerResult> {
  const question = input.question.trim();
  const sessionId = id('ace_kb');
  const localMatches = searchLocalProtocolKnowledge(question, 3);

  // 1. Try querying live sivan-ai knowledge service if SIVAN_AI_API_URL is configured
  if (env.SIVAN_AI_API_URL) {
    const baseUrl = env.SIVAN_AI_API_URL.replace(/\/$/, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(env.SIVAN_AI_API_KEY ? { 'x-sivan-ai-key': env.SIVAN_AI_API_KEY } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(env.SIVAN_AI_TIMEOUT_MS || 6000, 6000));

    try {
      const searchUrl = `${baseUrl}/api/knowledge/search?q=${encodeURIComponent(question)}&limit=3&customerVisibleOnly=true`;
      const response = await fetch(searchUrl, {
        method: 'GET',
        signal: controller.signal,
        headers,
      });

      if (response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          matches?: Array<{
            id: string;
            title: string;
            category: string;
            answer: string;
            confidence: number;
          }>;
        };

        const remoteMatches = Array.isArray(data.matches) ? data.matches : [];
        const bestRemote = remoteMatches[0];
        const bestLocal = localMatches[0];

        // Prefer the higher-confidence match between remote Redis knowledge store and local onboarding articles
        if (bestRemote && (!bestLocal || bestRemote.confidence >= bestLocal.confidence)) {
          const needsHuman = bestRemote.category === 'safety' || /2fa|recover|locked/i.test(question);
          return {
            answer: bestRemote.answer,
            title: bestRemote.title,
            articleId: bestRemote.id,
            category: bestRemote.category,
            confidence: bestRemote.confidence >= 0.7 ? 'high' : 'medium',
            needsHuman,
            evidenceChecked: [`knowledge.${bestRemote.id}`, 'sivan_ai.knowledge_store'],
            matchedArticles: remoteMatches.map((m) => ({
              id: m.id,
              title: m.title,
              category: m.category,
              confidence: m.confidence,
            })),
            suggestedActions: needsHuman
              ? [{ label: 'Contact Sivan Support', actionType: 'open_ticket', priority: 'high', reason: 'Account security & recovery requires human verification.' }]
              : [],
            sessionId,
            source: 'sivan_ai_remote',
          };
        }
      }
    } catch {
      // Fall through to local Sivan Ai knowledge articles cleanly
    } finally {
      clearTimeout(timeout);
    }
  }

  // 2. Local Sivan Ai Knowledge Base match
  if (localMatches.length > 0) {
    const best = localMatches[0];
    const needsHuman = best.category === 'safety' || /2fa|recover|locked/i.test(question);
    return {
      answer: best.answer,
      title: best.title,
      articleId: best.id,
      category: best.category,
      confidence: best.confidence >= 0.7 ? 'high' : 'medium',
      needsHuman,
      evidenceChecked: localMatches.map((m) => `knowledge.${m.id}`),
      matchedArticles: localMatches.map((m) => ({
        id: m.id,
        title: m.title,
        category: m.category,
        confidence: m.confidence,
      })),
      suggestedActions: needsHuman
        ? [{ label: 'Contact Sivan Support', actionType: 'open_ticket', priority: 'high', reason: 'Account security & recovery requires human verification.' }]
        : [],
      sessionId,
      source: 'sivan_knowledge_local',
    };
  }

  // 3. Default helpful overview when the question is open-ended
  return {
    answer:
      'Sivan Ai is your global Web3 and fiat settlement workspace. I can answer questions about:\n\n• Signing in via Phone QR Scan, WhatsApp, Telegram, or Work Email OTP\n• Milestone-backed Service Agreements and 4-digit PIN fund releases\n• Multi-chain USDC/USDT deposits across Arc, Arbitrum One, Stellar, Celo, Base, and Solana\n• Dedicated NGN & Global Virtual Accounts and near-instant local bank withdrawals (under 1 to 2 minutes)\n\nAsk me about any of these topics and I will guide you step by step.',
    title: 'Sivan Ai Knowledge Overview',
    articleId: 'community.what_is_sivan',
    category: 'community',
    confidence: 'medium',
    needsHuman: false,
    evidenceChecked: ['knowledge.community.what_is_sivan'],
    matchedArticles: PROTOCOL_KNOWLEDGE_ARTICLES.slice(0, 4).map((a) => ({
      id: a.id,
      title: a.title,
      category: a.category,
      confidence: 0.85,
    })),
    suggestedActions: [],
    sessionId,
    source: 'sivan_knowledge_local',
  };
}
