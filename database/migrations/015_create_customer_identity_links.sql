create table if not exists customer_identity_links (
  id text primary key,
  payment_user_id text not null references users(user_id),
  escrow_user_id text,
  email text not null,
  whatsapp_number text not null,
  status text not null,
  linked_at timestamptz,
  unlinked_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index if not exists idx_customer_identity_links_active_payment_user
  on customer_identity_links(payment_user_id)
  where status = 'linked';

create unique index if not exists idx_customer_identity_links_active_whatsapp
  on customer_identity_links(whatsapp_number)
  where status = 'linked';

create index if not exists idx_customer_identity_links_email on customer_identity_links(lower(email));
create index if not exists idx_customer_identity_links_escrow_user on customer_identity_links(escrow_user_id);

create table if not exists identity_pairing_tokens (
  id text primary key,
  payment_user_id text not null references users(user_id),
  token_hash text not null unique,
  status text not null,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  canceled_at timestamptz,
  whatsapp_number text,
  escrow_user_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists idx_identity_pairing_tokens_user_status on identity_pairing_tokens(payment_user_id, status);
create index if not exists idx_identity_pairing_tokens_expires_at on identity_pairing_tokens(expires_at);
