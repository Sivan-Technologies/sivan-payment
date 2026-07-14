-- Production query indexes for direct read models, webhooks, admin pages, and auth lookups.

create index if not exists idx_users_email_lower on users (lower(email)) where email is not null;
create index if not exists idx_users_whatsapp_number on users (whatsapp_number) where whatsapp_number is not null;
create index if not exists idx_users_created_at_desc on users (created_at desc);

create index if not exists idx_payments_customers_user_created on payments_customers (user_id, created_at desc);
create index if not exists idx_payments_customers_status on payments_customers (kyc_status);

create index if not exists idx_payments_external_accounts_user_created on payments_external_accounts (user_id, created_at desc);
create index if not exists idx_payments_external_accounts_status on payments_external_accounts (status);

create index if not exists idx_payments_withdrawals_user_created on payments_withdrawals (user_id, created_at desc);
create index if not exists idx_payments_withdrawals_status_created on payments_withdrawals (status, created_at desc);
create index if not exists idx_payments_withdrawals_provider_created on payments_withdrawals (provider, created_at desc);
create index if not exists idx_payments_withdrawals_liquidation_address on payments_withdrawals (payments_liquidation_address_id);

create index if not exists idx_payments_webhook_events_created_desc on payments_webhook_events (created_at desc);
create index if not exists idx_payments_webhook_events_processed_at on payments_webhook_events (processed_at);
create index if not exists idx_payments_webhook_events_object on payments_webhook_events (event_object_id) where event_object_id is not null;

create index if not exists idx_payments_audit_logs_created_desc on payments_audit_logs (created_at desc);
create index if not exists idx_payments_audit_logs_actor on payments_audit_logs (actor_type, actor_id);
create index if not exists idx_payments_audit_logs_resource on payments_audit_logs (resource_type, resource_id);

create index if not exists idx_payments_reconciliation_runs_started_desc on payments_reconciliation_runs (started_at desc);

create index if not exists idx_payments_auth_challenges_email_created on payments_auth_challenges (email, created_at desc);
create index if not exists idx_payments_auth_challenges_consumed on payments_auth_challenges (consumed_at);

create index if not exists idx_payments_onramp_orders_user_created on payments_onramp_orders (user_id, created_at desc);
create index if not exists idx_payments_onramp_orders_status_created on payments_onramp_orders (status, created_at desc);
create index if not exists idx_payments_onramp_orders_provider_created on payments_onramp_orders (provider, created_at desc);
create index if not exists idx_payments_onramp_orders_provider_transfer on payments_onramp_orders (provider, provider_transfer_id) where provider_transfer_id is not null;
