alter table public.queue_items
  add column if not exists immediate_prepared_at timestamptz,
  add column if not exists immediate_audit_at timestamptz,
  add column if not exists preview_send_state text,
  add column if not exists preview_send_token uuid,
  add column if not exists preview_send_started_at timestamptz;

create or replace function public.claim_queue_preview_send(
  p_item_id uuid,
  p_token uuid,
  p_stale_seconds integer default 180
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid;
begin
  update public.queue_items
     set preview_send_state = 'SENDING',
         preview_send_token = p_token,
         preview_send_started_at = now(),
         updated_at = now()
   where id = p_item_id
     and status = 'PENDING'
     and immediate_prepared_at is not null
     and preview_message_id is null
     and (
       preview_send_state is distinct from 'SENDING'
       or preview_send_started_at is null
       or preview_send_started_at < now() - make_interval(secs => greatest(coalesce(p_stale_seconds, 180), 30))
     )
  returning id into v_claimed;

  return v_claimed is not null;
end;
$$;

create or replace function public.complete_queue_preview_send(
  p_item_id uuid,
  p_token uuid,
  p_preview_message_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done uuid;
begin
  update public.queue_items
     set preview_message_id = p_preview_message_id,
         status = 'READY',
         preview_send_state = 'SENT',
         preview_send_token = null,
         preview_send_started_at = null,
         updated_at = now()
   where id = p_item_id
     and preview_message_id is null
     and preview_send_state = 'SENDING'
     and preview_send_token = p_token
  returning id into v_done;

  return v_done is not null;
end;
$$;

create or replace function public.release_queue_preview_send(
  p_item_id uuid,
  p_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done uuid;
begin
  update public.queue_items
     set preview_send_state = null,
         preview_send_token = null,
         preview_send_started_at = null,
         updated_at = now()
   where id = p_item_id
     and preview_message_id is null
     and preview_send_state = 'SENDING'
     and preview_send_token = p_token
  returning id into v_done;

  return v_done is not null;
end;
$$;

revoke all on function public.claim_queue_preview_send(uuid, uuid, integer) from public;
revoke all on function public.complete_queue_preview_send(uuid, uuid, bigint) from public;
revoke all on function public.release_queue_preview_send(uuid, uuid) from public;
grant execute on function public.claim_queue_preview_send(uuid, uuid, integer) to service_role;
grant execute on function public.complete_queue_preview_send(uuid, uuid, bigint) to service_role;
grant execute on function public.release_queue_preview_send(uuid, uuid) to service_role;

create or replace function public.schedule_immediate_media_worker(
  p_url text,
  p_admin_chat_id bigint,
  p_worker_secret text
)
returns bigint
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_request_id bigint;
begin
  if coalesce(trim(p_url), '') = '' then
    raise exception 'worker url is required';
  end if;
  if p_admin_chat_id is null then
    raise exception 'admin chat id is required';
  end if;
  if coalesce(trim(p_worker_secret), '') = '' then
    raise exception 'worker secret is required';
  end if;

  select net.http_post(
    url := p_url,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object(
      'mode', 'immediate_media',
      'chat_id', p_admin_chat_id::text,
      'worker_secret', p_worker_secret
    ),
    timeout_milliseconds := 60000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.schedule_immediate_media_worker(text, bigint, text) from public;
grant execute on function public.schedule_immediate_media_worker(text, bigint, text) to service_role;
