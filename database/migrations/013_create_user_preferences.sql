create table if not exists payments_user_preferences (
  user_id text primary key references users(user_id) on delete cascade,
  default_fiat_currency text not null default 'usd',
  language text not null default 'en-US',
  transaction_updates boolean not null default true,
  marketing_emails boolean not null default false,
  security_alerts boolean not null default true,
  email_confirmations_for_high_value boolean not null default false,
  updated_at timestamptz not null
);

create index if not exists idx_payments_user_preferences_language on payments_user_preferences(language);
create index if not exists idx_payments_user_preferences_updated_at on payments_user_preferences(updated_at desc);
