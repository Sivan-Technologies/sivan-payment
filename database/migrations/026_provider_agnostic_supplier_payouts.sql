alter table payments_suppliers
  add column if not exists provider text not null default 'bridge',
  add column if not exists provider_external_account_id text,
  add column if not exists provider_rail text;

update payments_suppliers
set provider = coalesce(provider, 'bridge'),
    provider_external_account_id = coalesce(provider_external_account_id, bridge_external_account_id),
    provider_rail = coalesce(provider_rail,
      case currency
        when 'gbp' then 'faster_payments'
        when 'usd' then 'ach'
        when 'eur' then 'sepa'
        when 'mxn' then 'spei'
        when 'brl' then 'pix'
        else null
      end
    );

create index if not exists idx_payments_suppliers_provider_external on payments_suppliers(provider, provider_external_account_id);

alter table payments_supplier_payments
  add column if not exists provider text,
  add column if not exists provider_transfer_id text,
  add column if not exists provider_rail text,
  add column if not exists execution_mode text check (execution_mode in ('provider','manual_review','manual_treasury'));

update payments_supplier_payments
set provider = coalesce(provider, 'bridge'),
    provider_transfer_id = coalesce(provider_transfer_id, bridge_transfer_id),
    provider_rail = coalesce(provider_rail,
      case destination_currency
        when 'gbp' then 'faster_payments'
        when 'usd' then 'ach'
        when 'eur' then 'sepa'
        when 'mxn' then 'spei'
        when 'brl' then 'pix'
        else null
      end
    ),
    execution_mode = coalesce(execution_mode, 'provider');

create index if not exists idx_payments_supplier_payments_provider_transfer on payments_supplier_payments(provider, provider_transfer_id);
