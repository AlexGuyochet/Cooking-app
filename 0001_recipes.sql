-- Cookbook : table des recettes, chaque utilisateur ne voit que les siennes.

create table if not exists public.recipes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 200),
  servings        integer check (servings >= 0),
  prep_minutes    integer check (prep_minutes >= 0),
  cook_minutes    integer check (cook_minutes >= 0),
  ingredients     text[] not null default '{}',
  steps           text[] not null default '{}',
  tags            text[] not null default '{}',
  source_url      text,
  source_platform text,
  raw_caption     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists recipes_user_created_idx
  on public.recipes (user_id, created_at desc);

-- Mise à jour automatique de updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists recipes_touch on public.recipes;
create trigger recipes_touch
  before update on public.recipes
  for each row execute function public.touch_updated_at();

-- Sécurité : Row Level Security
alter table public.recipes enable row level security;

drop policy if exists "Lire ses recettes" on public.recipes;
create policy "Lire ses recettes" on public.recipes
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Ajouter ses recettes" on public.recipes;
create policy "Ajouter ses recettes" on public.recipes
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Modifier ses recettes" on public.recipes;
create policy "Modifier ses recettes" on public.recipes
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Supprimer ses recettes" on public.recipes;
create policy "Supprimer ses recettes" on public.recipes
  for delete to authenticated using (auth.uid() = user_id);
