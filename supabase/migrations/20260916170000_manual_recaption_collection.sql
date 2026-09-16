alter table public.queue_items
  add column if not exists recaption_session_id uuid;

create table if not exists public.recaption_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_chat_id bigint not null,
  status text not null default 'COLLECTING'
    check (status in ('COLLECTING', 'PROCESSING', 'PAUSED', 'COMPLETED', 'FAILED')),
  item_count integer not null default 0,
  worker_secret text,
  worker_lease_token text,
  worker_lease_until timestamptz,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.recaption_sessions
  add column if not exists worker_secret text,
  add column if not exists worker_lease_token text,
  add column if not exists worker_lease_until timestamptz;

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

  -- Telegram can replay one webhook. Never create the same queue occurrence
  -- twice just because the webhook was delivered again.
  select * into v_item
  from public.queue_items
  where admin_chat_id = p_admin_chat_id
    and source_chat_id = p_source_chat_id
    and source_message_id = p_source_message_id
  order by created_at desc
  limit 1;

  if v_item.id is not null then
    return jsonb_build_object(
      'replay', true,
      'session_id', v_item.recaption_session_id,
      'session_count', null,
      'item', to_jsonb(v_item)
    );
  end if;

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
    'replay', false,
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
      worker_secret = coalesce(worker_secret, gen_random_uuid()::text),
      worker_lease_token = null,
      worker_lease_until = null,
      closed_at = now(),
      updated_at = now()
  where id = v_session.id
  returning * into v_session;

  return to_jsonb(v_session);
end;
$$;

create or replace function public.claim_recaption_worker(
  p_session_id uuid,
  p_worker_secret text,
  p_lease_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.recaption_sessions%rowtype;
begin
  select * into v_session
  from public.recaption_sessions
  where id = p_session_id
  for update;

  if v_session.id is null or coalesce(v_session.worker_secret, '') <> coalesce(p_worker_secret, '') then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_credentials');
  end if;

  if v_session.status <> 'PROCESSING' then
    return jsonb_build_object('claimed', false, 'reason', 'not_processing', 'status', v_session.status);
  end if;

  if v_session.worker_lease_until is not null
     and v_session.worker_lease_until > now()
     and coalesce(v_session.worker_lease_token, '') <> coalesce(p_lease_token, '') then
    return jsonb_build_object('claimed', false, 'reason', 'busy', 'lease_until', v_session.worker_lease_until);
  end if;

  update public.recaption_sessions
  set worker_lease_token = p_lease_token,
      worker_lease_until = now() + interval '90 seconds',
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return jsonb_build_object('claimed', true, 'session', to_jsonb(v_session));
end;
$$;

create or replace function public.release_recaption_worker(
  p_session_id uuid,
  p_worker_secret text,
  p_lease_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.recaption_sessions
  set worker_lease_token = null,
      worker_lease_until = null,
      updated_at = now()
  where id = p_session_id
    and worker_secret = p_worker_secret
    and worker_lease_token = p_lease_token;
  return found;
end;
$$;

revoke all on function public.collect_forwarded_queue_item(bigint,bigint,bigint,text,text,text,text) from public, anon, authenticated;
revoke all on function public.close_recaption_collection(bigint) from public, anon, authenticated;
revoke all on function public.claim_recaption_worker(uuid,text,text) from public, anon, authenticated;
revoke all on function public.release_recaption_worker(uuid,text,text) from public, anon, authenticated;
grant execute on function public.collect_forwarded_queue_item(bigint,bigint,bigint,text,text,text,text) to service_role;
grant execute on function public.close_recaption_collection(bigint) to service_role;
grant execute on function public.claim_recaption_worker(uuid,text,text) to service_role;
grant execute on function public.release_recaption_worker(uuid,text,text) to service_role;