create or replace function public.claim_immediate_media_worker(
  p_admin_chat_id bigint,
  p_lease_token text,
  p_lease_seconds integer default 45
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := 'immediate_media_worker_lease:' || p_admin_chat_id::text;
  v_current jsonb;
  v_lease_until timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));

  select value
    into v_current
    from public.bot_settings
   where key = v_key
   for update;

  if v_current is not null and jsonb_typeof(v_current) <> 'null' then
    begin
      v_lease_until := (v_current ->> 'lease_until')::timestamptz;
    exception when others then
      v_lease_until := null;
    end;

    if v_lease_until is not null
       and v_lease_until > now()
       and coalesce(v_current ->> 'token', '') <> coalesce(p_lease_token, '') then
      return false;
    end if;
  end if;

  insert into public.bot_settings(key, value, updated_at)
  values (
    v_key,
    jsonb_build_object(
      'token', p_lease_token,
      'lease_until', now() + make_interval(secs => greatest(5, least(coalesce(p_lease_seconds, 45), 120)))
    ),
    now()
  )
  on conflict (key) do update
    set value = excluded.value,
        updated_at = excluded.updated_at;

  return true;
end;
$$;

create or replace function public.release_immediate_media_worker(
  p_admin_chat_id bigint,
  p_lease_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := 'immediate_media_worker_lease:' || p_admin_chat_id::text;
  v_current jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));

  select value
    into v_current
    from public.bot_settings
   where key = v_key
   for update;

  if v_current is null or jsonb_typeof(v_current) = 'null' then
    return true;
  end if;

  if coalesce(v_current ->> 'token', '') <> coalesce(p_lease_token, '') then
    return false;
  end if;

  update public.bot_settings
     set value = 'null'::jsonb,
         updated_at = now()
   where key = v_key;

  return true;
end;
$$;

revoke all on function public.claim_immediate_media_worker(bigint, text, integer) from public, anon, authenticated;
revoke all on function public.release_immediate_media_worker(bigint, text) from public, anon, authenticated;
grant execute on function public.claim_immediate_media_worker(bigint, text, integer) to service_role;
grant execute on function public.release_immediate_media_worker(bigint, text) to service_role;
