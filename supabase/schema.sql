-- 자산관리 앱 데이터베이스. Supabase SQL 편집기나 Claude가 한 번 실행해요.

-- 가족 명단: 여기 있는 이메일만 데이터를 보고 고칠 수 있어요.
create table if not exists public.members (
  email text primary key
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where lower(email) = lower(auth.jwt() ->> 'email'));
$$;
grant execute on function public.is_member() to authenticated;

-- 자산 한 건 = 한 줄. 내용(종류, 증권사, 수량 등)은 data에 JSON으로.
create table if not exists public.assets (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- 종목별 소식 요약 (Claude가 매일 갱신)
create table if not exists public.news (
  symbol text primary key,
  data jsonb not null,
  as_of date not null
);

-- 시세 캐시 (시세 서버 함수만 씀)
create table if not exists public.quotes (
  symbol text primary key,
  price numeric not null,
  session text, -- 장전·장후 가격이면 pre/post
  fetched_at timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); new.updated_by = auth.uid(); return new; end $$;
drop trigger if exists assets_touch on public.assets;
create trigger assets_touch before update on public.assets for each row execute function public.touch_updated_at();

alter table public.members enable row level security;
alter table public.assets enable row level security;
alter table public.news enable row level security;
alter table public.quotes enable row level security;

drop policy if exists "family reads assets" on public.assets;
drop policy if exists "family writes assets" on public.assets;
create policy "family reads assets" on public.assets for select to authenticated using (public.is_member());
create policy "family writes assets" on public.assets for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "family reads news" on public.news;
create policy "family reads news" on public.news for select to authenticated using (public.is_member());
-- members, quotes: 정책 없음 = 앱에서 직접 읽거나 쓸 수 없음

-- 배우자가 고친 내용이 바로 보이도록
do $$ begin
  alter publication supabase_realtime add table public.assets;
exception when duplicate_object then null; end $$;

-- 부동산: 매일 아침 예약 작업이 조사해 넣음(budget 1행, watch 관심 단지, pick 오늘의 추천)
create table if not exists public.homes (
  id text primary key,
  kind text not null check (kind in ('watch','pick','budget')),
  data jsonb not null,
  as_of date not null default current_date,
  updated_at timestamptz not null default now()
);
alter table public.homes enable row level security;
create policy homes_read on public.homes for select to authenticated using (public.is_member());

-- 국토부 실거래 API 응답 캐시(trades 함수만 씀)
create table if not exists public.molit_cache (
  key text primary key,
  body jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.molit_cache enable row level security;
alter table public.quotes add column if not exists prev numeric; -- 전날 종가
alter table public.quotes add column if not exists hi2y numeric, add column if not exists hi_at timestamptz;
