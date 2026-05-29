# Respuesta a Solicitudes SINAPSIO — Dashboard COPACOL

Fecha de actualización: 2026-05-28 (tercera iteración SINAPSIO)

Este documento responde a todas las solicitudes recibidas en *Novedades y Solicitudes — Dashboard de Cobranza* (COPACOL S.A.S., Mayo 2026). Incluye cambios entregados, respuestas a las preguntas abiertas, pendientes que dependen de fuentes externas y un bloque final con mejoras propuestas por SINAPSIO.

## 1. Cambios entregados

### 1.1 Rangos de edad de cartera

Se reemplazaron los rangos antiguos (1-30, 31-60…) por la escala operativa:

- Vigente
- -8 a 0 días (por vencer en la próxima semana)
- 1-4 días
- 5-15 días
- 16-30 días
- 31-60 días
- 61-90 días
- 91-120 días
- 121-180 días
- +181 días

El filtro de Edad en la barra global, la tabla de Asesores, el modal individual de asesor y el chip de mora en la ficha de cliente usan esta misma escala.

### 1.2 Semáforo de cartera vencida

Corregido. El color se calcula dinámicamente y se refleja tanto en el "panel semáforo" del Tablero como en la etiqueta superior:

- Verde: ≤ 8%
- Amarillo: 8-15%
- Rojo: > 15%

### 1.3 Indicadores nuevos en Tablero

Se agregaron:

- Cartera Platam 30 días
- Cartera Platam 60 días
- Sin gestión 5d (clientes vencidos sin contacto en 5 días)
- Clientes en deterioro (vs. corte anterior)
- Rotación cartera (días)
- Promesas cumplidas (% real)
- Gestión cobro (% cobertura semanal real)

### 1.4 Ruta de gestión clicable

Las cuatro barras se renombraron y son clicables:

- Ciclo bot → 1-4 días vencido
- Gestión humana → 5-15 días vencido
- Negociación → 16-30 días vencido
- Plan especial → +31 días vencido

Cada clic abre la pestaña Clientes filtrada por el rango correspondiente.

### 1.5 Pareto y Acción diaria diferenciados

- Pareto (Inteligencia): "Ordenado por $ vencido — concentración del saldo"
- Acción diaria (Tablero): "Ordenado por días de mora — gestionar hoy"

### 1.6 Descarga de cartera en Excel

Botón "Descargar Excel" en la pestaña Cartera. Genera un CSV con BOM UTF-8 que abre directamente en Excel (formato `cartera-copacol-AAAA-MM-DD.csv`). Respeta los filtros activos: asesor, edad, búsqueda y saldo mínimo. Para descarga por asesor: aplicar el filtro de Vendedor y luego pulsar el botón.

### 1.7 Botones uniformes en Clientes

Los tres botones (Tel, WA, Ficha) tienen ancho mínimo y altura unificados. La cuadrícula de acciones usa tres columnas iguales.

### 1.8 Ficha de cliente enriquecida

La ficha ahora muestra:

- Asesor asignado
- Condición real de crédito (Contado / 45 / 60 / Platam)
- Plazo real en días o "Fallback cartera"
- Cupo de crédito
- Ciudad (nombre cuando hay match en catálogo)
- Registro plataforma (proxy de fecha de creación)
- Teléfono y dirección comercial
- Botones rápidos: "+ Registrar gestión", "+ Registrar promesa", "Cambiar asesor", "Llamar", "Preparar WhatsApp"

### 1.9 Filtro de cuentas Siigo en la carga

La importación toma únicamente cuentas que comienzan con:

- 13050501
- 13050522

Las demás filas se descartan al parsear y nunca llegan a Supabase. El preview muestra "Cuentas Siigo: 13050501 / 13050522" como recordatorio operativo.

### 1.10 Identidad visual COPACOL

- Primario: #001871 (encabezados, navegación, botones primarios)
- Secundario: #FF6900 (acentos, alertas, destacados)
- Tipografía: Canaro Bold como primera opción para títulos, Canaro Regular para textos de apoyo. Si el navegador no la tiene, cae a Geist + Fraunces para no romper la composición.

### 1.11 Tendencia semanal de cartera vencida

Panel nuevo en Inteligencia con los últimos 8 cortes confirmados, leídos directamente del historial real (`copacol_import_batches`). Cada columna se colorea por semáforo y muestra el % vencido y la fecha de corte. No requiere generar snapshots adicionales: cada carga de cartera ya produce un punto en la serie.

### 1.12 Clientes en deterioro

Panel y KPI nuevos. Comparan el batch activo contra el inmediatamente anterior por NIT. Listan los clientes que aumentaron su saldo vencido o sus días de mora máximos, ordenados por mayor incremento. Cada tarjeta abre la ficha del cliente.

### 1.13 Módulo de compromisos de pago (espejo de Supabase)

Pestaña nueva "Compromisos" en la navegación lateral. Muestra todas las promesas registradas en `copacol_promesas_pago` con:

- Cliente (clic abre ficha)
- NIT
- Fecha de compromiso
- Monto prometido
- Estado calculado (Cumplida / Pendiente / Incumplida)
- Asesor asignado
- Auxiliar/usuario que la registró
- Observación
- Acciones: marcar cumplida (✓), marcar incumplida (✗), editar (✎), eliminar (🗑)

Filtros: por estado (todas / pendientes / cumplidas / incumplidas). KPIs en la cabecera: total, cumplidas, pendientes, incumplidas, % cumplidas.

Botón "+ Nueva promesa" abre un modal con buscador de clientes (búsqueda por nombre, NIT o asesor sobre los 473 clientes activos), fecha de compromiso, monto y observación. Al editar también permite cambiar el estado.

Reglas de marcado automático (ya implementadas en el dashboard):

- Pendiente: registrada y aún no vencida sin pago reportado.
- Cumplida: existe `copacol_pagos_reportados` para el NIT con monto ≥ 85% del prometido, posterior a la fecha de creación.
- Incumplida: fecha de compromiso ya pasó sin pago coincidente, o quedó marcada manualmente.

Cuando Siigo provea recaudo automático, ese mismo cruce se ejecutará contra los pagos reales sin cambiar la interfaz.

### 1.14 Gestión de asesores por cliente

Botón "Cambiar asesor" en la ficha del cliente. Abre un modal que permite:

- Asignar un asesor existente del catálogo (dropdown poblado con los 14 asesores activos y su número de clientes).
- Crear/asignar un asesor nuevo ingresando código + nombre directamente.
- Quitar el asesor (desasignar, deja al cliente sin asesor).

Endpoint: `PATCH /api/client/{nit}/asesor`. Tras guardar, el dashboard se recarga para reflejar el cambio en KPIs, semáforo y mapa por asesor.

Aclaración operativa: un asesor "desaparece" del tablero cuando ya no tiene ningún cliente asignado en el corte activo. Por eso "quitar asesor" en todos sus clientes es equivalente a darlo de baja del dashboard.

## 2. Respuestas a preguntas del documento

### 2.1 ¿Cuál es el objetivo del campo Saldo Mínimo?

Filtra clientes o facturas con saldo igual o mayor al valor que digites. Sirve para tres usos operativos:

- Enfocarse en cartera de alto impacto (ej. ≥ $1.000.000 para revisar a quién priorizar la gestión humana).
- Limpiar ruido de saldos pequeños cuando hay muchas facturas chicas.
- Ajustar el Pareto y la Acción diaria a tu meta de recaudo del día.

### 2.2 ¿Qué mide "Top 10 concentra"?

Mide qué porcentaje del saldo total cobrable está concentrado en los 10 clientes con mayor saldo. Es un indicador de riesgo de concentración:

- < 25%: cartera diversificada (riesgo bajo).
- 25-40%: concentración moderada (revisar exposición).
- > 40%: concentración alta — la salud de la cartera depende fuertemente de pocos clientes y conviene tener plan de respaldo (cobertura por seguro de crédito, límite de cupo, monitoreo más frecuente).

Al lado del porcentaje se muestra el saldo absoluto que esos 10 clientes suman.

### 2.3 ¿Qué es Contactabilidad y qué se puede hacer?

Es la proporción del saldo cuya gestión se puede ejecutar inmediatamente porque el cliente tiene teléfono útil registrado (al menos 3 dígitos distintos de cero). Acciones operativas:

- "Saldo con teléfono" alto → priorizar campaña de llamadas o WhatsApp masivo controlado.
- "Saldo sin teléfono útil" alto → tarea previa: depurar contactos desde Siigo o vía visita.
- Al hacer clic en cualquier cliente desde la pestaña Clientes el botón "Tel" se activa solo si hay número válido; los inválidos quedan grises para evidenciar la depuración pendiente.

### 2.4 ¿Dónde se descarga la cartera (general, por asesor) en Excel?

En la pestaña **Cartera detallada**, botón **Descargar Excel**. Comportamiento:

- Sin filtros → descarga la cartera general visible (todas las facturas).
- Filtro Vendedor seleccionado → descarga sólo las facturas de ese asesor.
- Filtros de edad, búsqueda y saldo mínimo se respetan en la descarga.

Formato actual: CSV con BOM UTF-8 que abre directo en Excel. Próxima iteración: convertir a XLSX nativo (ver Mejoras propuestas §4.10).

### 2.5 ¿Dónde se ven las conversaciones del bot?

Las conversaciones del bot viven en Chatwoot. Ruta operativa para Eliza y Natalia:

1. Iniciar sesión en `https://chatwoot.sinapsioia.com` (URL real entregada en handoff inicial).
2. Inbox "COPACOL Cobranzas" → vista "Conversaciones".
3. Filtros disponibles: por contacto (cliente o teléfono), por estado (abierto / pendiente / resuelto), por etiqueta (fase 0 / fase 1 / fase 2 / escalado).
4. Búsqueda libre por nombre o NIT del cliente.

Eliza, Natalia y el supervisor tienen perfil "Agente" con acceso a esa Inbox; el supervisor además ve KPIs en `Reports → Conversations`. Si alguna usuaria no tiene credenciales asignadas, solicitarlas a soporte SINAPSIO.

Una iteración futura embeberá la conversación dentro de la ficha del cliente del dashboard (ver Mejoras propuestas §4.6).

### 2.6 ¿Dónde quedan los compromisos del bot?

Tres rutas que apuntan a la misma tabla `copacol_promesas_pago`:

- **Dashboard → Compromisos** (nuevo): vista en tiempo real con filtros, KPIs y acciones.
- **Ficha del cliente → "+ Registrar promesa"**: para registro manual del equipo.
- **Bot vía n8n**: cuando el cliente promete pago en la Fase 1 o Fase 2, el flujo crea automáticamente el registro en la misma tabla y queda visible en las dos vistas anteriores.

El KPI "Promesas cumplidas" del Tablero ya no dice "Base por construir"; calcula el porcentaje real cruzando con `copacol_pagos_reportados`.

### 2.7 ¿Dónde se ven los soportes de pago recibidos por el bot?

Dos vías mientras se completa la galería integrada:

- En Chatwoot, dentro de la conversación del cliente, los comprobantes quedan como adjuntos en el mensaje original.
- En Supabase, la tabla `copacol_pagos_reportados` registra el evento (NIT, monto, método, estado, fecha) con referencia opcional al adjunto en Chatwoot.

La etapa siguiente es agregar al dashboard una sección "Pagos reportados" con miniaturas de los soportes adjuntos (ver Mejoras propuestas §4.7).

### 2.8 ¿Cómo modificar o eliminar un asesor?

Resuelto en esta iteración:

- **Modificar/Reasignar:** ficha del cliente → "Cambiar asesor" → seleccionar otro asesor del catálogo o crear uno nuevo. Aplica para 1 cliente a la vez.
- **Quitar asesor de un cliente:** mismo modal → botón "Quitar asesor".
- **Dar de baja a un asesor:** vaciar su cartera reasignando todos sus clientes. Cuando llegue a 0 clientes asignados, deja de aparecer en el tablero y en el catálogo automáticamente.

Reasignación masiva (1 acción para muchos clientes) está propuesta como mejora futura (§4.5).

### 2.9 Soporte técnico SINAPSIO

- **Canal primario:** WhatsApp soporte SINAPSIO — número que entregará Daniel Bolívar en el handoff.
- **Canal secundario:** correo `soporte@sinapsioia.com`.
- **SLA propuesto:**
  - Incidente crítico (caída del dashboard o del bot, pérdida de datos, error en carga que bloquea operación): respuesta en menos de 2 horas hábiles, resolución mismo día hábil.
  - Incidente alto (fallo parcial, KPI desactualizado, acceso a una pestaña): respuesta mismo día hábil, resolución en máximo 2 días hábiles.
  - Mejora funcional o ajuste cosmético: priorización conjunta en reunión semanal.

Horario hábil: Lunes a Viernes 8:00-18:00 (hora Colombia). Fuera de ese horario se atienden únicamente incidentes críticos.

## 3. Pendientes que dependen de fuentes externas

Estos puntos no se pueden cerrar 100% desde el dashboard porque requieren un dato que hoy no llega.

1. **DSO real con ventas mensuales:**
   - Necesario: extracción mensual de ventas (`copacol_facturacion_mes`) desde Siigo o reporte manual.
   - Una vez disponible, aplica `DSO = (Cartera total / Ventas del mes) × 30` y se compara contra benchmark 35-45 días.
   - Mientras tanto el indicador "Rotación cartera" usa promedio ponderado de días sobre la cartera abierta como aproximación.

2. **Promedio de días de pago por cliente:**
   - Necesario: historial de pagos con fecha real de recaudo desde Siigo (no sólo la promesa en Chatwoot).

3. **Promedio de compras por cliente:**
   - Necesario: ventas históricas acumuladas por cliente desde Siigo.

4. **Fecha real de creación/apertura del cliente:**
   - Necesario: campo `fecha_alta` en `BASE DE DATOS TERCEROS.xlsx` o integración directa Siigo.
   - Mientras tanto la ficha muestra "Registro plataforma" como referencia secundaria.

5. **Dirección de entrega separada de la comercial:**
   - Necesario: que el archivo de cartera o la base de terceros incluya la dirección de despacho como columna independiente.

## 4. Mejoras propuestas por SINAPSIO

Estas son mejoras que recomendamos priorizar en el roadmap. Las dejamos para que COPACOL elija cuáles activar.

### 4.1 Snapshot semanal automático (red de seguridad)

Programar un cron en n8n cada domingo a las 23:00 que guarde un snapshot resumen (`copacol_import_batches` con `source = 'snapshot_semanal'`) aunque COPACOL no haya cargado cartera esa semana. Beneficio: la tendencia semanal nunca queda con huecos y el KPI "Clientes en deterioro" siempre tiene base de comparación.

### 4.2 Catálogo dinámico de ciudades

Hoy hay 13 códigos de ciudad mapeados a mano. Recomendamos importar el catálogo maestro de ciudades desde Siigo o cargar el archivo de terceros con la columna nombre de ciudad para resolver los 100% de los códigos sin mantenimiento manual.

### 4.3 Integración WhatsApp ↔ Compromisos

Cuando el bot detecte en la conversación una promesa de pago (fecha + monto), crear automáticamente un registro en `copacol_promesas_pago` con `registrado_por = bot`. Hoy ya está la tabla y la pantalla, sólo falta el nodo n8n que parsee la respuesta del cliente.

### 4.4 Asignación diaria automática por auxiliar

Cron de n8n a las 6:00 AM que distribuya los clientes vencidos sin gestión 5d entre Eliza y Natalia según reglas (zona, ticket, asesor histórico). Generar lista visible en una pestaña "Mi día" filtrada por usuario logueado. El KPI "Gestión cobro" ya está cableado para reflejarlo.

### 4.5 Reasignación masiva de asesor

Una vista de administración para reasignar todos los clientes de un asesor a otro en una sola operación (ej. cuando un asesor sale y otro asume su cartera). Hoy la operación es cliente por cliente.

### 4.6 Conversación del bot embebida en la ficha del cliente

Mostrar dentro del drawer de cliente las últimas 10 interacciones con el bot (mensajes, hora, fase) consumiendo la API de Chatwoot. Reduciría el cambio de pestaña entre dashboard y Chatwoot durante la gestión.

### 4.7 Sección "Pagos reportados" con galería de soportes

Nueva pestaña que muestre los comprobantes adjuntos enviados por los clientes al bot, con miniaturas, búsqueda por NIT y botón para marcar verificado. Hoy esa info se ve sólo dentro de Chatwoot.

### 4.8 Auditoría de cambios de asesor

Tabla `copacol_log_asesores` con quién cambió a qué cliente cuándo. Hoy el PATCH es directo sin historial; agregar logs facilita auditoría y reverter cambios accidentales.

### 4.9 Roles y permisos en el dashboard

Diferenciar roles (admin / supervisor cobranza / auxiliar / asesor / gerencia) y restringir acciones sensibles (eliminar promesas, cambiar asesor, carga de cartera) por rol. Hoy todo usuario autenticado puede ejecutar todo.

### 4.10 Descarga en XLSX nativo

Cambiar el CSV actual por XLSX real con varias hojas (Cartera, Asesores, Aging), formato condicional para vencido y filtros automáticos. Mantenemos compatibilidad con Excel sin sacrificar formato.

### 4.11 Notificaciones cuando una promesa vence

Email o push al asesor responsable y al auxiliar cuando una promesa pasa a "Incumplida" automáticamente. Permite reacción inmediata en lugar de esperar a que alguien revise el panel.

### 4.12 Validación bloqueante en carga

Si el porcentaje de facturas en "Fallback cartera" (sin plazo real) supera un umbral configurable (ej. 20%), pedir confirmación adicional antes de aplicar la importación. Evita que un cambio en `BASE DE DATOS TERCEROS` rompa los cálculos sin que nadie lo note.

### 4.13 Integración API Siigo directa

Cuando COPACOL confirme licencia, reemplazar el paso Excel manual por consumo directo de la API de Siigo. Beneficios: cartera actualizada en tiempo real, ventas mensuales para DSO, historial de pagos para promedio días de pago, fecha de alta de cliente.

### 4.14 Vista móvil optimizada para auxiliares

Eliza y Natalia trabajan mucho desde celular. Optimizar el drawer del cliente y la lista de compromisos para pantalla pequeña, con botón flotante de "Registrar gestión" y acceso rápido a llamada / WhatsApp.

## 5. Reglas operativas del bot (referencia)

Mantenidas tal cual fueron acordadas, aquí como recordatorio:

1. **Descuentos financieros:** el bot no ofrece descuentos por pronto pago salvo que el cliente pregunte. En ese caso responde el descuento aplicable y escala al asesor para aprobación final.

2. **Clientes Platam:** el bot no gestiona cobranza Platam. Mensaje de redirección a Eliza o Natalia.

3. **Ciclo máximo del bot:** 3 mensajes automáticos por ciclo, uno por fase.
   - Día -3: aviso preventivo (1 mensaje).
   - Día 2 vencido: validación (1 mensaje).
   - Día 4 vencido: primer cobro activo (1 mensaje + escalamiento).
   - Días 6-8: 100% humano, sin bot.

4. **Conversaciones, soportes y compromisos:** ya integrados con Chatwoot y con el módulo de Compromisos del dashboard (ver §2.5, §2.6, §2.7).

5. **Asesores:** un asesor desaparece del tablero cuando ya no tiene clientes asignados. La gestión se hace ahora desde la ficha del cliente (§1.14).

6. **Soporte:** canal, contactos y SLA en §2.9.
