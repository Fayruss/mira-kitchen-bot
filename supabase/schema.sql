-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- Creates conversation_sessions, orders, availability, and menu_items.

create extension if not exists pgcrypto;

-- One row per Telegram chat. Tracks where the customer is in the
-- order-collection state machine, plus the fields collected so far.
create table if not exists conversation_sessions (
  chat_id bigint primary key,
  state text not null default 'START',
  history jsonb not null default '[]'::jsonb,
  customer_name text,
  delivery_area text,
  order_items text,
  quantity text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per completed order.
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  customer_name text not null,
  delivery_area text not null,
  items text not null,
  quantity text not null,
  created_at timestamptz not null default now()
);

-- Single row holding the current OPEN/CLOSED flag, toggled by the
-- /open and /close admin commands.
create table if not exists availability (
  id int primary key default 1,
  is_open boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into availability (id, is_open)
values (1, true)
on conflict (id) do nothing;

-- Menu items, managed directly in Supabase (no admin dashboard).
-- The /menu admin command reads this table.
create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric not null,
  available boolean not null default true,
  created_at timestamptz not null default now()
);
