export const sql_000001 = `-- Create the tables
create table :GRAPHILE_WORKER_SCHEMA.job_queues (
  queue_name text not null primary key,
  job_count int not null,
  locked_at timestamptz,
  locked_by text
);
alter table :GRAPHILE_WORKER_SCHEMA.job_queues enable row level security;

create table :GRAPHILE_WORKER_SCHEMA.jobs (
  id bigserial primary key,
  queue_name text not null,
  task_identifier text not null,
  payload json default '{}'::json not null,
  priority int default 0 not null,
  run_at timestamptz default now() not null,
  attempts int default 0 not null,
  max_attempts int default 25 not null,
  last_error text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
alter table :GRAPHILE_WORKER_SCHEMA.jobs enable row level security;

create index on :GRAPHILE_WORKER_SCHEMA.jobs (priority, run_at, id);

-- Keep updated_at up to date
create function :GRAPHILE_WORKER_SCHEMA.tg__update_timestamp() returns trigger as $$
begin
  new.updated_at = greatest(now(), old.updated_at + interval '1 millisecond');
  return new;
end;
$$ language plpgsql;
create trigger _100_timestamps before update on :GRAPHILE_WORKER_SCHEMA.jobs for each row execute procedure :GRAPHILE_WORKER_SCHEMA.tg__update_timestamp();

-- Manage the job_queues table - creating and deleting entries as appropriate
create function :GRAPHILE_WORKER_SCHEMA.jobs__decrease_job_queue_count() returns trigger as $$
declare
  v_new_job_count int;
begin
  update :GRAPHILE_WORKER_SCHEMA.job_queues
    set job_count = job_queues.job_count - 1
    where queue_name = old.queue_name
    returning job_count into v_new_job_count;

  if v_new_job_count <= 0 then
    delete from :GRAPHILE_WORKER_SCHEMA.job_queues where queue_name = old.queue_name and job_count <= 0;
  end if;

  return old;
end;
$$ language plpgsql;
create function :GRAPHILE_WORKER_SCHEMA.jobs__increase_job_queue_count() returns trigger as $$
begin
  insert into :GRAPHILE_WORKER_SCHEMA.job_queues(queue_name, job_count)
    values(new.queue_name, 1)
    on conflict (queue_name)
    do update
    set job_count = job_queues.job_count + 1;

  return new;
end;
$$ language plpgsql;
create trigger _500_increase_job_queue_count after insert on :GRAPHILE_WORKER_SCHEMA.jobs for each row execute procedure :GRAPHILE_WORKER_SCHEMA.jobs__increase_job_queue_count();
create trigger _500_decrease_job_queue_count after delete on :GRAPHILE_WORKER_SCHEMA.jobs for each row execute procedure :GRAPHILE_WORKER_SCHEMA.jobs__decrease_job_queue_count();
create trigger _500_increase_job_queue_count_update after update of queue_name on :GRAPHILE_WORKER_SCHEMA.jobs for each row execute procedure :GRAPHILE_WORKER_SCHEMA.jobs__increase_job_queue_count();
create trigger _500_decrease_job_queue_count_update after update of queue_name on :GRAPHILE_WORKER_SCHEMA.jobs for each row execute procedure :GRAPHILE_WORKER_SCHEMA.jobs__decrease_job_queue_count();

-- Notify worker of new jobs
create function :GRAPHILE_WORKER_SCHEMA.tg_jobs__notify_new_jobs() returns trigger as $$
begin
  perform pg_notify('jobs:insert', '');
  return new;
end;
$$ language plpgsql;
create trigger _900_notify_worker after insert on :GRAPHILE_WORKER_SCHEMA.jobs for each statement execute procedure :GRAPHILE_WORKER_SCHEMA.tg_jobs__notify_new_jobs();

-- Function to queue a job
create function :GRAPHILE_WORKER_SCHEMA.add_job(
  identifier text,
  payload json = '{}',
  queue_name text = null, -- was gen_random_uuid(), but later removed dependency
  run_at timestamptz = now(),
  max_attempts int = 25
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
  insert into :GRAPHILE_WORKER_SCHEMA.jobs(task_identifier, payload, queue_name, run_at, max_attempts) values(identifier, payload, queue_name, run_at, max_attempts) returning *;
$$ language sql;

-- The main function - find me a job to do!
create function :GRAPHILE_WORKER_SCHEMA.get_job(worker_id text, task_identifiers text[] = null, job_expiry interval = interval '4 hours') returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_default_job_max_attempts text = '25';
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select job_queues.queue_name, jobs.id into v_queue_name, v_job_id
    from :GRAPHILE_WORKER_SCHEMA.jobs
    inner join :GRAPHILE_WORKER_SCHEMA.job_queues using (queue_name)
    where (locked_at is null or locked_at < (now() - job_expiry))
    and run_at <= now()
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    order by priority asc, run_at asc, id asc
    limit 1
    for update of job_queues
    skip locked;

  if v_queue_name is null then
    return null;
  end if;

  update :GRAPHILE_WORKER_SCHEMA.job_queues
    set
      locked_by = worker_id,
      locked_at = now()
    where job_queues.queue_name = v_queue_name;

  update :GRAPHILE_WORKER_SCHEMA.jobs
    set attempts = attempts + 1
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql;

-- I was successful, mark the job as completed
create function :GRAPHILE_WORKER_SCHEMA.complete_job(worker_id text, job_id bigint) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  delete from :GRAPHILE_WORKER_SCHEMA.jobs
    where id = job_id
    returning * into v_row;

  update :GRAPHILE_WORKER_SCHEMA.job_queues
    set locked_by = null, locked_at = null
    where queue_name = v_row.queue_name and locked_by = worker_id;

  return v_row;
end;
$$ language plpgsql;

-- I was unsuccessful, re-schedule the job please
create function :GRAPHILE_WORKER_SCHEMA.fail_job(worker_id text, job_id bigint, error_message text) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      last_error = error_message,
      run_at = greatest(now(), run_at) + (exp(least(attempts, 10))::text || ' seconds')::interval
    where id = job_id
    returning * into v_row;

  update :GRAPHILE_WORKER_SCHEMA.job_queues
    set locked_by = null, locked_at = null
    where queue_name = v_row.queue_name and locked_by = worker_id;

  return v_row;
end;
$$ language plpgsql;

`;
export const sql_000002 = `alter table :GRAPHILE_WORKER_SCHEMA.jobs add column key text unique check(length(key) > 0);

alter table :GRAPHILE_WORKER_SCHEMA.jobs add locked_at timestamptz;
alter table :GRAPHILE_WORKER_SCHEMA.jobs add locked_by text;

-- update any in-flight jobs
update :GRAPHILE_WORKER_SCHEMA.jobs
  set locked_at = q.locked_at, locked_by = q.locked_by
  from :GRAPHILE_WORKER_SCHEMA.job_queues q
  where q.queue_name = jobs.queue_name
  and q.locked_at is not null;

-- update add_job behaviour to meet new requirements
drop function if exists :GRAPHILE_WORKER_SCHEMA.add_job(
  identifier text,
  payload json,
  queue_name text,
  run_at timestamptz,
  max_attempts int
);
create function :GRAPHILE_WORKER_SCHEMA.add_job(
  identifier text,
  payload json = '{}',
  queue_name text = null,
  run_at timestamptz = now(),
  max_attempts int = 25,
  job_key text = null
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  if job_key is not null then
    -- Upsert job
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (task_identifier, payload, queue_name, run_at, max_attempts, key)
      values(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts,
        job_key
      )
      on conflict (key) do update set
        -- update all job details other than queue_name, which we want to keep
        -- the same unless explicitly provided
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=coalesce(add_job.queue_name, jobs.queue_name),
        max_attempts=excluded.max_attempts,
        run_at=excluded.run_at,

        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;

    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;

    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries by bumping attempts to the max allowed.
    update :GRAPHILE_WORKER_SCHEMA.jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  end if;

  -- insert the new job. Assume no conflicts due to the update above
  insert into :GRAPHILE_WORKER_SCHEMA.jobs(task_identifier, payload, queue_name, run_at, max_attempts, key)
    values(
      identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      job_key
    )
    returning *
    into v_job;

  return v_job;
end;
$$ language plpgsql volatile;

--- implement new remove_job function

create function :GRAPHILE_WORKER_SCHEMA.remove_job(
  job_key text
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
  delete from :GRAPHILE_WORKER_SCHEMA.jobs
    where key = job_key
    and locked_at is null
  returning *;
$$ language sql strict volatile;

-- Update other functions to handle locked_at denormalisation

create or replace function :GRAPHILE_WORKER_SCHEMA.get_job(worker_id text, task_identifiers text[] = null, job_expiry interval = interval '4 hours') returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
  v_now timestamptz = now();
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select job_queues.queue_name, jobs.id into v_queue_name, v_job_id
    from :GRAPHILE_WORKER_SCHEMA.jobs
    inner join :GRAPHILE_WORKER_SCHEMA.job_queues using (queue_name)
    where (job_queues.locked_at is null or job_queues.locked_at < (v_now - job_expiry))
    and run_at <= v_now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    order by priority asc, run_at asc, id asc
    limit 1
    for update of job_queues
    skip locked;

  if v_queue_name is null then
    return null;
  end if;

  update :GRAPHILE_WORKER_SCHEMA.job_queues
    set
      locked_by = worker_id,
      locked_at = v_now
    where job_queues.queue_name = v_queue_name;

  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = v_now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql volatile;

-- I was unsuccessful, re-schedule the job please
create or replace function :GRAPHILE_WORKER_SCHEMA.fail_job(worker_id text, job_id bigint, error_message text) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      last_error = error_message,
      run_at = greatest(now(), run_at) + (exp(least(attempts, 10))::text || ' seconds')::interval,
      locked_by = null,
      locked_at = null
    where id = job_id and locked_by = worker_id
    returning * into v_row;

  update :GRAPHILE_WORKER_SCHEMA.job_queues
    set locked_by = null, locked_at = null
    where queue_name = v_row.queue_name and locked_by = worker_id;

  return v_row;
end;
$$ language plpgsql volatile strict;
`;
export const sql_000003 = `alter table :GRAPHILE_WORKER_SCHEMA.jobs alter column queue_name drop not null;

create or replace function :GRAPHILE_WORKER_SCHEMA.add_job(
  identifier text,
  payload json = '{}',
  queue_name text = null,
  run_at timestamptz = now(),
  max_attempts int = 25,
  job_key text = null
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  if job_key is not null then
    -- Upsert job
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (task_identifier, payload, queue_name, run_at, max_attempts, key)
      values(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts,
        job_key
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=excluded.run_at,

        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;

    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;

    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries by bumping attempts to the max allowed.
    update :GRAPHILE_WORKER_SCHEMA.jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  end if;

  -- insert the new job. Assume no conflicts due to the update above
  insert into :GRAPHILE_WORKER_SCHEMA.jobs(task_identifier, payload, queue_name, run_at, max_attempts, key)
    values(
      identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      job_key
    )
    returning *
    into v_job;

  return v_job;
end;
$$ language plpgsql volatile;

create or replace function :GRAPHILE_WORKER_SCHEMA.get_job(worker_id text, task_identifiers text[] = null, job_expiry interval = interval '4 hours') returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
  v_now timestamptz = now();
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select jobs.queue_name, jobs.id into v_queue_name, v_job_id
    from :GRAPHILE_WORKER_SCHEMA.jobs
    where (jobs.locked_at is null or jobs.locked_at < (v_now - job_expiry))
    and (
      jobs.queue_name is null
    or
      exists (
        select 1
        from :GRAPHILE_WORKER_SCHEMA.job_queues
        where job_queues.queue_name = jobs.queue_name
        and (job_queues.locked_at is null or job_queues.locked_at < (v_now - job_expiry))
        for update
        skip locked
      )
    )
    and run_at <= v_now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    order by priority asc, run_at asc, id asc
    limit 1
    for update
    skip locked;

  if v_job_id is null then
    return null;
  end if;

  if v_queue_name is not null then
    update :GRAPHILE_WORKER_SCHEMA.job_queues
      set
        locked_by = worker_id,
        locked_at = v_now
      where job_queues.queue_name = v_queue_name;
  end if;

  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = v_now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql volatile;

create or replace function :GRAPHILE_WORKER_SCHEMA.fail_job(worker_id text, job_id bigint, error_message text) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      last_error = error_message,
      run_at = greatest(now(), run_at) + (exp(least(attempts, 10))::text || ' seconds')::interval,
      locked_by = null,
      locked_at = null
    where id = job_id and locked_by = worker_id
    returning * into v_row;

  if v_row.queue_name is not null then
    update :GRAPHILE_WORKER_SCHEMA.job_queues
      set locked_by = null, locked_at = null
      where queue_name = v_row.queue_name and locked_by = worker_id;
  end if;

  return v_row;
end;
$$ language plpgsql volatile strict;

create or replace function :GRAPHILE_WORKER_SCHEMA.complete_job(worker_id text, job_id bigint) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  delete from :GRAPHILE_WORKER_SCHEMA.jobs
    where id = job_id
    returning * into v_row;

  if v_row.queue_name is not null then
    update :GRAPHILE_WORKER_SCHEMA.job_queues
      set locked_by = null, locked_at = null
      where queue_name = v_row.queue_name and locked_by = worker_id;
  end if;

  return v_row;
end;
$$ language plpgsql;

drop trigger _500_increase_job_queue_count on :GRAPHILE_WORKER_SCHEMA.jobs;
drop trigger _500_decrease_job_queue_count on :GRAPHILE_WORKER_SCHEMA.jobs;
drop trigger _500_increase_job_queue_count_update on :GRAPHILE_WORKER_SCHEMA.jobs;
drop trigger _500_decrease_job_queue_count_update on :GRAPHILE_WORKER_SCHEMA.jobs;
create trigger _500_increase_job_queue_count after insert on :GRAPHILE_WORKER_SCHEMA.jobs for each row when (NEW.queue_name is not null) execute procedure :GRAPHILE_WORKER_SCHEMA.jobs__increase_job_queue_count();
create trigger _500_decrease_job_queue_count after delete on :GRAPHILE_WORKER_SCHEMA.jobs for each row when (OLD.queue_name is not null) execute procedure :GRAPHILE_WORKER_SCHEMA.jobs__decrease_job_queue_count();
create trigger _500_increase_job_queue_count_update after update of queue_name on :GRAPHILE_WORKER_SCHEMA.jobs for each row when (NEW.queue_name is distinct from OLD.queue_name AND NEW.queue_name is not null) execute procedure :GRAPHILE_WORKER_SCHEMA.jobs__increase_job_queue_count();
create trigger _500_decrease_job_queue_count_update after update of queue_name on :GRAPHILE_WORKER_SCHEMA.jobs for each row when (NEW.queue_name is distinct from OLD.queue_name AND OLD.queue_name is not null) execute procedure :GRAPHILE_WORKER_SCHEMA.jobs__decrease_job_queue_count();
`;
export const sql_000004 = `drop function :GRAPHILE_WORKER_SCHEMA.add_job(text, json, text, timestamptz, int, text);

create function :GRAPHILE_WORKER_SCHEMA.add_job(
  identifier text,
  payload json = null,
  queue_name text = null,
  run_at timestamptz = null,
  max_attempts int = null,
  job_key text = null,
  priority int = null
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  -- Apply rationality checks
  if length(identifier) > 128 then
    raise exception 'Task identifier is too long (max length: 128).' using errcode = 'GWBID';
  end if;
  if queue_name is not null and length(queue_name) > 128 then
    raise exception 'Job queue name is too long (max length: 128).' using errcode = 'GWBQN';
  end if;
  if job_key is not null and length(job_key) > 512 then
    raise exception 'Job key is too long (max length: 512).' using errcode = 'GWBJK';
  end if;
  if max_attempts < 1 then
    raise exception 'Job maximum attempts must be at least 1' using errcode = 'GWBMA';
  end if;

  if job_key is not null then
    -- Upsert job
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0)
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=excluded.run_at,
        priority=excluded.priority,

        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;

    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;

    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries by bumping attempts to the max allowed.
    update :GRAPHILE_WORKER_SCHEMA.jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  end if;

  -- insert the new job. Assume no conflicts due to the update above
  insert into :GRAPHILE_WORKER_SCHEMA.jobs(
    task_identifier,
    payload,
    queue_name,
    run_at,
    max_attempts,
    key,
    priority
  )
    values(
      identifier,
      coalesce(payload, '{}'::json),
      queue_name,
      coalesce(run_at, now()),
      coalesce(max_attempts, 25),
      job_key,
      coalesce(priority, 0)
    )
    returning *
    into v_job;

  return v_job;
end;
$$ language plpgsql volatile;

create function :GRAPHILE_WORKER_SCHEMA.complete_jobs(
  job_ids bigint[]
) returns setof :GRAPHILE_WORKER_SCHEMA.jobs as $$
  delete from :GRAPHILE_WORKER_SCHEMA.jobs
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql volatile;

create function :GRAPHILE_WORKER_SCHEMA.permanently_fail_jobs(
  job_ids bigint[],
  error_message text = null
) returns setof :GRAPHILE_WORKER_SCHEMA.jobs as $$
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      last_error = coalesce(error_message, 'Manually marked as failed'),
      attempts = max_attempts
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql volatile;

create function :GRAPHILE_WORKER_SCHEMA.reschedule_jobs(
  job_ids bigint[],
  run_at timestamptz = null,
  priority int = null,
  attempts int = null,
  max_attempts int = null
) returns setof :GRAPHILE_WORKER_SCHEMA.jobs as $$
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts, jobs.max_attempts)
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql volatile;
`;
export const sql_000005 = `alter table :GRAPHILE_WORKER_SCHEMA.jobs add column revision int default 0 not null;
alter table :GRAPHILE_WORKER_SCHEMA.jobs add column flags jsonb default null;

drop function :GRAPHILE_WORKER_SCHEMA.add_job(text, json, text, timestamptz, int, text, int);
create function :GRAPHILE_WORKER_SCHEMA.add_job(
  identifier text,
  payload json = null,
  queue_name text = null,
  run_at timestamptz = null,
  max_attempts int = null,
  job_key text = null,
  priority int = null,
  flags text[] = null
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  -- Apply rationality checks
  if length(identifier) > 128 then
    raise exception 'Task identifier is too long (max length: 128).' using errcode = 'GWBID';
  end if;
  if queue_name is not null and length(queue_name) > 128 then
    raise exception 'Job queue name is too long (max length: 128).' using errcode = 'GWBQN';
  end if;
  if job_key is not null and length(job_key) > 512 then
    raise exception 'Job key is too long (max length: 512).' using errcode = 'GWBJK';
  end if;
  if max_attempts < 1 then
    raise exception 'Job maximum attempts must be at least 1' using errcode = 'GWBMA';
  end if;

  if job_key is not null then
    -- Upsert job
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(flags) as item(flag)
        )
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=excluded.run_at,
        priority=excluded.priority,
        revision=jobs.revision + 1,
        flags=excluded.flags,

        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;

    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;

    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries by bumping attempts to the max allowed.
    update :GRAPHILE_WORKER_SCHEMA.jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  end if;

  -- insert the new job. Assume no conflicts due to the update above
  insert into :GRAPHILE_WORKER_SCHEMA.jobs(
    task_identifier,
    payload,
    queue_name,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    values(
      identifier,
      coalesce(payload, '{}'::json),
      queue_name,
      coalesce(run_at, now()),
      coalesce(max_attempts, 25),
      job_key,
      coalesce(priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(flags) as item(flag)
      )
    )
    returning *
    into v_job;

  return v_job;
end;
$$ language plpgsql volatile;

drop function :GRAPHILE_WORKER_SCHEMA.get_job(text, text[], interval);
create function :GRAPHILE_WORKER_SCHEMA.get_job(
  worker_id text,
  task_identifiers text[] = null,
  job_expiry interval = interval '4 hours',
  forbidden_flags text[] = null
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
  v_now timestamptz = now();
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select jobs.queue_name, jobs.id into v_queue_name, v_job_id
    from :GRAPHILE_WORKER_SCHEMA.jobs
    where (jobs.locked_at is null or jobs.locked_at < (v_now - job_expiry))
    and (
      jobs.queue_name is null
    or
      exists (
        select 1
        from :GRAPHILE_WORKER_SCHEMA.job_queues
        where job_queues.queue_name = jobs.queue_name
        and (job_queues.locked_at is null or job_queues.locked_at < (v_now - job_expiry))
        for update
        skip locked
      )
    )
    and run_at <= v_now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    and (forbidden_flags is null or (flags ?| forbidden_flags) is not true)
    order by priority asc, run_at asc, id asc
    limit 1
    for update
    skip locked;

  if v_job_id is null then
    return null;
  end if;

  if v_queue_name is not null then
    update :GRAPHILE_WORKER_SCHEMA.job_queues
      set
        locked_by = worker_id,
        locked_at = v_now
      where job_queues.queue_name = v_queue_name;
  end if;

  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = v_now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql volatile;

`;
export const sql_000006 = `create index jobs_priority_run_at_id_locked_at_without_failures_idx
  on :GRAPHILE_WORKER_SCHEMA.jobs (priority, run_at, id, locked_at)
  where attempts < max_attempts;

drop index :GRAPHILE_WORKER_SCHEMA.jobs_priority_run_at_id_idx;

`;
export const sql_000007 = `drop function :GRAPHILE_WORKER_SCHEMA.add_job(text, json, text, timestamptz, int, text, int, text[]);
create function :GRAPHILE_WORKER_SCHEMA.add_job(
  identifier text,
  payload json = null,
  queue_name text = null,
  run_at timestamptz = null,
  max_attempts integer = null,
  job_key text = null,
  priority integer = null,
  flags text[] = null,
  job_key_mode text = 'replace'
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  -- Apply rationality checks
  if length(identifier) > 128 then
    raise exception 'Task identifier is too long (max length: 128).' using errcode = 'GWBID';
  end if;
  if queue_name is not null and length(queue_name) > 128 then
    raise exception 'Job queue name is too long (max length: 128).' using errcode = 'GWBQN';
  end if;
  if job_key is not null and length(job_key) > 512 then
    raise exception 'Job key is too long (max length: 512).' using errcode = 'GWBJK';
  end if;
  if max_attempts < 1 then
    raise exception 'Job maximum attempts must be at least 1.' using errcode = 'GWBMA';
  end if;
  if job_key is not null and (job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    -- Upsert job if existing job isn't locked, but in the case of locked
    -- existing job create a new job instead as it must have already started
    -- executing (i.e. it's world state is out of date, and the fact add_job
    -- has been called again implies there's new information that needs to be
    -- acted upon).
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(flags) as item(flag)
        )
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=(case
          when job_key_mode = 'preserve_run_at' and jobs.attempts = 0 then jobs.run_at
          else excluded.run_at
        end),
        priority=excluded.priority,
        revision=jobs.revision + 1,
        flags=excluded.flags,
        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;
    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;
    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries of existing job by bumping attempts to the max
    -- allowed.
    update :GRAPHILE_WORKER_SCHEMA.jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  elsif job_key is not null and job_key_mode = 'unsafe_dedupe' then
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(flags) as item(flag)
        )
      )
      on conflict (key)
      -- Bump the revision so that there's something to return
      do update set revision = jobs.revision + 1
      returning *
      into v_job;
    return v_job;
  elsif job_key is not null then
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
  -- insert the new job. Assume no conflicts due to the update above
  insert into :GRAPHILE_WORKER_SCHEMA.jobs(
    task_identifier,
    payload,
    queue_name,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    values(
      identifier,
      coalesce(payload, '{}'::json),
      queue_name,
      coalesce(run_at, now()),
      coalesce(max_attempts, 25),
      job_key,
      coalesce(priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(flags) as item(flag)
      )
    )
    returning *
    into v_job;
  return v_job;
end;
$$ language plpgsql volatile;

create or replace function :GRAPHILE_WORKER_SCHEMA.remove_job(job_key text)
returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  -- Delete job if not locked
  delete from :GRAPHILE_WORKER_SCHEMA.jobs
    where key = job_key
    and locked_at is null
  returning * into v_job;
  if not (v_job is null) then
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set attempts = max_attempts, key = null
    where key = job_key
  returning * into v_job;
  return v_job;
end;
$$ language plpgsql strict;
`;
export const sql_000008 = `create table :GRAPHILE_WORKER_SCHEMA.known_crontabs (
  identifier text not null primary key,
  known_since timestamptz not null,
  last_execution timestamptz
);
alter table :GRAPHILE_WORKER_SCHEMA.known_crontabs enable row level security;
`;
export const sql_000009 = `drop function :GRAPHILE_WORKER_SCHEMA.get_job(text, text[], interval, text[]);
create function :GRAPHILE_WORKER_SCHEMA.get_job(
  worker_id text,
  task_identifiers text[] = null,
  job_expiry interval = interval '4 hours',
  forbidden_flags text[] = null,
  now timestamptz = now()
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select jobs.queue_name, jobs.id into v_queue_name, v_job_id
    from :GRAPHILE_WORKER_SCHEMA.jobs
    where (jobs.locked_at is null or jobs.locked_at < (now - job_expiry))
    and (
      jobs.queue_name is null
    or
      exists (
        select 1
        from :GRAPHILE_WORKER_SCHEMA.job_queues
        where job_queues.queue_name = jobs.queue_name
        and (job_queues.locked_at is null or job_queues.locked_at < (now - job_expiry))
        for update
        skip locked
      )
    )
    and run_at <= now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    and (forbidden_flags is null or (flags ?| forbidden_flags) is not true)
    order by priority asc, run_at asc, id asc
    limit 1
    for update
    skip locked;

  if v_job_id is null then
    return null;
  end if;

  if v_queue_name is not null then
    update :GRAPHILE_WORKER_SCHEMA.job_queues
      set
        locked_by = worker_id,
        locked_at = now
      where job_queues.queue_name = v_queue_name;
  end if;

  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql volatile;
`;
export const sql_000010 = `alter table :GRAPHILE_WORKER_SCHEMA.jobs alter column queue_name drop default;
`;
export const sql_000011 = `lock table :GRAPHILE_WORKER_SCHEMA.jobs;
lock table :GRAPHILE_WORKER_SCHEMA.job_queues;

-- If there's any locked jobs, abort via division by zero
select 1/(case when exists (
  select 1
  from :GRAPHILE_WORKER_SCHEMA.jobs
  where locked_at is not null
  and locked_at > NOW() - interval '4 hours'
) then 0 else 1 end);

alter table :GRAPHILE_WORKER_SCHEMA.jobs
alter column attempts type int2,
alter column max_attempts type int2,
alter column priority type int2;


drop function :GRAPHILE_WORKER_SCHEMA.complete_job;
drop function :GRAPHILE_WORKER_SCHEMA.fail_job;
drop function :GRAPHILE_WORKER_SCHEMA.get_job;



drop trigger _900_notify_worker on :GRAPHILE_WORKER_SCHEMA.jobs;
drop function :GRAPHILE_WORKER_SCHEMA.add_job;
drop function :GRAPHILE_WORKER_SCHEMA.complete_jobs;
drop function :GRAPHILE_WORKER_SCHEMA.permanently_fail_jobs;
drop function :GRAPHILE_WORKER_SCHEMA.remove_job;
drop function :GRAPHILE_WORKER_SCHEMA.reschedule_jobs;
drop function :GRAPHILE_WORKER_SCHEMA.tg_jobs__notify_new_jobs;
alter table :GRAPHILE_WORKER_SCHEMA.jobs rename to jobs_legacy;
alter table :GRAPHILE_WORKER_SCHEMA.job_queues rename to job_queues_legacy;

create table :GRAPHILE_WORKER_SCHEMA.job_queues (
  id int primary key generated always as identity,
  queue_name text not null unique check (length(queue_name) <= 128),
  locked_at timestamptz,
  locked_by text,
  is_available boolean generated always as ((locked_at is null)) stored not null
);
alter table :GRAPHILE_WORKER_SCHEMA.job_queues enable row level security;

create table :GRAPHILE_WORKER_SCHEMA.tasks (
  id int primary key generated always as identity,
  identifier text not null unique check (length(identifier) <= 128)
);
alter table :GRAPHILE_WORKER_SCHEMA.tasks enable row level security;

create table :GRAPHILE_WORKER_SCHEMA.jobs (
  id bigint primary key generated always as identity,
  job_queue_id int null, -- not adding 'references' to eke out more performance
  task_id int not null,
  payload json default '{}'::json not null,
  priority smallint default 0 not null,
  run_at timestamptz default now() not null,
  attempts smallint default 0 not null,
  max_attempts smallint default 25 not null constraint jobs_max_attempts_check check (max_attempts >= 1),
  last_error text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  key text unique constraint jobs_key_check check (length(key) > 0 and length(key) <= 512),
  locked_at timestamptz,
  locked_by text,
  revision integer default 0 not null,
  flags jsonb,
  is_available boolean generated always as (((locked_at is null) and (attempts < max_attempts))) stored not null
);
alter table :GRAPHILE_WORKER_SCHEMA.jobs enable row level security;

create index jobs_main_index
  on :GRAPHILE_WORKER_SCHEMA.jobs
  using btree (priority, run_at)
  include (id, task_id, job_queue_id)
  where (is_available = true);

create index jobs_no_queue_index
  on :GRAPHILE_WORKER_SCHEMA.jobs
  using btree (priority, run_at)
  include (id, task_id)
  where (is_available = true and job_queue_id is null);

create type :GRAPHILE_WORKER_SCHEMA.job_spec as (
  identifier text,
  payload json,
  queue_name text,
  run_at timestamptz,
  max_attempts integer,
  job_key text,
  priority integer,
  flags text[]
);

create function :GRAPHILE_WORKER_SCHEMA.add_jobs(
  specs :GRAPHILE_WORKER_SCHEMA.job_spec[],
  job_key_preserve_run_at boolean default false
)
returns setof :GRAPHILE_WORKER_SCHEMA.jobs
as $$
begin
  -- Ensure all the tasks exist
  insert into :GRAPHILE_WORKER_SCHEMA.tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  on conflict do nothing;

  -- Ensure all the queues exist
  insert into :GRAPHILE_WORKER_SCHEMA.job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  on conflict do nothing;

  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update :GRAPHILE_WORKER_SCHEMA.jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;

  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?

  return query insert into :GRAPHILE_WORKER_SCHEMA.jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join :GRAPHILE_WORKER_SCHEMA.tasks
    on tasks.identifier = spec.identifier
    left join :GRAPHILE_WORKER_SCHEMA.job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload = excluded.payload,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$ language plpgsql;

create function :GRAPHILE_WORKER_SCHEMA.complete_jobs(job_ids bigint[])
returns setof :GRAPHILE_WORKER_SCHEMA.jobs
as $$
  delete from :GRAPHILE_WORKER_SCHEMA.jobs
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < now() - interval '4 hours'
    )
    returning *;
$$ language sql;

create function :GRAPHILE_WORKER_SCHEMA.permanently_fail_jobs(
  job_ids bigint[],
  error_message text default null::text
)
returns setof :GRAPHILE_WORKER_SCHEMA.jobs
as $$
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      last_error = coalesce(error_message, 'Manually marked as failed'),
      attempts = max_attempts,
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql;

create function :GRAPHILE_WORKER_SCHEMA.remove_job(job_key text)
returns :GRAPHILE_WORKER_SCHEMA.jobs
as $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  -- Delete job if not locked
  delete from :GRAPHILE_WORKER_SCHEMA.jobs
    where key = job_key
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
  returning * into v_job;
  if not (v_job is null) then
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update :GRAPHILE_WORKER_SCHEMA.jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  where key = job_key
  returning * into v_job;
  return v_job;
end;
$$ language plpgsql strict;

create function :GRAPHILE_WORKER_SCHEMA.reschedule_jobs(
  job_ids bigint[],
  run_at timestamp with time zone default null::timestamp with time zone,
  priority integer default null::integer,
  attempts integer default null::integer,
  max_attempts integer default null::integer
) returns setof :GRAPHILE_WORKER_SCHEMA.jobs
as $$
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql;

create function :GRAPHILE_WORKER_SCHEMA.tg_jobs__after_insert() returns trigger
as $$
begin
  perform pg_notify('jobs:insert', '');
  return new;
end;
$$ language plpgsql;
create trigger _900_after_insert
after insert on :GRAPHILE_WORKER_SCHEMA.jobs
for each statement
execute procedure :GRAPHILE_WORKER_SCHEMA.tg_jobs__after_insert();

create function :GRAPHILE_WORKER_SCHEMA.add_job(
  identifier text,
  payload json default null::json,
  queue_name text default null::text,
  run_at timestamp with time zone default null::timestamp with time zone,
  max_attempts integer default null::integer,
  job_key text default null::text,
  priority integer default null::integer,
  flags text[] default null::text[],
  job_key_mode text default 'replace'::text
) returns :GRAPHILE_WORKER_SCHEMA.jobs as $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from :GRAPHILE_WORKER_SCHEMA.add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts,
        job_key,
        priority,
        flags
      ):::GRAPHILE_WORKER_SCHEMA.job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into :GRAPHILE_WORKER_SCHEMA.tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;

    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into :GRAPHILE_WORKER_SCHEMA.job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;

    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts, 25),
        add_job.job_key,
        coalesce(add_job.priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from :GRAPHILE_WORKER_SCHEMA.tasks
      left join :GRAPHILE_WORKER_SCHEMA.job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$ language plpgsql;

-- Migrate over the old tables
insert into :GRAPHILE_WORKER_SCHEMA.job_queues (queue_name)
select distinct queue_name
from :GRAPHILE_WORKER_SCHEMA.jobs_legacy
where queue_name is not null
on conflict do nothing;

insert into :GRAPHILE_WORKER_SCHEMA.tasks (identifier)
select distinct task_identifier
from :GRAPHILE_WORKER_SCHEMA.jobs_legacy
on conflict do nothing;

insert into :GRAPHILE_WORKER_SCHEMA.jobs (
  job_queue_id,
  task_id,
  payload,
  priority,
  run_at,
  attempts,
  max_attempts,
  last_error,
  created_at,
  updated_at,
  key,
  revision,
  flags
)
  select
    job_queues.id,
    tasks.id,
    legacy.payload,
    legacy.priority,
    legacy.run_at,
    legacy.attempts,
    legacy.max_attempts,
    legacy.last_error,
    legacy.created_at,
    legacy.updated_at,
    legacy.key,
    legacy.revision,
    legacy.flags
  from :GRAPHILE_WORKER_SCHEMA.jobs_legacy legacy
  inner join :GRAPHILE_WORKER_SCHEMA.tasks
  on tasks.identifier = legacy.task_identifier
  left join :GRAPHILE_WORKER_SCHEMA.job_queues
  on job_queues.queue_name = legacy.queue_name;

drop table :GRAPHILE_WORKER_SCHEMA.jobs_legacy;
drop table :GRAPHILE_WORKER_SCHEMA.job_queues_legacy;

`;
export const sql_000012 = `create or replace function :GRAPHILE_WORKER_SCHEMA.add_jobs(
  specs :GRAPHILE_WORKER_SCHEMA.job_spec[],
  job_key_preserve_run_at boolean default false
)
returns setof :GRAPHILE_WORKER_SCHEMA.jobs
as $$
begin
  -- Ensure all the tasks exist
  insert into :GRAPHILE_WORKER_SCHEMA.tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  on conflict do nothing;

  -- Ensure all the queues exist
  insert into :GRAPHILE_WORKER_SCHEMA.job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  on conflict do nothing;

  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update :GRAPHILE_WORKER_SCHEMA.jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;

  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?

  return query insert into :GRAPHILE_WORKER_SCHEMA.jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join :GRAPHILE_WORKER_SCHEMA.tasks
    on tasks.identifier = spec.identifier
    left join :GRAPHILE_WORKER_SCHEMA.job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload =
      case
      when json_typeof(jobs.payload) = 'array' and json_typeof(excluded.payload) = 'array' then
        (jobs.payload::jsonb || excluded.payload::jsonb)::json
      else
        excluded.payload
      end,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$ language plpgsql;
`;
export const sql_000013 = `alter type :GRAPHILE_WORKER_SCHEMA.job_spec alter attribute max_attempts type smallint;
alter type :GRAPHILE_WORKER_SCHEMA.job_spec alter attribute priority type smallint;

drop function :GRAPHILE_WORKER_SCHEMA.add_job;
CREATE FUNCTION :GRAPHILE_WORKER_SCHEMA.add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts smallint DEFAULT NULL::smallint, job_key text DEFAULT NULL::text, priority smallint DEFAULT NULL::smallint, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS :GRAPHILE_WORKER_SCHEMA.jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from :GRAPHILE_WORKER_SCHEMA.add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts,
        job_key,
        priority,
        flags
      ):::GRAPHILE_WORKER_SCHEMA.job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into :GRAPHILE_WORKER_SCHEMA.tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into :GRAPHILE_WORKER_SCHEMA.job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts, 25),
        add_job.job_key,
        coalesce(add_job.priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from :GRAPHILE_WORKER_SCHEMA.tasks
      left join :GRAPHILE_WORKER_SCHEMA.job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;

DROP FUNCTION :GRAPHILE_WORKER_SCHEMA.reschedule_jobs;
CREATE FUNCTION :GRAPHILE_WORKER_SCHEMA.reschedule_jobs(job_ids bigint[], run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, priority smallint DEFAULT NULL::smallint, attempts smallint DEFAULT NULL::smallint, max_attempts smallint DEFAULT NULL::smallint) RETURNS SETOF :GRAPHILE_WORKER_SCHEMA.jobs
    LANGUAGE sql
    AS $$
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;
`;
export const sql_000014 = `-- Go back to exposing 'int' on public interfaces, use smallint internally.

drop function :GRAPHILE_WORKER_SCHEMA.add_job;
CREATE FUNCTION :GRAPHILE_WORKER_SCHEMA.add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts int DEFAULT NULL::int, job_key text DEFAULT NULL::text, priority int DEFAULT NULL::int, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS :GRAPHILE_WORKER_SCHEMA.jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job :GRAPHILE_WORKER_SCHEMA.jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from :GRAPHILE_WORKER_SCHEMA.add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts::smallint,
        job_key,
        priority::smallint,
        flags
      ):::GRAPHILE_WORKER_SCHEMA.job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into :GRAPHILE_WORKER_SCHEMA.tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into :GRAPHILE_WORKER_SCHEMA.job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into :GRAPHILE_WORKER_SCHEMA.jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts::smallint, 25::smallint),
        add_job.job_key,
        coalesce(add_job.priority::smallint, 0::smallint),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from :GRAPHILE_WORKER_SCHEMA.tasks
      left join :GRAPHILE_WORKER_SCHEMA.job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;

DROP FUNCTION :GRAPHILE_WORKER_SCHEMA.reschedule_jobs;
CREATE FUNCTION :GRAPHILE_WORKER_SCHEMA.reschedule_jobs(job_ids bigint[], run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, priority int DEFAULT NULL::int, attempts int DEFAULT NULL::int, max_attempts int DEFAULT NULL::int) RETURNS SETOF :GRAPHILE_WORKER_SCHEMA.jobs
    LANGUAGE sql
    AS $$
  update :GRAPHILE_WORKER_SCHEMA.jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority::smallint, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts::smallint, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts::smallint, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;
`;
