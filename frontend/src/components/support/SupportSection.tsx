import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { CustomerRecord, ExternalAccountRecord, OnrampOrderRecord, SupportTicketRecord, UserRecord, WithdrawalRecord } from '../../types';

function statusClass(status?: string) { if (!status) return 'pending'; if (['completed','kyc_approved','verified','active','resolved'].includes(status)) return 'success'; if (['failed','cancelled','kyc_rejected'].includes(status)) return 'danger'; return 'pending'; }
function friendlyStatus(status?: string) { const map: Record<string,string> = { created:'Started', kyc_approved:'Verified', kyc_incomplete:'Action required', open:'Open', in_review:'In review', waiting_on_user:'Waiting on you', waiting_on_provider:'Waiting on provider', resolved:'Resolved', closed:'Closed', pending:'Pending', completed:'Completed', failed:'Failed', awaiting_payment:'Awaiting payment', payout_processing:'Sending to bank' }; return status ? map[status] || status.replaceAll('_',' ') : 'Not started'; }
function Badge({ children, status }: { children: string; status?: string }) { return <span className={`badge ${statusClass(status)}`}>{children}</span>; }
function Empty({ children }: { children: string }) { return <div className="empty-state">{children}</div>; }
function getForm(form: HTMLFormElement) { return Object.fromEntries(new FormData(form).entries()) as Record<string, string>; }
function shortRef(value?: string) { if (!value) return '—'; if (value.length <= 14) return value; return `${value.slice(0,8)}…${value.slice(-6)}`; }
function CustomSelect({ name, options, defaultValue }: { name: string; options: Array<{ value: string; label: string; helper?: string }>; defaultValue?: string }) { const [value,setValue]=useState(defaultValue || options[0]?.value || ''); const [open,setOpen]=useState(false); const selected=options.find(o=>o.value===value)||options[0]; return <div className="custom-select-wrap app-select-wrap"><input type="hidden" name={name} value={selected?.value || ''}/><button type="button" className={`custom-select-trigger ${open?'open':''}`} onClick={()=>setOpen(!open)}><span><strong>{selected?.label||'Select'}</strong>{selected?.helper&&<small>{selected.helper}</small>}</span><em>⌄</em></button>{open&&<div className="custom-select-menu app-select-menu">{options.map(o=><button type="button" className={o.value===value?'selected':''} key={o.value} onClick={()=>{setValue(o.value);setOpen(false);}}><span>{o.label}</span>{o.helper&&<small>{o.helper}</small>}</button>)}</div>}</div>; }
function Kv({ label, value }: { label: string; value?: string | number | null }) { return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>; }
function LegalResources({ compact = false }: { compact?: boolean }) { const links=[['Terms','https://www.sivantech.online/legal/terms'],['Privacy','https://www.sivantech.online/legal/privacy'],['Risk Disclosure','https://www.sivantech.online/legal/risk-disclosure'],['Data Retention','https://www.sivantech.online/legal/data-retention'],['AML/KYC Policy','https://www.sivantech.online/legal/aml-kyc'],['Supported Jurisdictions','https://www.sivantech.online/legal/supported-jurisdictions'],['Wrong Network Policy','https://www.sivantech.online/legal/wrong-network'],['Complaints Policy','https://www.sivantech.online/legal/complaints'],['Cookie Policy','https://www.sivantech.online/legal/cookies']]; return <article className={compact ? 'legal-resource-card compact' : 'legal-resource-card'}><h3>Legal resources</h3><p className="muted">Review Sivan’s user terms, privacy practices, risk disclosures, and data retention policy.</p><div>{links.map(([label,href])=><a key={label} href={href} target="_blank" rel="noreferrer">{label} ↗</a>)}</div></article>; }
function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) { return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }

type ChatRole = 'assistant' | 'user' | 'system';
type AssistantChatMessage = { id: string; role: ChatRole; text: string; createdAt: string; meta?: any };
type AssistantAnswer = { answer: string; confidence: 'high' | 'medium' | 'low'; needsHuman: boolean; evidenceChecked?: string[]; suggestedActions?: any[]; sessionId?: string };
type AssistantContext = { resourceType: 'withdrawal' | 'onramp_order' | 'ngn_transfer' | 'virtual_account_transaction' | 'transaction_lookup' | 'general'; resourceId?: string; ticketType: 'withdrawal' | 'onramp_payment' | 'deposit_not_detected' | 'account_access' | 'verification' | 'other'; subject: string };

const assistantIntro = 'Hi, I’m Sivan Assistant. I can help with payments, verification, transfers, virtual accounts, and account recovery. I can’t move funds or change your account, but I can explain what’s happening and help create a support ticket if needed.';
/**
 * What the typing bubble says, by how long the user has been waiting.
 *
 * A single fixed string ("Checking safe account evidence...") is honest at 1s
 * and misleading at 8s: the user cannot tell a slow answer from a dead one, and
 * the usual response is to press send again or give up. Sivan AI can
 * legitimately take several seconds, longer on a cold instance, so the wait has
 * to narrate itself.
 *
 * Each line describes something that is really happening, in order: evidence is
 * gathered locally first, then the model is consulted, and only past ~7s is a
 * fallback genuinely likely. No invented progress percentages.
 */
const assistantWaitStages = [
  { afterMs: 0, text: 'Checking safe account evidence...' },
  { afterMs: 2500, text: 'Reviewing your account history...' },
  { afterMs: 5000, text: 'Composing an answer from what I found...' },
  { afterMs: 7500, text: 'Still working. If this takes much longer, I will answer from Sivan\u2019s guides instead.' }
];

function useAssistantWaitStage(busy: boolean) {
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
  return assistantWaitStages.filter((stage) => elapsedMs >= stage.afterMs).slice(-1)[0]?.text ?? assistantWaitStages[0].text;
}

const maxSessionMessages = 5;
const maxDailyMessages = 10;
function chatId() { return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function todayKey(userId?: string) { return `sivan.askSivan.daily.${userId || 'guest'}.${new Date().toISOString().slice(0,10)}`; }
function readDailyCount(userId?: string) { try { return Number(localStorage.getItem(todayKey(userId)) || 0); } catch { return 0; } }
function writeDailyCount(userId: string | undefined, count: number) {
  try {
    localStorage.setItem(todayKey(userId), String(count));
  } catch {
    // Deliberately swallowed. localStorage.setItem throws in Safari private
    // browsing and when the origin quota is full, and this is a rate-limit
    // counter for support tickets - losing it degrades to "the user may open
    // one more ticket than intended", which is not worth breaking the screen
    // over. Written as a commented block rather than `catch {}` so the intent
    // is visible; a bare empty block reads as an unfinished edit.
  }
}
function transcript(messages: AssistantChatMessage[]) { return messages.map((msg) => `${msg.role === 'assistant' ? 'Sivan Assistant' : msg.role === 'system' ? 'System' : 'Customer'}: ${msg.text}`).join('\n\n'); }

export function SupportView({ hasUser, user, tickets, withdrawals, onrampOrders, accounts, customer, api, onCreateTicket, onTicketsChanged, loading }: { hasUser: boolean; user: UserRecord | null; tickets: SupportTicketRecord[]; withdrawals: WithdrawalRecord[]; onrampOrders: OnrampOrderRecord[]; accounts: ExternalAccountRecord[]; customer: CustomerRecord | null; api: <T>(path: string, options?: RequestInit) => Promise<T>; onCreateTicket: (event: FormEvent<HTMLFormElement>) => void; onTicketsChanged: (tickets: SupportTicketRecord[]) => void; loading: boolean }) {
  const [selectedTicket, setSelectedTicket] = useState<SupportTicketRecord | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<AssistantChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [chatContext, setChatContext] = useState<AssistantContext>({ resourceType: 'general', ticketType: 'other', subject: 'Sivan Assistant support handoff' });
  const [aiMessagesUsed, setAiMessagesUsed] = useState(0);
  const [lastAnswer, setLastAnswer] = useState<AssistantAnswer | null>(null);
  // Whether this session already woke Sivan AI. A ref rather than state because
  // nothing renders from it and flipping it must not cause a re-render.
  const warmedRef = useRef(false);
  const faqs = ['How long does a withdrawal take?', 'What fees does Sivan charge?', 'My payout is delayed. What should I do?', 'What happens if I send the wrong network?'];
  const latestWithdrawal = useMemo(() => withdrawals.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0], [withdrawals]);
  const latestOrder = useMemo(() => onrampOrders.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0], [onrampOrders]);

  function openAssistant() {
    setChatOpen(true);
    setChatError('');
    if (!chatMessages.length) setChatMessages([{ id: chatId(), role: 'assistant', text: assistantIntro, createdAt: new Date().toISOString() }]);
    void prewarmAssistant();
  }

  /**
   * Wake Sivan AI while the user reads the intro and types.
   *
   * Sivan AI sleeps after 15 minutes idle and takes ~23s to cold start, which is
   * far longer than the answer request will wait. Firing this on OPEN rather than
   * on send moves that wait into the seconds the user spends composing, so the
   * first question usually meets a warm service instead of a fallback answer.
   *
   * Fire-and-forget on purpose: warming is an optimisation, and a user who never
   * gets a warm instance still gets the local answer. Failure must therefore be
   * silent - surfacing "warmup failed" would alarm someone about a background
   * detail that costs them nothing.
   */
  async function prewarmAssistant() {
    if (!hasUser || warmedRef.current) return;
    warmedRef.current = true;
    try {
      await api('/api/ace/warmup', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      // Deliberately swallowed - see above. Allow a later retry.
      warmedRef.current = false;
    }
  }

  async function openTicket(ticket: SupportTicketRecord) {
    const detail = await api<SupportTicketRecord>(`/api/support/tickets/${ticket.id}`);
    setSelectedTicket(detail);
  }

  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTicket) return;
    const data = getForm(event.currentTarget);
    await api(`/api/support/tickets/${selectedTicket.id}/messages`, { method: 'POST', body: JSON.stringify({ message: data.message }) });
    const detail = await api<SupportTicketRecord>(`/api/support/tickets/${selectedTicket.id}`);
    setSelectedTicket(detail);
    onTicketsChanged(tickets.map((ticket) => ticket.id === detail.id ? { ...ticket, ...detail } : ticket));
    (event.currentTarget as HTMLFormElement).reset();
  }

  function resolveContext(message: string): AssistantContext {
    const lower = message.toLowerCase();
    /**
     * NO resourceId ON A VERIFICATION QUESTION.
     *
     * This used to send `resourceId: customer?.id` - a CUSTOMER id in the slot
     * the server reads as a TRANSACTION id. It was harmless only because the
     * server ignored the field and attached the newest transaction anyway.
     * Now that an unmatched id is reported honestly as "I could not find that
     * reference", sending a customer id here would produce a confusing refusal
     * on a question that has nothing to do with transactions.
     */
    if (lower.includes('verification') || lower.includes('kyc')) return { resourceType: 'general', ticketType: 'verification', subject: 'Verification help requested' };
    if (lower.includes('2fa') || lower.includes('authenticator') || lower.includes('account recovery') || lower.includes('login')) return { resourceType: 'general', ticketType: 'account_access', subject: 'Account access / 2FA recovery help requested' };
    if (lower.includes('virtual account') || lower.includes('deposit')) return { resourceType: 'general', ticketType: 'deposit_not_detected', subject: 'Virtual account deposit help requested' };
    if (lower.includes('buy') || lower.includes('on-ramp') || lower.includes('onramp')) return { resourceType: latestOrder ? 'onramp_order' : 'general', resourceId: latestOrder?.id, ticketType: 'onramp_payment', subject: 'Buy order support requested' };
    /**
     * 'transaction_lookup' rather than 'general' when we have nothing to pin.
     *
     * The two used to be the same value, and the server treated 'general' as
     * "attach their newest transaction" - which is how a verification question
     * got answered with a buy order. They are now distinct: this one means
     * "they ARE asking about a transaction, just have not said which", which
     * is the only case where picking the latest is reasonable.
     */
    if (lower.includes('withdraw') || lower.includes('sell') || lower.includes('transaction') || lower.includes('money') || lower.includes('payout')) return { resourceType: latestWithdrawal ? 'withdrawal' : latestOrder ? 'onramp_order' : 'transaction_lookup', resourceId: latestWithdrawal?.id || latestOrder?.id, ticketType: latestWithdrawal ? 'withdrawal' : latestOrder ? 'onramp_payment' : 'other', subject: 'Transaction support requested' };
    return { resourceType: 'general', ticketType: 'other', subject: 'Sivan Assistant support handoff' };
  }

  async function sendAssistantMessage(rawMessage: string, explicitContext?: AssistantContext) {
    const message = rawMessage.trim();
    if (!message) return;
    if (!hasUser || !user?.id) {
      setChatError('Sign in or create an account before using Sivan Assistant.');
      return;
    }
    if (aiMessagesUsed >= maxSessionMessages) {
      addSystemMessage('You have reached the 5-message assistant limit for this chat. Create a support ticket and the team will follow up.');
      return;
    }
    const dailyCount = readDailyCount(user.id);
    if (dailyCount >= maxDailyMessages) {
      addSystemMessage('You have reached today’s Ask Sivan limit. Create a support ticket and Sivan Support will follow up.');
      return;
    }

    const context = explicitContext ?? resolveContext(message);
    setChatContext(context);
    const userMessage: AssistantChatMessage = { id: chatId(), role: 'user', text: message, createdAt: new Date().toISOString() };
    setChatMessages((items) => [...items, userMessage]);
    setChatDraft('');
    setChatBusy(true);
    setChatError('');
    try {
      const result = await api<AssistantAnswer>(`/api/users/${user.id}/ace/support`, { method: 'POST', body: JSON.stringify({ message, resourceType: context.resourceType, resourceId: context.resourceId, channel: 'web_dashboard' }) });
      setLastAnswer(result);
      setAiMessagesUsed((value) => value + 1);
      writeDailyCount(user.id, dailyCount + 1);
      setChatMessages((items) => [...items, { id: chatId(), role: 'assistant', text: result.answer, createdAt: new Date().toISOString(), meta: result }]);
      if (result.needsHuman || result.confidence === 'low') addSystemMessage('I should get Sivan Support to review this. You can create a support ticket with this chat attached.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Sivan Assistant could not respond right now.';
      const friendly = /signal is aborted|aborted without reason|timed out|taking longer/i.test(raw)
        ? 'Sivan Assistant is taking longer than expected. No problem: create a support ticket and Sivan Support will review this.'
        : raw;
      setChatError('');
      addSystemMessage(friendly);
    } finally {
      setChatBusy(false);
    }
  }

  function addSystemMessage(text: string) {
    setChatMessages((items) => [...items, { id: chatId(), role: 'system', text, createdAt: new Date().toISOString() }]);
  }

  async function createTicketFromChat() {
    if (!user?.id) return setChatError('Sign in before creating a support ticket.');
    setChatBusy(true);
    setChatError('');
    try {
      const description = [
        'Customer requested human support from Ask Sivan.',
        '',
        'AI summary:',
        lastAnswer?.answer || 'No AI answer was generated before handoff.',
        '',
        'Chat transcript:',
        transcript(chatMessages)
      ].join('\n');
      const ticket = await api<SupportTicketRecord>('/api/support/tickets', {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          type: chatContext.ticketType,
          subject: chatContext.subject,
          description,
          resourceType: ['withdrawal','onramp_order','external_account','customer','general'].includes(chatContext.resourceType) ? chatContext.resourceType : 'general',
          resourceId: chatContext.resourceId,
          priority: lastAnswer?.needsHuman || lastAnswer?.confidence === 'low' ? 'high' : 'normal',
          metadata: {
            source: 'ask_sivan_chat',
            chatTranscript: chatMessages,
            aiSummary: lastAnswer?.answer,
            evidenceChecked: lastAnswer?.evidenceChecked,
            confidence: lastAnswer?.confidence,
            needsHuman: lastAnswer?.needsHuman,
            aiSessionId: lastAnswer?.sessionId,
            recommendedNextStep: lastAnswer?.needsHuman || lastAnswer?.confidence === 'low' ? 'Human support review recommended by Sivan Assistant.' : 'Customer requested human support after assistant chat.'
          }
        })
      });
      onTicketsChanged([ticket, ...tickets.filter((item) => item.id !== ticket.id)]);
      addSystemMessage(`Support ticket created: ${ticket.id}. Sivan Support will follow up from the ticket center/email.`);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Could not create support ticket.');
    } finally {
      setChatBusy(false);
    }
  }

  function quickPrompt(kind: 'transaction' | 'verification' | 'virtual_account' | 'recovery' | 'human') {
    openAssistant();
    if (kind === 'human') {
      addSystemMessage('No problem: create a support ticket and Sivan Support will review this. The assistant will not move funds or change your account.');
      setChatContext({ resourceType: 'general', ticketType: 'other', subject: 'Customer requested human support' });
      return;
    }
    /**
     * The chips are EXPLICIT context, not just canned text.
     *
     * "Verification help" used to send the sentence "I need help with
     * verification." and let the server guess from keywords - and the server's
     * classifier had no verification rule at all, so it fell through to
     * "general", which attached the newest transaction. Clicking the chip
     * returned a buy order status report. Reported as the chip doing nothing
     * useful; it was in fact answering a different question.
     *
     * A clicked chip is the least ambiguous signal in the whole flow, so it
     * now passes its own context rather than hoping the text round-trips.
     */
    const prompts: Record<string, { text: string; context: AssistantContext }> = {
      transaction: {
        text: 'Where is my transaction?',
        context: { resourceType: 'transaction_lookup', ticketType: 'other', subject: 'Transaction support requested' },
      },
      verification: {
        text: 'What is my verification status, and what is left to do?',
        context: { resourceType: 'general', ticketType: 'verification', subject: 'Verification help requested' },
      },
      /**
       * ASK ABOUT THE DEPOSIT, WHICH MEANS LOOKING ONE UP.
       *
       * This sent 'general', and 'general' now attaches nothing - correct for
       * a question with no subject, but a deposit question DOES have one. The
       * chip could therefore only ever return the generic "I could not find a
       * deposit" copy, even for a user whose deposit had settled minutes ago.
       *
       * 'virtual_account_transaction' resolves their latest deposit, so the
       * answer can state its real status instead of guessing at causes.
       */
      virtual_account: {
        text: 'Why is my virtual account deposit not showing?',
        context: { resourceType: 'virtual_account_transaction', ticketType: 'deposit_not_detected', subject: 'Virtual account deposit help requested' },
      },
      recovery: {
        text: 'How do I recover 2FA or account access?',
        context: { resourceType: 'general', ticketType: 'account_access', subject: 'Account access / 2FA recovery help requested' },
      },
    };
    const chosen = prompts[kind];
    void sendAssistantMessage(chosen.text, chosen.context);
  }

  return <section className="app-page support-premium"><PageHero title="Support" subtitle="Ask Sivan for guided help, create a ticket, or find quick answers when something needs attention." /><div className="support-card-grid"><SupportCard icon="✦" title="Ask Sivan" body="Instant guided help · Escalates to support when needed" action="Start chat" onClick={openAssistant} /><SupportCard icon="✉" title="Email support" body="support@sivantech.online" action="Send email" href="mailto:support@sivantech.online" /><SupportCard icon="☷" title="Help center" body="Guides, FAQs, and troubleshooting" action="Browse docs" /><a className="support-card" href="#report-issue"><span>☎</span><h3>Report an issue</h3><p>Problem with a transaction? Open a ticket.</p><strong>Open ticket →</strong></a></div><div className="support-legal-grid support-workspace-grid"><article className="support-faq-card support-report-card" id="report-issue"><p className="eyebrow">Support workspace</p><h3>Report an issue</h3><p className="muted">Tell us what happened. Add a transaction, bank reference, wallet address, or screenshot if available.</p>{!hasUser ? <Empty>Create your account or sign in before opening a support ticket.</Empty> : <form className="form" onSubmit={onCreateTicket}><label>Issue type<CustomSelect name="type" defaultValue="withdrawal" options={[{ value: 'verification', label: 'Verification issue' }, { value: 'bank_account', label: 'Bank account issue' }, { value: 'withdrawal', label: 'Withdrawal issue' }, { value: 'deposit_not_detected', label: 'Deposit sent but not detected' }, { value: 'wrong_token_or_network', label: 'Wrong token or wrong network' }, { value: 'payout_delayed', label: 'Payout delayed' }, { value: 'onramp_payment', label: 'On-ramp payment issue' }, { value: 'onramp_delivery', label: 'On-ramp crypto not received' }, { value: 'account_access', label: 'Account access issue' }, { value: 'other', label: 'Other' }]} /></label><label>Related item<CustomSelect name="relatedItem" defaultValue="general:" options={[{ value: 'general:', label: 'General issue' }, ...(customer ? [{ value: `customer:${customer.id}`, label: 'Verification', helper: friendlyStatus(customer.kycStatus) }] : []), ...withdrawals.map((withdrawal) => ({ value: `withdrawal:${withdrawal.id}`, label: `Withdrawal ${shortRef(withdrawal.id)}`, helper: friendlyStatus(withdrawal.status) })), ...onrampOrders.map((order) => ({ value: `onramp_order:${order.id}`, label: `Buy order ${shortRef(order.id)}`, helper: friendlyStatus(order.status) })), ...accounts.map((account) => ({ value: `external_account:${account.id}`, label: `Bank account ${account.currency.toUpperCase()}`, helper: `****${account.accountLast4 || '----'}` }))]} /></label><div className="split"><label>Transaction hash<input name="transactionHash" placeholder="Optional" /></label><label>Bank reference<input name="bankReference" placeholder="Optional" /></label></div><label>Wallet address<input name="walletAddress" placeholder="Optional wallet involved" /></label><label>Upload screenshot or receipt<input name="attachment" type="file" accept="image/png,image/jpeg,image/webp,image/heic,application/pdf" /></label><label>Attachment URL<input name="attachmentUrl" placeholder="Optional screenshot/receipt URL" /></label><label>Subject<input name="subject" placeholder="Short summary" required /></label><label>Description<textarea name="description" placeholder="Tell us what happened. Include date, amount, wallet address, transaction hash, bank reference, or error message if available." required /></label><button className="primary-btn" disabled={loading}>{loading ? 'Creating ticket...' : 'Create ticket'}</button></form>}</article><article className="support-faq-card support-ticket-card"><p className="eyebrow">Ticket center</p><h3>Your recent tickets</h3>{!tickets.length ? <Empty>No tickets yet. When you create a ticket, updates will appear here.</Empty> : <div className="list">{tickets.slice(0, 6).map((ticket) => <button className="list-item ticket-list-button" key={ticket.id} onClick={() => openTicket(ticket)}><strong>{ticket.subject}</strong><Badge status={ticket.status}>{friendlyStatus(ticket.status)}</Badge><small>{ticket.type.replaceAll('_', ' ')} · {ticket.priority}</small><small>{new Date(ticket.createdAt).toLocaleString()}</small></button>)}</div>}</article></div><div className="support-legal-grid support-resources-grid"><article className="support-faq-card"><p className="eyebrow">Self-help</p><h3>Frequently asked</h3>{faqs.map((faq) => <button key={faq}>{faq}<span>+</span></button>)}</article><LegalResources /></div>{selectedTicket && <TicketConversation ticket={selectedTicket} onClose={() => setSelectedTicket(null)} onReply={reply} />}{chatOpen && <AskSivanDrawer messages={chatMessages} draft={chatDraft} busy={chatBusy} error={chatError} aiMessagesUsed={aiMessagesUsed} dailyCount={readDailyCount(user?.id)} onDraft={setChatDraft} onClose={() => setChatOpen(false)} onSubmit={(event) => { event.preventDefault(); void sendAssistantMessage(chatDraft); }} onQuick={quickPrompt} onCreateTicket={createTicketFromChat} />}</section>;
}

function AskSivanDrawer({ messages, draft, busy, error, aiMessagesUsed, dailyCount, onDraft, onClose, onSubmit, onQuick, onCreateTicket }: { messages: AssistantChatMessage[]; draft: string; busy: boolean; error: string; aiMessagesUsed: number; dailyCount: number; onDraft: (value: string) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onQuick: (kind: 'transaction' | 'verification' | 'virtual_account' | 'recovery' | 'human') => void; onCreateTicket: () => void }) {
  const waitStage = useAssistantWaitStage(busy);
  return <div className="ask-sivan-backdrop"><aside className="ask-sivan-drawer"><div className="ask-sivan-head"><div><p className="eyebrow">Ask Sivan</p><h3>Sivan Assistant</h3><span>Read-only guidance · Human support when needed</span></div><button className="ghost-btn small" onClick={onClose}>Close</button></div><div className="ask-sivan-limits"><span>{aiMessagesUsed}/{maxSessionMessages} messages this chat</span><span>{dailyCount}/{maxDailyMessages} today</span></div><div className="ask-sivan-quick"><button onClick={() => onQuick('transaction')}>Where is my transaction?</button><button onClick={() => onQuick('verification')}>Verification help</button><button onClick={() => onQuick('virtual_account')}>Virtual account deposit</button><button onClick={() => onQuick('recovery')}>2FA/account recovery</button><button onClick={() => onQuick('human')}>Talk to support</button></div><div className="ask-sivan-thread">{messages.map((message) => <div className={`ask-sivan-message ${message.role}`} key={message.id}><strong>{message.role === 'assistant' ? 'Sivan Assistant' : message.role === 'system' ? 'System' : 'You'}</strong><p>{message.text}</p>{message.meta?.confidence && <small>Confidence: {message.meta.confidence} · {message.meta.needsHuman ? 'Support review recommended' : 'No human review needed'}</small>}</div>)}{busy && <div className="ask-sivan-message assistant typing" aria-live="polite"><strong>Sivan Assistant</strong><p>{waitStage}</p></div>}</div>{error && <div className="form-error">{error}</div>}<div className="ask-sivan-safe-note"><strong>Safety promise</strong><span>Sivan Assistant can explain and guide. It cannot move funds, reset 2FA, change email, approve KYC, retry payouts, or change transaction status.</span></div><form className="ask-sivan-compose" onSubmit={onSubmit}><input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="Ask about payments, verification, deposits, transfers, or account recovery…" disabled={busy || aiMessagesUsed >= maxSessionMessages || dailyCount >= maxDailyMessages} /><button className="primary-btn small" disabled={busy || !draft.trim() || aiMessagesUsed >= maxSessionMessages || dailyCount >= maxDailyMessages}>{busy ? 'Checking…' : 'Send'}</button></form><button className="secondary-btn ask-sivan-ticket" disabled={busy} onClick={onCreateTicket}>Create support ticket with this chat →</button></aside></div>;
}

function TicketConversation({ ticket, onClose, onReply }: { ticket: SupportTicketRecord; onClose: () => void; onReply: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="ticket-drawer"><div className="ticket-drawer-card"><div className="panel-head"><div><p className="eyebrow">Ticket {ticket.id}</p><h3>{ticket.subject}</h3></div><button className="ghost-btn small" onClick={onClose}>Close</button></div><div className="details-box"><Kv label="Status" value={friendlyStatus(ticket.status)} /><Kv label="Priority" value={ticket.priority} /><Kv label="Type" value={ticket.type.replaceAll('_', ' ')} /><Kv label="Related" value={`${ticket.resourceType}${ticket.resourceId ? ` · ${ticket.resourceId}` : ''}`} /></div><div className="ticket-thread">{(ticket.messages ?? []).filter((message) => !message.internalNote).map((message) => <div className={`ticket-message ${message.senderType}`} key={message.id}><strong>{message.senderType === 'admin' ? 'Sivan Support' : 'You'}</strong><p>{message.message}</p><small>{new Date(message.createdAt).toLocaleString()}</small></div>)}</div><form className="form" onSubmit={onReply}><label>Reply<textarea name="message" required /></label><button className="primary-btn">Send reply</button></form></div></div>;
}

function SupportCard({ icon, title, body, action, href, onClick }: { icon: string; title: string; body: string; action: string; href?: string; onClick?: () => void }) {
  const content = <><span>{icon}</span><h3>{title}</h3><p>{body}</p><strong>{action} →</strong></>;
  return href ? <a className="support-card" href={href}>{content}</a> : <button className="support-card" type="button" onClick={onClick}>{content}</button>;
}
