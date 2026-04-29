# COPACOL Dashboard de Cobranzas

MVP del dashboard operativo de cobranzas para COPACOL.

## Ejecutar local

```bash
python3 app.py
```

Abrir:

```text
http://localhost:8787
```

## Variables

Crear `.env` a partir de `.env.example`. La app lee Supabase desde el backend usando `SUPABASE_SERVICE_ROLE_KEY`, por lo que esa llave no debe exponerse en frontend ni subirse al repositorio.

## Estado actual

- Lee KPIs reales desde Supabase.
- Muestra edad de cartera, vendedores, facturas vencidas y clientes prioritarios.
- Valida un Excel de Siigo desde la pantalla de carga.
- La escritura/importación definitiva debe activarse luego de confirmar reglas de reemplazo por corte.
