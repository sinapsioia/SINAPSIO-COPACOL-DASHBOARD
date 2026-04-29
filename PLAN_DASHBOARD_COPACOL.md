# Plan Dashboard de Cobranzas COPACOL

## Contexto confirmado

- Archivo recibido de Siigo: `CARTERA GENERAL-15-04-2026 (1).xlsx`.
- Fecha de corte del archivo: 2026-04-15.
- Registros reales de cartera detectados: 1.359 facturas/documentos.
- Clientes detectados: 479.
- Vendedores detectados: 15.
- Saldo total detectado: COP 1.329.446.698,91.
- La estructura ya esta cargada en Supabase con tablas para clientes, facturas, contactos, promesas, pagos, conversaciones, documentos y embeddings.

## Decision de arquitectura

La fuente operacional del dashboard debe ser Supabase, no el Excel directamente.

El Excel exportado desde Siigo queda como formato de entrada inicial. Para el MVP, el flujo principal debe ser carga directa desde el dashboard: un admin sube la plantilla, el sistema valida, muestra un resumen previo y solo actualiza Supabase cuando el usuario confirma. n8n queda como capa opcional de automatizacion para escenarios donde COPACOL prefiera dejar archivos en Drive, reenviarlos por correo o ejecutar una rutina programada.

Si mas adelante COPACOL confirma que su licencia de Siigo permite API directa, se reemplaza la entrada Excel/Drive por una integracion directa sin rehacer el dashboard.

Arquitectura recomendada:

1. Siigo exporta cartera en Excel.
2. El archivo se carga desde el dashboard o llega por Google Drive/Gmail/n8n.
3. Una capa unica de importacion valida columnas, fecha de corte y montos.
4. La importacion actualiza Supabase.
5. El dashboard consulta Supabase como fuente canonica.
6. EasyPanel en Contabo hostea la app web.
7. Supabase maneja base de datos, auth, RLS y vistas SQL.

## Stack recomendado

- Frontend/app: Next.js o React + Vite.
- UI: Tailwind + componentes propios sobrios, estilo operativo.
- Charts/tablas: Recharts o Tremor/AG Grid segun nivel de tabla requerido.
- Backend ligero: API routes/server actions solo para operaciones sensibles.
- Base de datos: Supabase Postgres.
- Automatizacion: n8n.
- Hosting: EasyPanel sobre Contabo.
- Auth: Supabase Auth con roles.
- Archivos: Supabase Storage o Google Drive, segun el flujo final de carga.

## Estrategia de carga de datos

Se recomiendan dos caminos compatibles, usando el mismo parser y las mismas reglas de validacion.

### Opcion A: carga desde el dashboard

Debe ser el camino principal del MVP.

Flujo:

1. Admin entra al dashboard.
2. Abre `Carga de datos`.
3. Sube el Excel exportado desde Siigo.
4. El sistema valida:
   - columnas esperadas;
   - fecha de corte;
   - cantidad de documentos;
   - total de saldo;
   - cantidad de clientes;
   - errores de formato;
   - diferencias contra el corte anterior.
5. El sistema muestra una vista previa de importacion.
6. Admin confirma.
7. Backend procesa el archivo con service role.
8. Supabase queda actualizado.
9. Se guarda log de importacion con usuario, fecha, archivo, totales y resultado.

Ventajas:

- Menos piezas para el MVP.
- Mejor control para COPACOL.
- Permite validar antes de tocar datos reales.
- No depende de que alguien deje bien nombrado un archivo en Drive.

### Opcion B: Drive/Gmail + n8n

Debe quedar como automatizacion complementaria.

Flujo:

1. COPACOL deja el Excel en una carpeta de Google Drive o lo envia a un correo.
2. n8n detecta archivo nuevo o se ejecuta por horario.
3. n8n descarga el archivo.
4. n8n llama el endpoint interno de importacion del dashboard o ejecuta el mismo proceso de normalizacion.
5. Se actualiza Supabase.
6. Se notifica el resultado.

Ventajas:

- Operacion mas automatica.
- Bueno para rutinas diarias/semanales.
- Reduce pasos si COPACOL ya trabaja desde Drive.

Decision recomendada:

- MVP: implementar Opcion A.
- Fase 2: agregar Opcion B sin cambiar el modelo de datos.
- Regla tecnica: no duplicar logica de importacion. El dashboard y n8n deben usar el mismo contrato de datos o el mismo endpoint backend.

## Doble via con Supabase

Supabase debe funcionar en doble via:

- Entrada de datos:
  - cargas Excel;
  - actualizaciones manuales de gestion;
  - promesas de pago;
  - pagos reportados;
  - contactos;
  - futuros eventos del bot.

- Salida de datos:
  - KPIs del dashboard;
  - tablas y filtros;
  - vistas por vendedor;
  - reportes;
  - futuras prioridades de cobranza;
  - informacion para el bot.

Separacion importante:

- La cartera/facturas vienen de Siigo y no deberian editarse manualmente, salvo campos de gestion.
- Los campos operativos si se editan en el dashboard: etapa, observacion, proximo contacto, promesa, estado de pago, escalamiento.
- Si llega un nuevo corte de Siigo, se actualizan saldos y facturas, pero se conserva el historial de gestion.

## Modelo de datos actual

Tablas existentes detectadas:

- `copacol_clients`: resumen por cliente.
- `copacol_facturas`: detalle por documento/factura.
- `copacol_log_contactos`: historial de contacto.
- `copacol_promesas_pago`: compromisos de pago.
- `copacol_pagos_reportados`: pagos/comprobantes reportados.
- `copacol_conversations`: mensajes/conversaciones del bot.
- `copacol_documents`: base documental.
- `copacol_embeddings`: embeddings para busqueda/IA.

Recomendacion de ajuste:

- Mantener `copacol_facturas` como tabla transaccional.
- Mantener `copacol_clients` como tabla resumen/materializada por cliente.
- Crear vistas SQL para KPIs del dashboard, por ejemplo:
  - `v_cartera_resumen`
  - `v_cartera_por_vendedor`
  - `v_cartera_por_cliente`
  - `v_cartera_por_edad`
  - `v_cartera_acciones_pendientes`

## Normalizacion del Excel

El archivo de Siigo trae encabezados repetidos:

- Columna 4: `NOMBRE`, correspondiente al vendedor.
- Columna 7: `NOMBRE`, correspondiente al cliente.

En la ingesta deben renombrarse asi:

- `vendedor_codigo`
- `vendedor_nombre`
- `cliente_nit`
- `cliente_nombre`
- `telefono_1`
- `telefono_2`
- `direccion`
- `cuenta`
- `documento`
- `fecha_emision`
- `fecha_vencimiento`
- `dias_mora`
- `vlr_mora`
- `saldo`

Reglas de limpieza:

- Ignorar filas de totales de Siigo.
- Convertir fechas Excel serial a fecha ISO.
- Normalizar NIT como texto, no numero.
- Normalizar telefonos como texto, conservando ceros.
- Clasificar cartera por edad:
  - Vigente/no vencida: `dias_mora <= 0`
  - 1 a 30 dias
  - 31 a 60 dias
  - 61 a 90 dias
  - Mas de 90 dias

## KPIs del dashboard

Primera version:

- Saldo total de cartera.
- Saldo vencido.
- Saldo vigente.
- Numero de clientes con saldo.
- Numero de facturas/documentos abiertos.
- Clientes vencidos.
- Cartera por edad.
- Cartera por vendedor.
- Top clientes por saldo.
- Facturas proximas a vencer.
- Facturas mas vencidas.
- Promesas de pago pendientes.
- Pagos reportados pendientes de validacion.

Segunda version:

- Efectividad de cobranza por vendedor.
- Tasa de cumplimiento de promesas.
- Tiempo promedio desde vencimiento hasta pago/contacto.
- Contactos por etapa.
- Riesgo por cliente.
- Priorizacion automatica diaria de llamadas/mensajes.

## Pantallas recomendadas

1. Resumen ejecutivo
   - KPIs principales.
   - Distribucion por edad de cartera.
   - Evolucion por cortes si empezamos a guardar historico.

2. Cartera
   - Tabla filtrable por cliente, vendedor, ciudad, edad, fecha de vencimiento y saldo.
   - Vista detalle de factura/documento.

3. Clientes
   - Ranking por saldo.
   - Ficha de cliente con facturas, telefonos, direccion, historial, promesas y pagos.

4. Vendedores
   - Cartera asignada.
   - Vencido por vendedor.
   - Acciones pendientes.

5. Gestion de cobranza
   - Promesas de pago.
   - Contactos realizados.
   - Pagos reportados.
   - Estados: pendiente, contactado, prometio pago, pago reportado, escalado.

6. Carga/actualizacion
   - Subir Excel de Siigo.
   - Ver validaciones.
   - Confirmar importacion.
   - Historial de cortes.

## Direccion visual y experiencia

COPACOL es un distribuidor ferretero, asi que el dashboard debe sentirse operativo, fuerte y profesional: una herramienta de trabajo diaria, no una landing page ni un reporte estatico.

Principios visuales:

- Interfaz densa pero clara, pensada para cobranza real.
- Tonos sobrios con acentos industriales: grafito, blanco, gris acero, verde exito, amarillo alerta y rojo riesgo.
- Evitar un look financiero generico demasiado frio.
- Usar iconografia de accion: llamadas, mensajes, alerta, calendario, factura, promesa, pago, vendedor.
- Tablas potentes, con filtros visibles y acciones rapidas.
- Graficas utiles, no decorativas.
- Estados de cartera con colores consistentes:
  - Vigente: verde.
  - 1-30 dias: amarillo.
  - 31-60 dias: naranja.
  - 61+ dias: rojo.
  - Escalado: grafito/negro.

Interacciones clave:

- Buscar cliente por nombre, NIT, telefono o documento.
- Filtros rapidos por vendedor, edad de cartera, ciudad, estado y saldo.
- Boton de accion por cliente: llamar, registrar contacto, promesa de pago, pago reportado, escalar.
- Ficha de cliente con contexto completo en una sola vista.
- Alertas de facturas proximas a vencer y promesas incumplidas.
- Ranking de prioridad diaria para cobranza.

El objetivo visual es que el usuario sienta: "entro y se exactamente a quien cobrar, por que monto, con que urgencia y que paso despues".

## Roles y permisos

- Admin SINAPSIO: configuracion, cargas, auditoria.
- Admin COPACOL: todo el dashboard y usuarios.
- Coordinador cartera: gestion completa, validaciones y reportes.
- Vendedor: solo cartera asignada.
- Lectura gerencial: indicadores y reportes sin editar.

Implementacion:

- Supabase Auth.
- RLS por rol.
- Politicas por `asesor_codigo` para vendedores.
- Service role solo en backend/n8n, nunca en frontend.

## Seguridad

Las llaves compartidas deben rotarse antes de produccion porque ya fueron expuestas en conversacion.

Reglas:

- No usar service role en navegador.
- Guardar secretos en EasyPanel env vars y credenciales de n8n.
- Activar RLS antes de abrir acceso externo.
- Crear anon key/public key solo para lectura autenticada permitida.
- Logs sin datos bancarios sensibles.
- Separar datos del bot y dashboard, aunque compartan cliente/factura.

## Pipeline n8n opcional

Flujo automatizado:

1. Trigger manual, Google Drive/Gmail, horario o webhook.
2. Descargar archivo Excel.
3. Validar nombre, extension y fecha de corte.
4. Parsear hoja 1.
5. Renombrar columnas.
6. Eliminar totales.
7. Calcular campos derivados.
8. Upsert en `copacol_facturas`.
9. Recalcular resumen en `copacol_clients`.
10. Guardar log de importacion.
11. Notificar resultado por email/Slack/WhatsApp interno.

Este flujo no reemplaza la carga directa desde el dashboard. Debe usar el mismo criterio de validacion para evitar diferencias entre caminos.

Para evitar datos viejos:

- Agregar `fecha_corte` a facturas y clientes.
- Conservar historico por corte o marcar el corte activo.
- No borrar historico sin confirmacion.

## Despliegue

Opcion recomendada:

- App dockerizada.
- Repo en GitHub.
- EasyPanel conectado al repo.
- Variables de entorno:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `N8N_WEBHOOK_SECRET`
- Dominio/subdominio para COPACOL.
- SSL desde EasyPanel.

## Fases de ejecucion

### Fase 1: Base funcional

- Crear app dashboard.
- Conectar Supabase.
- Mostrar KPIs reales.
- Crear tablas de cartera y clientes.
- Filtros basicos.
- Login con Supabase.
- Carga manual de Excel desde el dashboard con validacion y confirmacion.

### Fase 2: Gestion operativa

- Ficha de cliente.
- Estados de cobranza.
- Promesas de pago.
- Pagos reportados.
- Historial de contacto.

### Fase 3: Ingesta automatizada

- Flujo n8n para Excel desde Drive/Gmail/webhook.
- Logs de importacion.
- Historico por corte.

### Fase 4: Preparacion bot

- Conectar conversaciones.
- Guardar eventos del bot.
- Sincronizar promesas/pagos entre bot y dashboard.
- Base documental y embeddings.

### Fase 5: Siigo directo

- Confirmar licencia/API.
- Reemplazar entrada Excel por API.
- Mantener el mismo modelo de Supabase.

## Preguntas pendientes para COPACOL

- Usuarios y roles exactos.
- Si cada vendedor debe ver solo su cartera.
- Definicion de cartera vencida y etapas internas.
- Frecuencia real de actualizacion: diaria, semanal o bajo demanda.
- Preferencia de carga: dashboard, Drive/Gmail automatizado, o ambas.
- Si quieren historico de cortes o solo estado actual.
- Confirmacion de API/licencia Siigo.
- Logo en alta calidad.
- Pantallazo del dashboard creado en Claude.
- Preferencia de dominio/subdominio.

## Variables de entorno necesarias

Para el MVP:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_URL`
- `IMPORT_SECRET`

Para autenticacion y despliegue:

- `NEXT_PUBLIC_SITE_NAME`
- `ALLOWED_EMAIL_DOMAINS`
- `ADMIN_EMAILS`

Para almacenamiento de archivos, si se usa Supabase Storage:

- `SUPABASE_IMPORT_BUCKET`

Para n8n, si se activa la automatizacion:

- `N8N_WEBHOOK_SECRET`
- `N8N_IMPORT_WEBHOOK_URL`
- `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON` o credenciales OAuth configuradas en n8n.

Para notificaciones, si COPACOL las quiere:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `NOTIFICATION_FROM_EMAIL`

Nota: las llaves actuales de Supabase sirven para desarrollo, pero deben rotarse antes de produccion.

## Siguiente paso recomendado

Construir MVP del dashboard usando las tablas actuales de Supabase, con login, resumen ejecutivo, cartera filtrable, ficha de cliente y carga manual de Excel con validacion. En paralelo, dejar disenado el contrato de ingesta para que n8n pueda refrescar la data desde Drive/Gmail sin tocar el frontend.
