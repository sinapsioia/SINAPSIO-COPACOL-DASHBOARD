-- COPACOL - Overrides persistentes de asesor por cliente
-- Ejecutar en Supabase SQL Editor para que las reasignaciones del dashboard
-- sobrevivan nuevas ingestas de Siigo/n8n.

create table if not exists public.copacol_client_advisor_overrides (
  nit text primary key,
  asesor_codigo text,
  asesor_nombre text,
  activo boolean not null default true,
  motivo text,
  updated_by text,
  source text not null default 'dashboard',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists copacol_client_advisor_overrides_activo_idx
  on public.copacol_client_advisor_overrides (activo);

create or replace function public.set_copacol_client_advisor_overrides_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_copacol_client_advisor_overrides_updated_at
  on public.copacol_client_advisor_overrides;

create trigger set_copacol_client_advisor_overrides_updated_at
before update on public.copacol_client_advisor_overrides
for each row execute function public.set_copacol_client_advisor_overrides_updated_at();

create or replace function public.apply_copacol_advisor_override_to_client()
returns trigger
language plpgsql
as $$
declare
  override_row public.copacol_client_advisor_overrides%rowtype;
begin
  select *
  into override_row
  from public.copacol_client_advisor_overrides
  where regexp_replace(nit, '\D', '', 'g') = regexp_replace(new.nit, '\D', '', 'g')
    and activo = true
  limit 1;

  if found then
    new.asesor_codigo = override_row.asesor_codigo;
    new.asesor_nombre = override_row.asesor_nombre;
  end if;

  return new;
end;
$$;

drop trigger if exists apply_copacol_advisor_override_to_client
  on public.copacol_clients;

create trigger apply_copacol_advisor_override_to_client
before insert or update of nit, asesor_codigo, asesor_nombre
on public.copacol_clients
for each row execute function public.apply_copacol_advisor_override_to_client();

create or replace function public.sync_copacol_clients_from_advisor_override()
returns trigger
language plpgsql
as $$
begin
  if new.activo = true then
    update public.copacol_clients
       set asesor_codigo = new.asesor_codigo,
           asesor_nombre = new.asesor_nombre
     where regexp_replace(nit, '\D', '', 'g') = regexp_replace(new.nit, '\D', '', 'g');
  end if;
  return new;
end;
$$;

drop trigger if exists sync_copacol_clients_from_advisor_override
  on public.copacol_client_advisor_overrides;

create trigger sync_copacol_clients_from_advisor_override
after insert or update of asesor_codigo, asesor_nombre, activo
on public.copacol_client_advisor_overrides
for each row execute function public.sync_copacol_clients_from_advisor_override();

create or replace view public.copacol_clients_effective as
select
  c.*,
  case when o.nit is not null and o.activo = true then o.asesor_codigo else c.asesor_codigo end as asesor_codigo_efectivo,
  case when o.nit is not null and o.activo = true then o.asesor_nombre else c.asesor_nombre end as asesor_nombre_efectivo,
  (o.nit is not null and o.activo = true) as tiene_override_asesor
from public.copacol_clients c
left join public.copacol_client_advisor_overrides o
  on regexp_replace(o.nit, '\D', '', 'g') = regexp_replace(c.nit, '\D', '', 'g')
 and o.activo = true;
