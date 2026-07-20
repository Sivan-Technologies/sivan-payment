create table if not exists transaction_references (
  id text primary key,
  sivan_transaction_id text not null,
  resource_type text not null,
  resource_id text not null,
  provider text not null,
  reference_type text not null,
  reference_value text not null,
  direction text not null,
  status text,
  metadata jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(provider, reference_type, reference_value, resource_type, resource_id)
);

create index if not exists idx_transaction_references_resource on transaction_references(resource_type, resource_id);
create index if not exists idx_transaction_references_value on transaction_references(lower(reference_value));
create index if not exists idx_transaction_references_sivan on transaction_references(sivan_transaction_id);
