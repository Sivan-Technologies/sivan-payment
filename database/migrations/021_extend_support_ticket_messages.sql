alter table payments_support_ticket_messages
  add column if not exists message_type text not null default 'conversation',
  add column if not exists note_type text,
  add column if not exists title text,
  add column if not exists status_after text,
  add column if not exists visible_to_customer boolean not null default true,
  add column if not exists metadata jsonb;

update payments_support_ticket_messages
set message_type = case when internal_note then 'internal_note' else 'conversation' end,
    visible_to_customer = case when internal_note then false else true end
where message_type = 'conversation';

create index if not exists idx_payments_support_ticket_messages_type on payments_support_ticket_messages(message_type, note_type);
create index if not exists idx_payments_support_ticket_messages_visibility on payments_support_ticket_messages(ticket_id, visible_to_customer, created_at);
