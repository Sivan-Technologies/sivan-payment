# Watchdog setup

Polls the APIs every 60s and alerts to Telegram when money stops moving.

## Why not UptimeRobot

I recommended it in the launch runbook. That was wrong, and the correction
matters:

- Free tier is **5-minute** checks, not 1-minute.
- Free tier has been **restricted to personal, non-commercial use** since
  October 2024. Sivan is a payments company.
- Free tier has **no SMS**; credits start around $3 for 10.
- 1-minute checks plus SMS is roughly **$7-10/month**.

And a generic uptime monitor can only see a status code. This reads the body,
so an alert says *"3 transfers stuck in flight - check the Breet webhook log"*
rather than "site down".

## Where it runs

**NOT on a machine it watches.** A watchdog on the same box cannot tell you
the box is down. Run it on the AWS instance pointed at the API hosts.

Pair it with **one** free external check (UptimeRobot free, or Better Stack's
ten free monitors) pointed at the watchdog host itself, as a dead-man's
switch. One monitor, inside any free tier.

## Telegram: reuse your bot, use a separate channel

**You do not need a second bot.** Verified against the live API: `sendMessage`
works normally even while a bot has a production webhook. Only `getUpdates`
conflicts (409), and that is just chat-id discovery, not sending.

So reuse `@SivanAi_bot`. What you *should* separate is the **destination** —
alerts must not land in the same place as customer OTPs, or a 3am critical
scrolls past between one-time codes.

`SiaNotify/.env` already has a `TELEGRAM_LOGS_CHAT_ID` slot for exactly this,
and it is currently empty.

### Create the alerts channel

1. Telegram → **New Channel** → name it `Sivan Alerts` (private is fine)
2. Add your bot as an **admin** of the channel — admin rights are required to
   post; plain membership is not enough
3. Post any message in the channel
4. Forward that message to `@userinfobot`, which replies with the channel id

Channel ids look like `-1001234567890`. **Keep the leading minus sign** — it is
part of the id, not a typo.

Then run `npm run setup:alerts` and paste the token and that id. The script
detects the webhook, skips auto-discovery, and sends a real test message so
you see the format on your phone before it matters.

## Configure

```
WATCHDOG_TARGETS=https://api-host-1,https://api-host-2
WATCHDOG_TELEGRAM_BOT_TOKEN=<new alerts bot token>
WATCHDOG_TELEGRAM_CHAT_ID=<your chat id>
WATCHDOG_INTERVAL_SECONDS=60
WATCHDOG_FAILURES_BEFORE_ALERT=2
```

Smoke test:

```
npm run watchdog -- --once
```

Exit code 1 and a printed reason if anything is unhealthy, so it also works
as a cron job or a CI gate.

## systemd (AWS)

```ini
# /etc/systemd/system/sivan-watchdog.service
[Unit]
Description=Sivan watchdog
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/sivan-payment
EnvironmentFile=/opt/sivan-payment/.env.watchdog
ExecStart=/usr/bin/npx tsx scripts/watchdog.ts
Restart=always
RestartSec=10
User=sivan

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl enable --now sivan-watchdog
journalctl -u sivan-watchdog -f
```

## Alerting behaviour

Alerts fire on **transition only**: once when it breaks, once when it
recovers. A four-hour incident sends **one** message, not 240.

That is the difference between an alert channel someone reads and one they
mute - and a muted channel is worse than none, because it looks like coverage.

- `critical` and `unreachable` alert. `warn` does not - a slow review queue at
  3am is a morning problem.
- Two consecutive failures before alerting, so one cold-start timeout is not
  an incident.
- A change of failure mode (critical -> unreachable) alerts again, because it
  is an escalation.
- A 404 on `/health/operational` is treated as **critical**, not healthy. That
  is the stale-deploy case: `/health` returns 200 on old code, which is
  exactly what happened for six commits when migration 036 broke the build.

23 assertions in `npm run test:watchdog`, including a simulated four-hour
incident. Mutation-tested: removing de-duplication produces 239 alerts.
