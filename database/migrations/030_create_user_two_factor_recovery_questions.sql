create table if not exists payments_user_two_factor_recovery_questions (
  id text primary key,
  user_id text not null references users(user_id) on delete cascade,
  question_id text not null,
  question_text text not null,
  answer_hash text not null,
  answer_salt text not null,
  algorithm text not null default 'scrypt-sha256-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_user_2fa_recovery_question_unique unique (user_id, question_id)
);

create index if not exists idx_payments_user_2fa_recovery_questions_user on payments_user_two_factor_recovery_questions(user_id, updated_at desc);
