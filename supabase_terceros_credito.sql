-- COPACOL - Catálogo de terceros con condiciones reales de crédito
-- Ejecutar una vez en Supabase SQL Editor antes de cargar BASE DE DATOS TERCEROS.xlsx.

create table if not exists public.copacol_terceros_credito (
  nit text primary key,
  sucursal text,
  digito_verificacion text,
  nombre text,
  direccion text,
  ciudad_codigo text,
  activo text,
  clasificacion text,
  cupo_credito numeric not null default 0,
  vendedor_codigo text,
  plazo_pago_real integer,
  condicion_credito text,
  condicion_key text not null default 'sin_condicion_real',
  observacion text,
  source_filename text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists copacol_terceros_credito_condicion_key_idx
  on public.copacol_terceros_credito (condicion_key);

create index if not exists copacol_terceros_credito_vendedor_codigo_idx
  on public.copacol_terceros_credito (vendedor_codigo);

create or replace function public.set_copacol_terceros_credito_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_copacol_terceros_credito_updated_at
  on public.copacol_terceros_credito;

create trigger set_copacol_terceros_credito_updated_at
before update on public.copacol_terceros_credito
for each row execute function public.set_copacol_terceros_credito_updated_at();

