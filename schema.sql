-- Treino — schema do Supabase
-- Rode isto uma vez no painel: Supabase > SQL Editor > New query > cole > Run.
--
-- Modelo: chave-valor por usuário, espelhando o localStorage do app.
--   k = "t:<dia>:<i>" (séries do exercício), "w:<aaaa-mm-dd>" (água), "exams" (checklist)
--   v = jsonb (array de séries, número de ml, ou objeto de exames)
-- RLS garante que cada usuário só enxerga e altera as próprias linhas.

create table if not exists public.app_kv (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  k          text        not null,
  v          jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, k)
);

alter table public.app_kv enable row level security;

drop policy if exists "app_kv select own" on public.app_kv;
drop policy if exists "app_kv insert own" on public.app_kv;
drop policy if exists "app_kv update own" on public.app_kv;
drop policy if exists "app_kv delete own" on public.app_kv;

create policy "app_kv select own" on public.app_kv
  for select using (auth.uid() = user_id);

create policy "app_kv insert own" on public.app_kv
  for insert with check (auth.uid() = user_id);

create policy "app_kv update own" on public.app_kv
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "app_kv delete own" on public.app_kv
  for delete using (auth.uid() = user_id);


-- ===== IA: controle de uso diário por usuário =====
-- A Edge Function "coach" escreve aqui (service role, ignora RLS) pra limitar chamadas.
-- O usuário só consegue LER o próprio uso; ninguém zera o contador pelo app.

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

drop policy if exists "ai_usage select own" on public.ai_usage;
create policy "ai_usage select own" on public.ai_usage
  for select using (auth.uid() = user_id);
