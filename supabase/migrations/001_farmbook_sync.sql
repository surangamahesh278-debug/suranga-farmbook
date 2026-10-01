-- Suranga FarmBook cloud sync schema.
-- Apply this once in the Supabase SQL Editor. No FarmBook records are seeded here.

create table if not exists public.farmbook_cultivations (
  owner_id uuid not null,
  record_id text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null check (revision > 0),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, record_id),
  unique (owner_id, record_id),
  constraint farmbook_cultivation_payload_id check (payload->>'id' = record_id)
);

create table if not exists public.farmbook_expenses (
  owner_id uuid not null,
  record_id text not null,
  cultivation_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null check (revision > 0),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, record_id),
  unique (owner_id, record_id),
  constraint farmbook_expense_payload_id check (payload->>'id' = record_id),
  constraint farmbook_expense_cultivation_fk foreign key (owner_id, cultivation_id)
    references public.farmbook_cultivations(owner_id, record_id)
);

create table if not exists public.farmbook_income (
  owner_id uuid not null,
  record_id text not null,
  cultivation_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null check (revision > 0),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, record_id),
  unique (owner_id, record_id),
  constraint farmbook_income_payload_id check (payload->>'id' = record_id),
  constraint farmbook_income_cultivation_fk foreign key (owner_id, cultivation_id)
    references public.farmbook_cultivations(owner_id, record_id)
);

create table if not exists public.farmbook_settings (
  owner_id uuid primary key,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null check (revision > 0),
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.farmbook_sync_changes (
  sequence_id bigint generated always as identity primary key,
  owner_id uuid not null,
  operation_id uuid not null,
  entity_type text not null check (entity_type in ('cultivation', 'expense', 'income', 'settings')),
  record_id text not null,
  revision bigint not null,
  is_deleted boolean not null,
  payload jsonb not null,
  changed_at timestamptz not null default now(),
  unique (owner_id, operation_id)
);

create index if not exists farmbook_sync_changes_owner_sequence_idx
  on public.farmbook_sync_changes(owner_id, sequence_id);

alter table public.farmbook_cultivations enable row level security;
alter table public.farmbook_expenses enable row level security;
alter table public.farmbook_income enable row level security;
alter table public.farmbook_settings enable row level security;
alter table public.farmbook_sync_changes enable row level security;

drop policy if exists farmbook_cultivations_read_own on public.farmbook_cultivations;
create policy farmbook_cultivations_read_own on public.farmbook_cultivations
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists farmbook_expenses_read_own on public.farmbook_expenses;
create policy farmbook_expenses_read_own on public.farmbook_expenses
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists farmbook_income_read_own on public.farmbook_income;
create policy farmbook_income_read_own on public.farmbook_income
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists farmbook_settings_read_own on public.farmbook_settings;
create policy farmbook_settings_read_own on public.farmbook_settings
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists farmbook_sync_changes_read_own on public.farmbook_sync_changes;
create policy farmbook_sync_changes_read_own on public.farmbook_sync_changes
  for select to authenticated using ((select auth.uid()) = owner_id);

revoke all on public.farmbook_cultivations, public.farmbook_expenses,
  public.farmbook_income, public.farmbook_settings, public.farmbook_sync_changes
  from anon, authenticated;
grant select on public.farmbook_cultivations, public.farmbook_expenses,
  public.farmbook_income, public.farmbook_settings, public.farmbook_sync_changes
  to authenticated;

create or replace function public.farmbook_apply_batch(p_operations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_op jsonb;
  v_entity text;
  v_table text;
  v_id text;
  v_op_id uuid;
  v_expected bigint;
  v_revision bigint;
  v_deleted boolean;
  v_deleted_at timestamptz;
  v_payload jsonb;
  v_cultivation_id text;
  v_current_payload jsonb;
  v_current_deleted timestamptz;
  v_existing_event public.farmbook_sync_changes%rowtype;
  v_event public.farmbook_sync_changes%rowtype;
  v_results jsonb := '[]'::jsonb;
  v_status text;
  v_count integer := 0;
begin
  if v_owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) > 100 then
    raise exception 'A sync batch must be an array of at most 100 operations' using errcode = '22023';
  end if;

  for v_op in select value from jsonb_array_elements(p_operations)
  loop
    v_count := v_count + 1;
    v_entity := v_op->>'entity';
    v_id := v_op->>'record_id';
    v_op_id := (v_op->>'operation_id')::uuid;
    v_expected := (v_op->>'expected_revision')::bigint;
    v_deleted := coalesce((v_op->>'deleted')::boolean, false);
    v_payload := v_op->'payload';

    if v_entity is null or v_entity not in ('cultivation', 'expense', 'income', 'settings')
       or v_id is null or v_expected is null or v_expected < 0 or v_op_id is null then
      raise exception 'Invalid sync operation' using errcode = '22023';
    end if;
    if v_entity = 'settings' and v_id <> 'settings' then
      raise exception 'Invalid settings record ID' using errcode = '22023';
    end if;
    if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
      raise exception 'Each operation requires its full record payload' using errcode = '22023';
    end if;
    if v_entity <> 'settings' and (v_payload->>'id') is distinct from v_id then
      raise exception 'Record ID does not match the payload' using errcode = '22023';
    end if;

    select * into v_existing_event from public.farmbook_sync_changes
      where owner_id = v_owner and operation_id = v_op_id;
    if found then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'operation_id', v_op_id, 'status', 'already_applied',
        'revision', v_existing_event.revision, 'sequence_id', v_existing_event.sequence_id));
      continue;
    end if;

    v_table := case v_entity
      when 'cultivation' then 'farmbook_cultivations'
      when 'expense' then 'farmbook_expenses'
      when 'income' then 'farmbook_income'
      else 'farmbook_settings'
    end;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text || ':' || v_entity || ':' || v_id, 0));

    v_current_payload := null;
    v_current_deleted := null;
    v_revision := 0;
    if v_entity = 'settings' then
      select revision, payload, deleted_at into v_revision, v_current_payload, v_current_deleted
        from public.farmbook_settings where owner_id = v_owner for update;
    else
      execute pg_catalog.format('select revision, payload, deleted_at from public.%I where owner_id = $1 and record_id = $2 for update', v_table)
        into v_revision, v_current_payload, v_current_deleted using v_owner, v_id;
    end if;
    v_revision := coalesce(v_revision, 0);

    if v_revision <> v_expected then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'operation_id', v_op_id, 'status', 'conflict', 'revision', v_revision,
        'payload', v_current_payload, 'deleted', v_current_deleted is not null));
      continue;
    end if;

    v_revision := v_expected + 1;
    v_deleted_at := case when v_deleted then pg_catalog.now() else null end;
    v_cultivation_id := nullif(v_payload->>'farmId', '');
    if v_entity = 'expense' then
      insert into public.farmbook_expenses(owner_id, record_id, cultivation_id, payload, revision, deleted_at, updated_at)
      values (v_owner, v_id, v_cultivation_id, v_payload, v_revision, v_deleted_at, pg_catalog.now())
      on conflict (owner_id, record_id) do update set cultivation_id = excluded.cultivation_id,
        payload = excluded.payload, revision = excluded.revision, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at;
    elsif v_entity = 'income' then
      insert into public.farmbook_income(owner_id, record_id, cultivation_id, payload, revision, deleted_at, updated_at)
      values (v_owner, v_id, v_cultivation_id, v_payload, v_revision, v_deleted_at, pg_catalog.now())
      on conflict (owner_id, record_id) do update set cultivation_id = excluded.cultivation_id,
        payload = excluded.payload, revision = excluded.revision, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at;
    elsif v_entity = 'cultivation' then
      insert into public.farmbook_cultivations(owner_id, record_id, payload, revision, deleted_at, updated_at)
      values (v_owner, v_id, v_payload, v_revision, v_deleted_at, pg_catalog.now())
      on conflict (owner_id, record_id) do update set payload = excluded.payload,
        revision = excluded.revision, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at;
    else
      insert into public.farmbook_settings(owner_id, payload, revision, deleted_at, updated_at)
      values (v_owner, v_payload, v_revision, v_deleted_at, pg_catalog.now())
      on conflict (owner_id) do update set payload = excluded.payload,
        revision = excluded.revision, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at;
    end if;

    insert into public.farmbook_sync_changes(owner_id, operation_id, entity_type, record_id, revision, is_deleted, payload)
    values (v_owner, v_op_id, v_entity, v_id, v_revision, v_deleted, v_payload)
    returning * into v_event;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'operation_id', v_op_id, 'status', 'applied', 'revision', v_revision,
      'sequence_id', v_event.sequence_id));
  end loop;

  return jsonb_build_object('results', v_results, 'processed', v_count);
end;
$$;

create or replace function public.farmbook_pull_changes(p_after_sequence bigint default 0, p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_events jsonb;
  v_cursor bigint;
begin
  if v_owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(page) order by page.sequence_id), '[]'::jsonb),
         coalesce(max(page.sequence_id), p_after_sequence)
    into v_events, v_cursor
    from (
      select sequence_id, operation_id, entity_type, record_id, revision,
             is_deleted, payload, changed_at
        from public.farmbook_sync_changes
       where owner_id = v_owner and sequence_id > greatest(p_after_sequence, 0)
       order by sequence_id
       limit least(greatest(p_limit, 1), 500)
    ) as page;
  return jsonb_build_object('events', v_events, 'cursor', v_cursor);
end;
$$;

revoke all on function public.farmbook_apply_batch(jsonb) from public, anon;
revoke all on function public.farmbook_pull_changes(bigint, integer) from public, anon;
grant execute on function public.farmbook_apply_batch(jsonb) to authenticated;
grant execute on function public.farmbook_pull_changes(bigint, integer) to authenticated;

comment on table public.farmbook_cultivations is 'Private FarmBook cultivation records; IDs match existing local IDs.';
comment on table public.farmbook_expenses is 'Private FarmBook expense records; payload retains the local record shape.';
comment on table public.farmbook_income is 'Private FarmBook income records; payload retains the local record shape.';
comment on table public.farmbook_sync_changes is 'Append-only per-owner change feed used by offline FarmBook devices.';
