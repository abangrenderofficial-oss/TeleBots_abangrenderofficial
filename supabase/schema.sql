create extension if not exists pgcrypto;

create table if not exists bot_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists queue_items (
  id uuid primary key default gen_random_uuid(),
  admin_chat_id bigint not null,
  source_chat_id bigint not null,
  source_message_id bigint not null,
  preview_message_id bigint,
  media_kind text not null check (media_kind in ('document','photo','video','animation','audio','other')),
  file_name text,
  file_unique_id text,
  original_caption text,
  generated_title text,
  final_caption_html text,
  status text not null default 'PENDING' check (status in ('PENDING','READY','SENT','FAILED','SKIPPED')),
  caption_replaced boolean not null default false,
  destination_chat_id text,
  destination_message_id bigint,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists queue_items_status_idx on queue_items(status);
create index if not exists queue_items_file_unique_id_idx on queue_items(file_unique_id);

create table if not exists teaching_examples (
  id uuid primary key default gen_random_uuid(),
  original_caption text not null,
  corrected_title text not null,
  created_at timestamptz not null default now()
);
