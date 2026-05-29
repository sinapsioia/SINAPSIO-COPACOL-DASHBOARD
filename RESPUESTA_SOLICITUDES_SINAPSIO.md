# Respuesta a Solicitudes SINAPSIO - Dashboard COPACOL

Fecha de actualización: 2026-05-28

## Cambios aplicados en el dashboard

1. Rangos de edad de cartera actualizados:
   - Vigente
   - -8 a 0 días
   - 1-4 días
   - 5-15 días
   - 16-30 días
   - 31-60 días
   - 61-90 días
   - 91-120 días
   - 121-180 días
   - +181 días

2. Semáforo operativo corregido:
   - Verde: cartera vencida <= 8%
   - Amarillo: > 8% y <= 15%
   - Rojo: > 15%

3. Indicadores nuevos en Tablero:
   - Platam 30 días
   - Platam 60 días
   - Clientes vencidos sin gestión en 5 días

4. Ruta de gestión actualizada:
   - Ciclo bot: 1-4 días
   - Gestión humana: 5-15 días
   - Negociación: 16-30 días
   - Plan especial: +31 días
   - Las barras son clicables y llevan a Clientes filtrados.

5. Pareto y Acción diaria diferenciados:
   - Pareto: "Ordenado por $ vencido — concentración del saldo"
   - Acción diaria: "Ordenado por días de mora — gestionar hoy"

6. Cartera:
   - Se agregó botón "Descargar Excel" en Cartera detallada.
   - Descarga las facturas visibles respetando filtros de asesor, edad, búsqueda y saldo mínimo.

7. Clientes:
   - Botones Tel, WA y Ficha quedan con el mismo ancho y alto.
   - Se agregó botón "Sin gestión 5d".
   - La ficha ahora muestra registro en plataforma.
   - La ficha ya permite registrar gestión y registrar promesa con fecha y monto.

8. Carga:
   - La importación desde dashboard filtra la cartera de Siigo para tomar solo cuentas que empiecen por:
     - 13050501
     - 13050522
   - El texto visible ya habla de "base de datos" y no de términos técnicos.

9. Identidad visual:
   - Color primario COPACOL: #001871
   - Color secundario COPACOL: #FF6900
   - Se dejó Canaro como primera opción tipográfica cuando esté disponible en el navegador.

## Respuestas funcionales para el cliente

### Saldo mínimo
El campo Saldo mínimo sirve para enfocar el análisis en clientes o facturas por encima de un valor definido. Es útil para priorizar la cartera de mayor impacto económico y reducir ruido operativo cuando hay muchos documentos pequeños.

### Top 10 concentra
"Top 10 concentra" indica qué porcentaje de la cartera está concentrado en los 10 clientes con mayor saldo. Sirve para entender riesgo de concentración: si el porcentaje es alto, pocas cuentas explican gran parte del recaudo pendiente.

### Contactabilidad
Contactabilidad mide qué parte del saldo tiene teléfono útil registrado. Ayuda a identificar si la gestión puede ejecutarse por llamada/WhatsApp o si primero se debe depurar información de contacto.

### Ciudades
Hoy el archivo fuente trae código de ciudad, por eso el dashboard muestra códigos. Para mostrar nombres se requiere cargar una tabla maestra de ciudades de Siigo o un catálogo de equivalencias código -> nombre.

### Rotación de cartera / DSO real
Para calcular DSO real se necesita el valor de ventas del mes desde Siigo. La fórmula acordada es:

`DSO = (Cartera total / Ventas del mes) * 30`

El dashboard ya tiene la cartera total; falta conectar ventas mensuales para que el indicador sea automático y comparable contra benchmark 35-45 días.

## Pendientes que requieren fuente de datos o alcance adicional

1. Promedio de días de pago por cliente:
   - Requiere historial de pagos o fecha real de recaudo.

2. Promedio de compras por cliente:
   - Requiere ventas/facturación histórica, no solo cartera abierta.

3. Fecha real de creación/apertura del cliente:
   - Requiere campo desde Siigo o base maestra de terceros. Actualmente se muestra registro en plataforma.

4. Dirección de entrega:
   - Requiere que el archivo o integración incluya dirección de entrega separada de dirección comercial.

5. Tendencia semanal de cartera vencida:
   - Requiere guardar snapshots semanales automáticos. Recomendación: programar snapshot cada domingo y graficar últimas 8 semanas con meta 8%.

6. Clientes en deterioro esta semana:
   - Depende de los snapshots semanales para comparar rango anterior vs rango actual.

7. Promesas cumplidas automático:
   - Ya se puede registrar promesa desde la ficha.
   - Para marcar Cumplida/Incumplida automáticamente falta cruzar pagos de Siigo contra fecha y monto de promesa.

8. Gestión cobro automática por auxiliar:
   - Ya existe registro manual de gestión.
   - Para KPI completo falta asignación diaria por auxiliar y reglas de cobertura.

## Reglas para bot de cobranza

1. Descuentos financieros:
   - El bot no debe ofrecer descuentos de forma proactiva.
   - Solo debe informar condiciones si el cliente pregunta y debe escalar al asesor para aprobación.

2. Clientes Platam:
   - El bot COPACOL no debe gestionar cobranza de clientes Platam.
   - Debe redirigir a proceso Platam o a Eliza/Natalia según regla interna.

3. Ciclo máximo del bot:
   - Día -3: aviso preventivo, máximo 1 mensaje.
   - Día 2 vencido: validar si ya pagó, máximo 1 mensaje.
   - Día 4 vencido: primer cobro activo, máximo 1 mensaje y escalamiento.
   - Días 6-8: gestión humana, sin bot.
   - Total máximo: 3 mensajes automáticos por ciclo.

4. Conversaciones, soportes y compromisos:
   - Conversaciones y soportes recibidos por WhatsApp deben consultarse en Chatwoot mientras no exista módulo embebido en el dashboard.
   - Los compromisos del bot deben conectarse al módulo de promesas para que aparezcan en la ficha del cliente.

5. Asesores:
   - Un asesor desaparece del dashboard cuando no tenga cartera asignada en el corte activo.
   - Si sigue apareciendo, debe validarse si el archivo de Siigo trae documentos o saldos asociados a ese código.

6. Soporte:
   - Canal sugerido: WhatsApp o correo de soporte SINAPSIO.
   - SLA sugerido: incidentes críticos de carga o acceso el mismo día hábil; ajustes funcionales bajo priorización.
