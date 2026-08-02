/**
 * One-shot alerting setup. Run it, answer two questions, done.
 *
 * Replaces a page of dashboard clicking with a script that also VERIFIES what
 * it configured - the step people skip, and the reason "we have monitoring"
 * so often means "we have a monitoring account".
 *
 * It will:
 *   1. check the bot token actually authenticates
 *   2. find your chat id from a message you send the bot
 *   3. send a real test alert so you can see the format on your phone
 *   4. write .env.watchdog (gitignored)
 *   5. probe both APIs and show exactly what is wrong right now
 *
 * Run: npm run setup:alerts
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const TARGETS = [
  'https://sivan-payments-api-test-x9xq.onrender.com',
  'https://sivan-payments-api-live-cgqi.onrender.com',
];

async function main() {
  const rl = readline.createInterface({ input, output });
  console.log('\n=== Sivan alerting setup ===\n');
  console.log('Step 1 of 3: create the bot');
  console.log('  Open Telegram, message @BotFather, send /newbot, name it "Sivan Alerts".');
  console.log('  It replies with a token like 8123456789:AAF...\n');
  console.log('  NOTE: do NOT reuse @SivanAi_bot. That one has a live production');
  console.log('  webhook serving telegram-layer, and polling it would conflict.\n');

  const token = (await rl.question('Paste the NEW bot token: ')).trim();
  if (!token) { console.error('No token given.'); process.exit(1); }

  // Verify before going further. A typo here otherwise surfaces at 3am as
  // silence, which is indistinguishable from "nothing is wrong".
  const me: any = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
  if (!me?.ok) {
    console.error(`\nThat token did not authenticate: ${me?.description ?? 'unknown error'}`);
    process.exit(1);
  }
  console.log(`  ✓ bot is @${me.result.username}\n`);

  console.log('Step 2 of 3: link your account');
  console.log(`  Open https://t.me/${me.result.username} and send it any message (e.g. "hi").`);
  await rl.question('  Press Enter once you have sent it: ');

  const updates: any = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
  if (!updates?.ok) {
    console.error(`\ngetUpdates failed: ${updates?.description}`);
    if (/conflict/i.test(String(updates?.description))) {
      console.error('That bot has a webhook set - it is probably the production bot. Use a NEW one.');
    }
    process.exit(1);
  }
  const chats = new Map<string, string>();
  for (const update of updates.result ?? []) {
    const chat = (update.message ?? update.channel_post)?.chat;
    if (chat?.id) chats.set(String(chat.id), chat.first_name ?? chat.title ?? chat.username ?? '');
  }
  if (!chats.size) {
    console.error('\nNo messages seen. Send the bot a message, then run this again.');
    process.exit(1);
  }

  let chatId = [...chats.keys()][0];
  if (chats.size > 1) {
    console.log('\n  Several chats found:');
    for (const [id, name] of chats) console.log(`    ${id}  ${name}`);
    chatId = (await rl.question('  Which chat id? ')).trim();
  }
  console.log(`  ✓ chat id ${chatId} (${chats.get(chatId) ?? ''})\n`);

  console.log('Step 3 of 3: send a real alert');
  const send = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      parse_mode: 'HTML',
      text: '🟢 <b>Sivan alerting is live</b>\n\nThis is what a real alert looks like. '
        + 'Critical alerts arrive once when something breaks and once when it recovers — '
        + 'never every minute.\n\n<code>setup test</code>',
    }),
  });
  if (!send.ok) {
    console.error(`  Sending failed: ${send.status} ${await send.text().catch(() => '')}`);
    process.exit(1);
  }
  console.log('  ✓ check your phone — you should have a message\n');

  const envPath = path.join(process.cwd(), '.env.watchdog');
  await fs.writeFile(envPath,
    `# Written by npm run setup:alerts on ${new Date().toISOString()}\n`
    + `# Gitignored. This token can post to your Telegram; treat it as a secret.\n`
    + `WATCHDOG_TARGETS=${TARGETS.join(',')}\n`
    + `WATCHDOG_TELEGRAM_BOT_TOKEN=${token}\n`
    + `WATCHDOG_TELEGRAM_CHAT_ID=${chatId}\n`
    + `WATCHDOG_INTERVAL_SECONDS=60\n`
    + `WATCHDOG_FAILURES_BEFORE_ALERT=2\n`);
  console.log(`  ✓ wrote ${envPath}\n`);

  console.log('=== What is broken right now ===\n');
  for (const target of TARGETS) {
    try {
      const res = await fetch(`${target}/health/operational`);
      const body: any = await res.json().catch(() => null);
      const bad = (body?.signals ?? []).filter((s: any) => s.severity !== 'ok');
      if (res.status === 404) {
        console.log(`  ${target}\n    STALE — /health/operational is not deployed here yet\n`);
        continue;
      }
      console.log(`  ${target}\n    HTTP ${res.status} · ${body?.status ?? '?'}`);
      for (const s of bad) console.log(`      [${s.severity}] ${s.name}\n        ${s.detail}`);
      if (!bad.length) console.log('      nothing wrong');
      console.log('');
    } catch (error) {
      console.log(`  ${target}\n    unreachable: ${(error as Error).message}\n`);
    }
  }

  console.log('=== Next ===');
  console.log('  npm run watchdog -- --once     one pass, prints and exits');
  console.log('  npm run watchdog               continuous, alerts on change');
  console.log('  See WATCHDOG-SETUP.md for the systemd unit for AWS.\n');

  rl.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
