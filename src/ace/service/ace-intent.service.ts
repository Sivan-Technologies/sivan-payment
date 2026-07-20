import type { AceResourceType } from '../types/ace.types.js';

export function inferAceResourceType(message: string, provided?: AceResourceType): AceResourceType {
  if (provided && provided !== 'general') return provided;
  const text = message.toLowerCase();
  if (/buy|on.?ramp|order|receive crypto|crypto delivery/.test(text)) return 'onramp_order';
  if (/withdraw|withdrawal|money|bank|payout|deposit|usdc|usdt|sell/.test(text)) return 'withdrawal';
  return provided ?? 'general';
}

export function isIncidentQuestion(message: string) {
  return /incident|delayed|bridge|provider|down|status|problem|issue/.test(message.toLowerCase());
}
