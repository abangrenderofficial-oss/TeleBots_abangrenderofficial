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
    timeout_milliseconds := 15000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.schedule_immediate_media_worker(text, bigint, text) from public;
grant execute on function public.schedule_immediate_media_worker(text, bigint, text) to service_role;
