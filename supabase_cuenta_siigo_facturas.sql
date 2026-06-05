alter table public.copacol_facturas
  add column if not exists cuenta_siigo text;

create index if not exists copacol_facturas_cuenta_siigo_idx
  on public.copacol_facturas (cuenta_siigo);
