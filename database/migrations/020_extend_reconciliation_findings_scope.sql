alter table payments_reconciliation_findings
  add column if not exists resource_type text,
  add column if not exists resource_id text,
  add column if not exists reference_id text,
  add column if not exists webhook_event_id text,
  add column if not exists sivan_transaction_id text;

create index if not exists idx_payments_reconciliation_findings_type on payments_reconciliation_findings(finding_type);
create index if not exists idx_payments_reconciliation_findings_resource on payments_reconciliation_findings(resource_type, resource_id);
create index if not exists idx_payments_reconciliation_findings_reference on payments_reconciliation_findings(reference_id);
create index if not exists idx_payments_reconciliation_findings_webhook on payments_reconciliation_findings(webhook_event_id);
create index if not exists idx_payments_reconciliation_findings_sivan_tx on payments_reconciliation_findings(sivan_transaction_id);
