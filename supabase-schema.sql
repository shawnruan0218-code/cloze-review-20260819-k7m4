create table if not exists public.review_items (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null,
  exam_id text not null,
  card_id text not null,
  term_id text not null,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, item_key)
);

alter table public.review_items enable row level security;

drop policy if exists "review_items_select_own" on public.review_items;
create policy "review_items_select_own"
on public.review_items
for select
using (auth.uid() = user_id);

drop policy if exists "review_items_insert_own" on public.review_items;
create policy "review_items_insert_own"
on public.review_items
for insert
with check (auth.uid() = user_id);

drop policy if exists "review_items_update_own" on public.review_items;
create policy "review_items_update_own"
on public.review_items
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "review_items_delete_own" on public.review_items;
create policy "review_items_delete_own"
on public.review_items
for delete
using (auth.uid() = user_id);
