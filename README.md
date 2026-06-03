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
- La escritura/importación definitiva pasa por el webhook n8n configurado en `N8N_IMPORT_WEBHOOK_URL`; el dashboard no escribe cartera directamente en Supabase.
- La reasignación manual de clientes a asesores usa `copacol_client_advisor_overrides`. Ejecutar `supabase_advisor_overrides.sql` una vez en Supabase SQL Editor antes de usar ese módulo en producción.
