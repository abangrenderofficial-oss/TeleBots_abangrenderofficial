alter table public.queue_items
  add column if not exists recaption_session_id uuid;

create table if not exists public.recaption_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_chat_id bigint not null,
  status text not null default 'COLLECTING'
    check (status in ('COLLECTING', 'PROCESSING', 'PAUSED', 'COMPLETED', 'FAILED')),
  item_count integer not null default 0,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists recaption_sessions_one_collecting_per_admin
  on public.recaption_sessions (admin_chat_id)
  where status = 'COLLECTING';

create index if not exists queue_items_recaption_session_order
  on public.queue_items (recaption_session_id, source_message_id, created_at);

create or replace function public.collect_forwarded_queue_item(
  p_admin_chat_id bigint,
  p_source_chat_id bigint,
  p_source_message_id bigint,
  p_media_kind text,
  p_file_name text default null,
  p_file_unique_id text default null,
  p_original_caption text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.recaption_sessions%rowtype;
  v_item public.queue_items%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('recaption:' || p_admin_chat_id::text, 0));

  select * into v_session
  from public.recaption_sessions
  where admin_chat_id = p_admin_chat_id
    and status = 'COLLECTING'
  order by created_at desc
  limit 1
  for update;

  if v_session.id is null then
    insert into public.recaption_sessions (admin_chat_id, status)
    values (p_admin_chat_id, 'COLLECTING')
    returning * into v_session;
  end if;

  insert into public.queue_items (
    admin_chat_id,
    source_chat_id,
    source_message_id,
    media_kind,
    file_name,
    file_unique_id,
    original_caption,
    generated_title,
    final_caption_html,
    status,
    caption_replaced,
    recaption_session_id
  ) values (
    p_admin_chat_id,
    p_source_chat_id,
    p_source_message_id,
    p_media_kind,
    p_file_name,
    p_file_unique_id,
    p_original_caption,
    null,
    null,
    'PENDING',
    false,
    v_session.id
  )
  returning * into v_item;

  update public.recaption_sessions
  set item_count = item_count + 1,
      updated_at = now()
  where id = v_session.id
  returning * into v_session;

  return jsonb_build_object(
    'session_id', v_session.id,
    'session_count', v_session.item_count,
    'item', to_jsonb(v_item)
  );
end;
$$;

create or replace function public.close_recaption_collection(p_admin_chat_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.recaption_sessions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('recaption:' || p_admin_chat_id::text, 0));

  select * into v_session
  from public.recaption_sessions
  where admin_chat_id = p_admin_chat_id
    and status = 'COLLECTING'
  order by created_at desc
  limit 1
  for update;

  if v_session.id is null then
    return null;
  end if;

  update public.recaption_sessions
  set status = 'PROCESSING',
      closed_at = now(),
      updated_at = now()
  where id = v_session.id
  returning * into v_session;

  return to_jsonb(v_session);
end;
$$;

revoke all on function public.collect_forwarded_queue_item(bigint,bigint,bigint,text,text,text,text) from public, anon, authenticated;
revoke all on function public.close_recaption_collection(bigint) from public, anon, authenticated;
grant execute on function public.collect_forwarded_queue_item(bigint,bigint,bigint,text,text,text,text) to service_role;
grant execute on function public.close_recaption_collection(bigint) to service_role;