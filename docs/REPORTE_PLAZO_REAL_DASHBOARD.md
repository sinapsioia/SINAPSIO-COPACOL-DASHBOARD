# Reporte tecnico - plazo real COPACOL dashboard

Fecha: 2026-05-14

## Objetivo funcional

El cliente necesita cargar la cartera exportada desde Siigo sin preparar formulas ni calcular mora manualmente. El sistema debe tomar cada factura, buscar el NIT en `copacol_terceros_credito` y, cuando exista `plazo_pago_real`, recalcular:

- fecha de vencimiento real = fecha de emision + plazo real;
- dias reales de mora = fecha de corte - fecha de vencimiento real;
- estado vigente/vencida y acumulados vencidos/vigentes.

Si el NIT no existe en la tabla de terceros o no tiene plazo real valido, se conserva el vencimiento y los dias de mora originales del archivo de cartera.

## Cambios implementados en el dashboard

### `app.py`

- Se amplio la lectura de llave Supabase para aceptar `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_ROLE` o `SUPABASE_SERVICE_KEY`.
- `parse_xlsx()` ahora puede validar la cartera con plazo real de dos formas:
  - usando el transformador local COPACOL si existe en el workspace;
  - usando un parser interno del dashboard cuando el repo esta desplegado sin archivos hermanos.
- El parser interno ahora:
  - detecta dinamicamente la fila de encabezados;
  - soporta el formato Siigo completo de 20 columnas y el formato nuevo/compacto de 15 columnas;
  - detecta fechas Siigo como `MAY/13/2026` y fechas seriales de Excel;
  - consulta `copacol_terceros_credito` por NIT;
  - recalcula vencimiento y mora con `plazo_pago_real`;
  - usa fallback a cartera original cuando no hay plazo real;
  - reporta cobertura de plazo real en el preview;
  - mantiene saldos netos, saldos a favor y buckets de aging coherentes con el pipeline oficial.
- El fallback directo de importacion usa `estado = vencida`, consistente con `copacol_facturas`.

### `static/app.js`

- Las tarjetas de clientes muestran la condicion real y el plazo real en dias cuando existe.
- El drawer de cliente muestra explicitamente `Plazo real`.
- El preview de carga muestra cuantos documentos usaron plazo real y cuantos quedaron en fallback de cartera original.

## Coherencia con el bot y n8n

La estructura correcta queda asi:

1. El cliente sube el Excel raw de Siigo en el dashboard.
2. El dashboard valida el archivo y muestra un preview calculado con plazo real.
3. Al confirmar, la ruta oficial envia el archivo al webhook `N8N_IMPORT_WEBHOOK_URL`.
4. n8n ejecuta la ingesta y escribe en Supabase:
   - `copacol_clients`;
   - `copacol_facturas`;
   - `copacol_import_batches`.
5. Los flujos reactivo, proactivo y el dashboard leen los valores persistidos en Supabase. No deben recalcular mora con la fecha del dia en runtime.

Esto evita que el equipo de COPACOL tenga que subir archivos con formulas o calculos previos.

## Validacion realizada

Se validaron ambas versiones de cartera compartidas durante la implementacion:

| Archivo | Clientes | Facturas | Saldo neto | Fecha corte | Docs con plazo real | Docs fallback |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| `CARTERA GENERAL 06-05-2026.xlsx` | 438 | 1351 | 1,293,552,909.53 | 2026-05-06 | 984 | 367 |
| `CARTERA GENERAL 13-05-2026 NUEVO.xlsx` | 444 | 1343 | 1,326,597,074.89 | 2026-05-13 | 1016 | 327 |

Tambien se valido el parser desde una copia temporal del dashboard sin acceso a `../Copacol/cartera_to_supabase.py`, para confirmar que el repo desplegado puede validar ambos formatos por si mismo.

## Instruccion operativa para el cliente

El cliente debe subir el Excel exportado desde Siigo como cartera general por vendedor. No debe agregar formulas, columnas calculadas, macros ni calculos manuales de mora.

Columnas esperadas minimas:

- `NIT`
- `NOMBRE`
- `DOCUMENTO`
- `FECHA`
- `VENCE`
- `DIAS`
- `SALDO`

Tambien se aprovechan si vienen en el archivo:

- `CIUDAD`
- `VENDED`
- `TEL_1`
- `TEL_2`
- `CUENTA`
- `VLR MORA`

## Nota para despliegue

La importacion productiva debe tener configurado `N8N_IMPORT_WEBHOOK_URL`. El dashboard puede validar el Excel por si solo, pero la escritura oficial debe seguir pasando por n8n para mantener historial de batches, reemplazo controlado de cartera activa y consistencia con los flujos del bot.
