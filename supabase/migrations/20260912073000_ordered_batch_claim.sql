create or replace function public.claim_send_batch_item_ordered(p_batch_id text)
returns setof public.send_batch_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.send_batch_items%rowtype;
begin
  -- Serialize claim attempts for this exact batch inside one DB transaction.
  perform pg_advisory_xact_lock(hashtextextended(p_batch_id, 0));

  -- Only the earliest unfinished item can move to SENDING. If that earliest
  -- item is already SENDING, a duplicate worker must leave without claiming a
  -- later position.
  select *
    into v_row
  from public.send_batch_items
  where batch_id = p_batch_id
    and status in ('PENDING', 'SENDING')
  order by position asc
  limit 1
  for update;

  if not found or v_row.status <> 'PENDING' then
    return;
  end if;

  update public.send_batch_items
  set status = 'SENDING',
      attempts = coalesce(attempts, 0) + 1,
      started_at = now(),
      updated_at = now()
  where batch_id = p_batch_id
    and position = v_row.position
    and status = 'PENDING'
  returning * into v_row;

  if not found then
    return;
  end if;

  return next v_row;
end;
$$;

revoke all on function public.claim_send_batch_item_ordered(text) from public;
revoke all on function public.claim_send_batch_item_ordered(text) from anon;
revoke all on function public.claim_send_batch_item_ordered(text) from authenticated;
grant execute on function public.claim_send_batch_item_ordered(text) to service_role;
