-- Bu skriptni Supabase loyihangizda SQL Editor bo'limiga qo'yib, "Run" tugmasini bosing.

-- 1) Kunlik foydalanish sonini saqlovchi jadval
create table if not exists usage_limits (
  user_id bigint not null,
  usage_date date not null,
  pro_count int not null default 0,
  primary key (user_id, usage_date)
);

-- 2) Savol-javob tarixini saqlovchi jadval
create table if not exists chat_history (
  id bigserial primary key,
  user_id bigint not null,
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_history_user
  on chat_history (user_id, created_at desc);
