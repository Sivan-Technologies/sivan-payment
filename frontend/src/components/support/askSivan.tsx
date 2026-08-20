import { useEffect, useRef, useState } from 'react';

/**
 * ONE ASK SIVAN, TWO PRESENTATIONS.
 *
 * The Support drawer already owned all of this: a message thread, quick chips,
 * the 5-per-chat and 10-per-day limits, the typing narration, the safety
 * footer and the ticket handoff. Putting a second, simpler chat in the
 * Transactions panel would have meant two implementations of the same rules -
 * and the copy would have been the half that quietly lacked the rate-limit
 * guard, so a user could exceed a cap that the other surface enforced.
 *
 * So the CONVERSATION is a hook and the BUBBLES are a component, both used by
 * the full drawer and by the compact inline thread. Behaviour is shared;
 * layout is not.
 *
 * Deliberately NOT a floating chat bubble over the transaction panel. The
 * question is nearly always about the timeline the user is looking at, and
 * covering the evidence to ask about the evidence is backwards. The inline
 * thread grows in place, under the steps it refers to.
 */

export type ChatRole = 'assistant' | 'user' | 'system';

export type AssistantChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: string;
  meta?: AssistantAnswer;
};

export type AssistantAnswer = {
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  needsHuman: boolean;
  evidenceChecked?: string[];
  suggestedActions?: Array<{ label: string; actionType: string; priority: string; reason: string }>;
  sessionId?: string;
};

/**
 * Mirrors AceResourceType on the server, including the three kinds that only
 * became answerable alongside this work. Kept as a literal union rather than
 * `string` so a typo in a caller is a compile error, not a runtime "I could
 * not find that reference".
 */
export type AssistantResourceType =
  | 'withdrawal'
  | 'onramp_order'
  | 'ngn_transfer'
  | 'virtual_account_transaction'
  | 'balance_transfer'
  | 'supplier_payment'
  | 'wallet_deposit'
  | 'transaction_lookup'
  | 'general';

export type AssistantContext = {
  resourceType: AssistantResourceType;
  resourceId?: string;
  ticketType: 'withdrawal' | 'onramp_payment' | 'deposit_not_detected' | 'account_access' | 'verification' | 'other';
  subject: string;
};

export const ASSISTANT_INTRO =
  'Hi, I’m Sivan Assistant. I can help with payments, verification, transfers, virtual accounts, and account recovery. I can’t move funds or change your account, but I can explain what’s happening and help create a support ticket if needed.';

export const MAX_SESSION_MESSAGES = 5;
export const MAX_DAILY_MESSAGES = 10;

export function chatId() {
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function todayKey(userId?: string) {
  return `sivan.askSivan.daily.${userId || 'guest'}.${new Date().toISOString().slice(0, 10)}`;
}

export function readDailyCount(userId?: string) {
  try {
    return Number(localStorage.getItem(todayKey(userId)) || 0);
  } catch {
    return 0;
  }
}

export function writeDailyCount(userId: string | undefined, count: number) {
  try {
    localStorage.setItem(todayKey(userId), String(count));
  } catch {
    // Deliberately swallowed. setItem throws in Safari private browsing and on
    // a full origin quota, and this is a rate-limit counter - losing it means
    // "the user may ask one more question than intended", which is not worth
    // breaking the screen over. A commented block rather than `catch {}` so the
    // intent is visible instead of reading as an unfinished edit.
  }
}

export function transcript(messages: AssistantChatMessage[]) {
  return messages
    .map((msg) => `${msg.role === 'assistant' ? 'Sivan Assistant' : msg.role === 'system' ? 'System' : 'Customer'}: ${msg.text}`)
    .join('\n\n');
}

/**
 * What the typing bubble says, by how long the user has waited.
 *
 * One fixed string is honest at 1s and misleading at 8s - the user cannot tell
 * a slow answer from a dead one, and the usual response is to press send again.
 * Each line describes something really happening, in order, and none of them
 * invents a progress percentage.
 */
const waitStages = [
  { afterMs: 0, text: 'Checking safe account evidence...' },
  { afterMs: 2500, text: 'Reviewing your account history...' },
  { afterMs: 5000, text: 'Composing an answer from what I found...' },
  { afterMs: 7500, text: 'Still working. If this takes much longer, I will answer from Sivan\u2019s guides instead.' },
];

export function useAssistantWaitStage(busy: boolean) {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(interval);
  }, [busy]);
  return waitStages.filter((stage) => elapsedMs >= stage.afterMs).slice(-1)[0]?.text ?? waitStages[0].text;
}

export interface UseAskSivanOptions {
  userId?: string;
  hasUser: boolean;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  /** Seeds the thread. Omit for a thread that should start empty. */
  intro?: string;
}

/**
 * The conversation itself: state, limits, sending, and the error copy.
 *
 * Returns primitives rather than JSX so the two surfaces can lay them out
 * however they like while sharing every rule that governs money-adjacent
 * support.
 */
export function useAskSivan({ userId, hasUser, api, intro }: UseAskSivanOptions) {
  const [messages, setMessages] = useState<AssistantChatMessage[]>(
    intro ? [{ id: chatId(), role: 'assistant', text: intro, createdAt: new Date().toISOString() }] : []
  );
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sessionUsed, setSessionUsed] = useState(0);
  const [lastAnswer, setLastAnswer] = useState<AssistantAnswer | null>(null);
  const [dailyUsed, setDailyUsed] = useState(() => readDailyCount(userId));

  /**
   * Whether this surface has already woken Sivan AI. A ref because nothing
   * renders from it and flipping it must not cause a re-render.
   */
  const warmedRef = useRef(false);

  const addSystemMessage = (text: string) =>
    setMessages((items) => [...items, { id: chatId(), role: 'system', text, createdAt: new Date().toISOString() }]);

  /**
   * Wake Sivan AI while the user is still reading or choosing a chip.
   *
   * The service sleeps after 15 minutes idle and takes ~23s to cold start,
   * far longer than the answer request will wait. Firing on OPEN moves that
   * wait into the seconds before a question exists.
   *
   * Fire-and-forget: warming is an optimisation and a user who never gets a
   * warm instance still gets the local answer, so failure must be silent -
   * surfacing "warmup failed" would alarm someone about a background detail
   * that costs them nothing. The ref is released on failure so a later attempt
   * can retry.
   */
  async function prewarm() {
    if (!hasUser || warmedRef.current) return;
    warmedRef.current = true;
    try {
      await api('/api/ace/warmup', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      warmedRef.current = false;
    }
  }

  async function send(rawMessage: string, context: AssistantContext) {
    const message = rawMessage.trim();
    if (!message) return;
    if (!hasUser || !userId) {
      setError('Sign in or create an account before using Sivan Assistant.');
      return;
    }
    if (sessionUsed >= MAX_SESSION_MESSAGES) {
      addSystemMessage(`You have reached the ${MAX_SESSION_MESSAGES}-message assistant limit for this chat. Create a support ticket and the team will follow up.`);
      return;
    }
    const today = readDailyCount(userId);
    if (today >= MAX_DAILY_MESSAGES) {
      addSystemMessage('You have reached today’s Ask Sivan limit. Create a support ticket and Sivan Support will follow up.');
      return;
    }

    setMessages((items) => [...items, { id: chatId(), role: 'user', text: message, createdAt: new Date().toISOString() }]);
    setDraft('');
    setBusy(true);
    setError('');
    try {
      const result = await api<AssistantAnswer>(`/api/users/${userId}/ace/support`, {
        method: 'POST',
        body: JSON.stringify({
          message,
          resourceType: context.resourceType,
          resourceId: context.resourceId,
          channel: 'web_dashboard',
        }),
      });
      setLastAnswer(result);
      setSessionUsed((value) => value + 1);
      writeDailyCount(userId, today + 1);
      setDailyUsed(today + 1);
      setMessages((items) => [...items, { id: chatId(), role: 'assistant', text: result.answer, createdAt: new Date().toISOString(), meta: result }]);
      if (result.needsHuman || result.confidence === 'low') {
        addSystemMessage('I should get Sivan Support to review this. You can create a support ticket with this chat attached.');
      }
    } catch (err) {
      /**
       * A TIMEOUT IS NOT AN ERROR THE USER CAN ACT ON.
       *
       * The raw text is "signal is aborted without reason", which reads as a
       * crash. Rewritten to the one thing that actually helps - open a ticket -
       * and shown as a system message in the thread rather than a red banner,
       * because the conversation is still usable.
       */
      const raw = err instanceof Error ? err.message : 'Sivan Assistant could not respond right now.';
      const friendly = /signal is aborted|aborted without reason|timed out|taking longer/i.test(raw)
        ? 'Sivan Assistant is taking longer than expected. No problem: create a support ticket and Sivan Support will review this.'
        : raw;
      addSystemMessage(friendly);
    } finally {
      setBusy(false);
    }
  }

  const atSessionLimit = sessionUsed >= MAX_SESSION_MESSAGES;
  const atDailyLimit = dailyUsed >= MAX_DAILY_MESSAGES;

  return {
    messages,
    setMessages,
    draft,
    setDraft,
    busy,
    error,
    setError,
    sessionUsed,
    dailyUsed,
    lastAnswer,
    send,
    prewarm,
    addSystemMessage,
    atSessionLimit,
    atDailyLimit,
    /** True when no further question can be asked from this surface. */
    exhausted: atSessionLimit || atDailyLimit,
  };
}

/** The bubbles. Identical markup in the drawer and inline, so they cannot drift. */
export function AssistantThread({ messages, busy }: { messages: AssistantChatMessage[]; busy: boolean }) {
  const waitStage = useAssistantWaitStage(busy);
  const endRef = useRef<HTMLDivElement | null>(null);

  /**
   * Keep the newest message in view.
   *
   * Without this the inline thread grows downward inside a scrollable panel
   * and the answer the user just asked for renders below the fold - it looks
   * like nothing happened. `block: 'nearest'` so the page itself does not jump
   * when the thread is already visible.
   */
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length, busy]);

  return (
    <div className="ask-sivan-thread">
      {messages.map((message) => (
        <div className={`ask-sivan-message ${message.role}`} key={message.id}>
          <strong>{message.role === 'assistant' ? 'Sivan Assistant' : message.role === 'system' ? 'System' : 'You'}</strong>
          <p>{message.text}</p>
          {message.meta?.confidence && (
            <small>
              Confidence: {message.meta.confidence} · {message.meta.needsHuman ? 'Support review recommended' : 'No human review needed'}
            </small>
          )}
        </div>
      ))}
      {busy && (
        <div className="ask-sivan-message assistant typing" aria-live="polite">
          <strong>Sivan Assistant</strong>
          <p>{waitStage}</p>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

/**
 * FOLLOW-UPS THAT MATCH THE TRANSACTION IN FRONT OF THE USER.
 *
 * A free-text box on a phone, for a question the user has not formed yet, is a
 * blank page problem - and every wasted question costs one of ten daily
 * allowances. Chips are one tap, and because they are chosen from the
 * transaction's own kind and state, they are questions the evidence can
 * actually answer.
 *
 * Deliberately at most three. A wall of chips is a menu, and a menu is work.
 */
export function followUpsFor(kind: string, state: 'pending' | 'success' | 'failed' | string): string[] {
  const isPayout = kind === 'withdrawal' || kind === 'ngn_transfer' || kind === 'supplier_payment';
  const isDeposit = kind === 'wallet_deposit' || kind === 'virtual_account_deposit' || kind === 'virtual_account_transaction';

  if (state === 'failed') {
    return ['Why did this fail?', 'Will I be refunded?', 'What should I do now?'];
  }

  if (state === 'pending') {
    if (isPayout) return ['How long does this take?', 'Which account is it going to?', 'Can I cancel it?'];
    if (isDeposit) return ['Why is it not showing yet?', 'How long does confirmation take?'];
    if (kind === 'onramp_order') return ['Has my payment arrived?', 'How long does this take?', 'Can I cancel it?'];
    return ['How long does this take?', 'What happens next?'];
  }

  /**
   * A COMPLETED TRANSACTION USUALLY NEEDS NO EXPLANATION.
   *
   * Only offer what a finished row genuinely raises: where the money landed,
   * and what it cost. Padding this with "what happens next" on something that
   * has already happened is noise that costs a real API call.
   */
  if (isPayout) return ['Which account was this paid into?', 'What fee was charged?'];
  if (isDeposit) return ['Is this in my spendable balance?'];
  return ['What fee was charged?'];
}
