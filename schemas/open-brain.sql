create extension if not exists vector;

create table if not exists thoughts (
  id uuid default gen_random_uuid() primary key,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_thoughts_embedding
  on thoughts using hnsw (embedding vector_cosine_ops);

create index if not exists idx_thoughts_metadata
  on thoughts using gin (metadata);

create index if not exists idx_thoughts_created_at
  on thoughts (created_at desc);

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists thoughts_updated_at on thoughts;

create trigger thoughts_updated_at
  before update on thoughts
  for each row
  execute function update_updated_at();

create or replace function match_thoughts(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

alter table thoughts enable row level security;

drop policy if exists "Service role full access" on thoughts;

create policy "Service role full access"
  on thoughts
  for all
  using (auth.role() = 'service_role');

grant select, insert, update, delete on table public.thoughts to service_role;

alter table thoughts add column if not exists content_fingerprint text;

create unique index if not exists idx_thoughts_fingerprint
  on thoughts (content_fingerprint)
  where content_fingerprint is not null;

create or replace function upsert_thought(
  p_content text,
  p_payload jsonb default '{}'
)
returns jsonb as $$
declare
  v_fingerprint text;
  v_result jsonb;
  v_id uuid;
begin
  v_fingerprint := encode(
    sha256(convert_to(lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8')),
    'hex'
  );

  insert into thoughts (content, content_fingerprint, metadata)
  values (p_content, v_fingerprint, coalesce(p_payload->'metadata', '{}'::jsonb))
  on conflict (content_fingerprint) where content_fingerprint is not null do update
  set updated_at = now(),
      metadata = thoughts.metadata || coalesce(excluded.metadata, '{}'::jsonb)
  returning id into v_id;

  v_result := jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
  return v_result;
end;
$$ language plpgsql;
