-- Empanadas shop schema. Run once in Supabase: Dashboard → SQL Editor → paste → Run.
-- Security model:
--   * Anonymous visitors get NO direct table access. The storefront reads/writes through
--     the Next.js server using the service-role key, which validates everything.
--   * Admins log in with Supabase Auth; every admin table is gated by RLS via is_admin().
--   * Prices are only ever read from the database, never trusted from the browser.

create extension if not exists pgcrypto;

-- ───────────────────────── Admins ─────────────────────────
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ───────────────────────── Settings (single row) ─────────────────────────
create table if not exists public.settings (
  id                   int primary key default 1 check (id = 1),
  shop_name            text    not null default 'Empanadas',
  timezone             text    not null default 'America/New_York',
  accepting_orders     boolean not null default true,
  delivery_enabled     boolean not null default true,
  pickup_enabled       boolean not null default true,
  delivery_fee_cents   int     not null default 500  check (delivery_fee_cents >= 0),
  min_order_cents      int     not null default 0    check (min_order_cents >= 0),
  -- Empty array = deliver to any ZIP. Otherwise only these ZIP codes are accepted.
  delivery_zips        text[]  not null default '{}',
  pickup_address       text    not null default '',
  slot_minutes         int     not null default 30   check (slot_minutes between 10 and 240),
  max_orders_per_slot  int     not null default 4    check (max_orders_per_slot between 1 and 100),
  lead_time_minutes    int     not null default 60   check (lead_time_minutes between 0 and 2880),
  days_ahead           int     not null default 7    check (days_ahead between 0 and 60),
  -- Keys "0".."6" = Sunday..Saturday. null = closed that day.
  hours jsonb not null default '{
    "0": null,
    "1": null,
    "2": {"open":"11:00","close":"20:00"},
    "3": {"open":"11:00","close":"20:00"},
    "4": {"open":"11:00","close":"20:00"},
    "5": {"open":"11:00","close":"21:00"},
    "6": {"open":"11:00","close":"21:00"}
  }'::jsonb,
  -- E.164 numbers that receive Twilio SMS for each paid order, e.g. {+14015550123}
  alert_phones         text[]  not null default '{}',
  updated_at           timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ───────────────────────── Products ─────────────────────────
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  price_cents int  not null check (price_cents > 0 and price_cents <= 100000),
  image_path  text,
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);

-- ───────────────────────── Orders ─────────────────────────
do $$ begin
  create type public.order_status as enum
    ('pending','paid','preparing','ready','out_for_delivery','completed','cancelled','expired');
exception when duplicate_object then null; end $$;

create table if not exists public.orders (
  id                    uuid primary key default gen_random_uuid(),
  order_number          bigint generated always as identity,
  status                public.order_status not null default 'pending',
  fulfillment           text not null check (fulfillment in ('delivery','pickup')),
  customer_name         text not null,
  customer_phone        text not null,
  customer_email        text,
  address               text,
  address_notes         text,
  zip                   text,
  slot_start            timestamptz not null,
  subtotal_cents        int not null check (subtotal_cents >= 0),
  delivery_fee_cents    int not null default 0 check (delivery_fee_cents >= 0),
  total_cents           int not null check (total_cents >= 0),
  stripe_session_id     text unique,
  stripe_payment_intent text,
  paid_at               timestamptz,
  expires_at            timestamptz not null,
  created_at            timestamptz not null default now()
);
create index if not exists orders_slot_idx    on public.orders (slot_start);
create index if not exists orders_status_idx  on public.orders (status);
create index if not exists orders_paid_at_idx on public.orders (paid_at);

create table if not exists public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id) on delete cascade,
  product_id       uuid references public.products(id) on delete set null,
  name             text not null,
  unit_price_cents int  not null check (unit_price_cents > 0),
  qty              int  not null check (qty between 1 and 100)
);
create index if not exists order_items_order_idx on public.order_items (order_id);

-- ───────────────────────── Rate limiting ─────────────────────────
create table if not exists public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (key, window_start)
);

create or replace function public.hit_rate_limit(p_key text, p_window_seconds int, p_max int)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  c int;
begin
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, w, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning count into c;
  -- opportunistic cleanup
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return c <= p_max;
end $$;

-- ───────────────────────── Atomic slot reservation ─────────────────────────
-- Locks the slot, checks capacity (paid orders + unexpired pending checkouts),
-- then inserts the order and its items in one transaction. Prevents overbooking
-- when two customers check out for the same slot at the same moment.
create or replace function public.create_pending_order(p_order jsonb, p_items jsonb, p_max_per_slot int)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_slot  timestamptz := (p_order->>'slot_start')::timestamptz;
  v_count int;
  v_id    uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_slot::text, 0));

  select count(*) into v_count
  from public.orders
  where slot_start = v_slot
    and (status in ('paid','preparing','ready','out_for_delivery','completed')
         or (status = 'pending' and expires_at > now()));

  if v_count >= p_max_per_slot then
    raise exception 'SLOT_FULL';
  end if;

  insert into public.orders (fulfillment, customer_name, customer_phone, customer_email,
                             address, address_notes, zip, slot_start,
                             subtotal_cents, delivery_fee_cents, total_cents, expires_at)
  values (p_order->>'fulfillment', p_order->>'customer_name', p_order->>'customer_phone',
          nullif(p_order->>'customer_email',''), nullif(p_order->>'address',''),
          nullif(p_order->>'address_notes',''), nullif(p_order->>'zip',''), v_slot,
          (p_order->>'subtotal_cents')::int, (p_order->>'delivery_fee_cents')::int,
          (p_order->>'total_cents')::int, (p_order->>'expires_at')::timestamptz)
  returning id into v_id;

  insert into public.order_items (order_id, product_id, name, unit_price_cents, qty)
  select v_id, (i->>'product_id')::uuid, i->>'name', (i->>'unit_price_cents')::int, (i->>'qty')::int
  from jsonb_array_elements(p_items) as i;

  return v_id;
end $$;

-- Slot usage for the storefront's time picker.
create or replace function public.slot_usage(p_from timestamptz, p_to timestamptz)
returns table (slot_start timestamptz, used int)
language sql stable security definer
set search_path = public
as $$
  select slot_start, count(*)::int
  from public.orders
  where slot_start >= p_from and slot_start < p_to
    and (status in ('paid','preparing','ready','out_for_delivery','completed')
         or (status = 'pending' and expires_at > now()))
  group by slot_start;
$$;

-- These functions are server-only (service role). Nobody else may call them.
revoke all on function public.hit_rate_limit(text,int,int)            from public, anon, authenticated;
revoke all on function public.create_pending_order(jsonb,jsonb,int)   from public, anon, authenticated;
revoke all on function public.slot_usage(timestamptz,timestamptz)     from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text,int,int)          to service_role;
grant execute on function public.create_pending_order(jsonb,jsonb,int) to service_role;
grant execute on function public.slot_usage(timestamptz,timestamptz)   to service_role;

-- ───────────────────────── Row Level Security ─────────────────────────
alter table public.admins      enable row level security;
alter table public.settings    enable row level security;
alter table public.products    enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.rate_limits enable row level security;  -- no policies = no access except service role

drop policy if exists admins_self_read on public.admins;
create policy admins_self_read on public.admins for select to authenticated using (public.is_admin());

drop policy if exists settings_admin_all on public.settings;
create policy settings_admin_all on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists products_admin_all on public.products;
create policy products_admin_all on public.products for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists orders_admin_read on public.orders;
create policy orders_admin_read on public.orders for select to authenticated using (public.is_admin());
drop policy if exists orders_admin_update on public.orders;
create policy orders_admin_update on public.orders for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists order_items_admin_read on public.order_items;
create policy order_items_admin_read on public.order_items for select to authenticated using (public.is_admin());

-- ───────────────────────── Image storage ─────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists product_images_admin_insert on storage.objects;
create policy product_images_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());
drop policy if exists product_images_admin_update on storage.objects;
create policy product_images_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin());
drop policy if exists product_images_admin_delete on storage.objects;
create policy product_images_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

-- ───────────────────────── Sales reports (admins only) ─────────────────────────
create or replace function public.sales_between(p_from timestamptz, p_to timestamptz)
returns table (orders int, revenue_cents bigint, items int)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    with paid as (
      select o.id, o.total_cents from public.orders o
      where o.paid_at >= p_from and o.paid_at < p_to
        and o.status in ('paid','preparing','ready','out_for_delivery','completed')
    )
    select (select count(*) from paid)::int,
           (select coalesce(sum(total_cents), 0) from paid)::bigint,
           (select coalesce(sum(oi.qty), 0) from public.order_items oi where oi.order_id in (select id from paid))::int;
end $$;

create or replace function public.sales_by_day(p_from timestamptz, p_to timestamptz, p_tz text)
returns table (day date, orders int, revenue_cents bigint)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select (o.paid_at at time zone p_tz)::date, count(*)::int, sum(o.total_cents)::bigint
    from public.orders o
    where o.paid_at >= p_from and o.paid_at < p_to
      and o.status in ('paid','preparing','ready','out_for_delivery','completed')
    group by 1 order by 1;
end $$;

create or replace function public.top_products(p_from timestamptz, p_to timestamptz)
returns table (name text, qty int, revenue_cents bigint)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select oi.name, sum(oi.qty)::int, sum(oi.qty * oi.unit_price_cents)::bigint
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.paid_at >= p_from and o.paid_at < p_to
      and o.status in ('paid','preparing','ready','out_for_delivery','completed')
    group by oi.name order by 2 desc limit 10;
end $$;

revoke all on function public.sales_between(timestamptz,timestamptz)     from public, anon;
revoke all on function public.sales_by_day(timestamptz,timestamptz,text) from public, anon;
revoke all on function public.top_products(timestamptz,timestamptz)      from public, anon;
grant execute on function public.sales_between(timestamptz,timestamptz)     to authenticated;
grant execute on function public.sales_by_day(timestamptz,timestamptz,text) to authenticated;
grant execute on function public.top_products(timestamptz,timestamptz)      to authenticated;

-- ───────────────────────── Make yourself an admin ─────────────────────────
-- 1. Supabase → Authentication → Users → "Add user" (email + password) for each of the 2 admins.
-- 2. Then run, once per admin:
--    insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
