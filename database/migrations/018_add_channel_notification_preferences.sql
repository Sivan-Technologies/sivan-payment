-- Add granular per-channel notification preferences to payments_user_preferences
alter table if exists payments_user_preferences
  add column if not exists telegram_notifications_enabled boolean not null default true,
  add column if not exists whatsapp_notifications_enabled boolean not null default false,
  add column if not exists multi_chain_alerts_enabled boolean not null default true;
