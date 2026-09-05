-- Supabase SQL Editor에서 한 번 실행합니다.
create table if not exists public.lol_daily_status (
  date_kst date primary key,
  issue_count integer not null check (issue_count >= 0),
  status text not null,
  issue_title text not null default '',
  source_url text not null,
  source_time timestamptz null,
  checked_at timestamptz not null,
  raw_excerpt text not null default ''
);

-- 브라우저에서 DB를 직접 호출하지 않습니다.
-- 따라서 RLS를 켜고 공개 정책은 만들지 않아도 됩니다.
alter table public.lol_daily_status enable row level security;

create index if not exists lol_daily_status_checked_at_idx
on public.lol_daily_status (checked_at desc);
