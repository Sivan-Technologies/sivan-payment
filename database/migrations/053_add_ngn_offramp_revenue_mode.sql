alter table payments_ngn_controls
  add column if not exists offramp_revenue_mode text not null default 'sivan_fee_wallet';

alter table payments_ngn_controls
  drop constraint if exists payments_ngn_controls_offramp_revenue_mode_check;

alter table payments_ngn_controls
  add constraint payments_ngn_controls_offramp_revenue_mode_check
  check (offramp_revenue_mode in ('sivan_fee_wallet', 'breet_markup', 'disabled'));

update payments_ngn_controls
set offramp_revenue_mode = 'sivan_fee_wallet'
where offramp_revenue_mode is null
   or offramp_revenue_mode not in ('sivan_fee_wallet', 'breet_markup', 'disabled');
