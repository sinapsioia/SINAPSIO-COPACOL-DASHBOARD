-- COPACOL - Historial de plantillas de cartera
-- Ejecutar en Supabase SQL Editor antes de conectar el historial persistente en n8n.

create table if not exists public.copacol_import_batches (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'dashboard',
  filename text,
  fecha_corte date,
  imported_at timestamptz not null default now(),
  imported_by text,
  status text not null default 'completed',
  mode text not null default 'snapshot_replace',
  clientes integer not null default 0,
  facturas integer not null default 0,
  saldo_total numeric not null default 0,
  total_vencido numeric not null default 0,
  total_vigente numeric not null default 0,
  aging jsonb not null default '{}'::jsonb,
  cambios jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists copacol_import_batches_imported_at_idx
  on public.copacol_import_batches (imported_at desc);

create index if not exists copacol_import_batches_fecha_corte_idx
  on public.copacol_import_batches (fecha_corte desc);

alter table public.copacol_clients
  add column if not exists import_batch_id uuid references public.copacol_import_batches(id);

alter table public.copacol_facturas
  add column if not exists import_batch_id uuid references public.copacol_import_batches(id);

create index if not exists copacol_clients_import_batch_id_idx
  on public.copacol_clients (import_batch_id);

create index if not exists copacol_facturas_import_batch_id_idx
  on public.copacol_facturas (import_batch_id);
