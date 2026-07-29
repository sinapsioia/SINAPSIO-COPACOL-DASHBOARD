-- COPACOL - Overrides persistentes de condicion de credito por cliente
-- Ejecutar en Supabase SQL Editor para que los cambios de condicion desde el
-- dashboard sobrevivan nuevas ingestas de Siigo/n8n y los tome el bot.

create table if not exists public.copacol_client_condition_overrides (
  nit text primary key,
  condicion_pago text not null,   -- contado | credito_45d | credito_60d
  activo boolean not null default true,
  motivo text,
  updated_by text,
  source text not null default 'dashboard',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.copacol_client_condition_overrides
  enable row level security;

-- Sin politicas para anon/authenticated: el dashboard y n8n escriben con service role.

create index if not exists copacol_client_condition_overrides_activo_idx
  on public.copacol_client_condition_overrides (activo);

create or replace function public.set_copacol_client_condition_overrides_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_copacol_client_condition_overrides_updated_at
  on public.copacol_client_condition_overrides;

create trigger set_copacol_client_condition_overrides_updated_at
before update on public.copacol_client_condition_overrides
for each row execute function public.set_copacol_client_condition_overrides_updated_at();
