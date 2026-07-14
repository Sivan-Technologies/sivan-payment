create table if not exists payments_support_tickets (
  id text primary key,
  user_id text not null references users(user_id),
  payments_customer_id text references payments_customers(id),
  ticket_type text not null,
  priority text not null,
  status text not null,
  subject text not null,
  description text not null,
  resource_type text not null,
  resource_id text,
  assigned_to text,
  last_message_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  closed_at timestamptz
);

create index if not exists idx_payments_support_tickets_user_created on payments_support_tickets(user_id, created_at desc);
create index if not exists idx_payments_support_tickets_status_created on payments_support_tickets(status, created_at desc);
create index if not exists idx_payments_support_tickets_priority_created on payments_support_tickets(priority, created_at desc);
create index if not exists idx_payments_support_tickets_type_created on payments_support_tickets(ticket_type, created_at desc);
create index if not exists idx_payments_support_tickets_resource on payments_support_tickets(resource_type, resource_id);

create table if not exists payments_support_ticket_messages (
  id text primary key,
  ticket_id text not null references payments_support_tickets(id) on delete cascade,
  sender_type text not null,
  sender_id text,
  message text not null,
  attachments jsonb,
  internal_note boolean not null default false,
  created_at timestamptz not null
);

create index if not exists idx_payments_support_ticket_messages_ticket_created on payments_support_ticket_messages(ticket_id, created_at asc);
create index if not exists idx_payments_support_ticket_messages_sender on payments_support_ticket_messages(sender_type, sender_id);
