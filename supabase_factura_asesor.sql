alter table public.copacol_facturas
  add column if not exists asesor_codigo text,
  add column if not exists asesor_nombre text;

create index if not exists copacol_facturas_asesor_codigo_idx
  on public.copacol_facturas (asesor_codigo);
