const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat("es-CO");
const pct = new Intl.NumberFormat("es-CO", { style: "percent", maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
});
const clockTime = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "medium",
});

let dashboard = null;
let tableMode = "all";
let currentAdvisorReport = "";
let currentPage = "tablero";
let supabaseConfig = null;
let importToken = null;
let drawerNit = null;
let importHistory = [];
let clientNoGestionMode = false;
let asesoresGestion = { summary: {}, asesores: [], catalogo: [], clientes: [] };
let advisorManageFilter = "all";
let advisorManageSearch = "";
let advisorManageSelected = new Set();

const agingLabels = {
  vigente: ["Vigente", "var(--green)"],
  por_vencer_8: ["-8 a 0 días", "var(--green)"],
  "1_4": ["1-4 días", "var(--yellow)"],
  "5_15": ["5-15 días", "var(--orange)"],
  "16_30": ["16-30 días", "#ea580c"],
  "31_60": ["31-60 días", "var(--orange)"],
  "61_90": ["61-90 días", "var(--red)"],
  "91_120": ["91-120 días", "#e5484d"],
  "121_180": ["121-180 días", "#9f2d20"],
  "181_plus": ["+181 días", "#5b1a14"],
};

const agingKeys = Object.keys(agingLabels);
const overdueAgingKeys = ["1_4", "5_15", "16_30", "31_60", "61_90", "91_120", "121_180", "181_plus"];

function emptyAging() {
  return Object.fromEntries(agingKeys.map((key) => [key, 0]));
}

const conditionLabels = {
  platam_30d: ["Platam 30 días", "#3b82f6"],
  platam_60d: ["Platam 60 días", "#2563eb"],
  credito_45d: ["COPACOL 45 días", "#f97316"],
  credito_60d: ["COPACOL 60 días", "#60a5fa"],
  credito_otro: ["Crédito otro", "#8b5cf6"],
  contado: ["Contado", "#10b981"],
  saldos_a_favor: ["Saldos a favor", "#dc2626"],
  "1305050100": ["1305050100 · Clientes nacionales", "#64748b"],
  "1305052200": ["1305052200 · Clientes especiales", "#3b82f6"],
  "1380200200": ["1380200200 · Deudores varios", "#f97316"],
  "1380200100": ["1380200100 · Deudores varios", "#f59e0b"],
  "1365950100": ["1365950100 · Cuentas por cobrar", "#8b5cf6"],
  "1330150100": ["1330150100 · Anticipos / terceros", "#10b981"],
  "1330050100": ["1330050100 · Anticipos", "#14b8a6"],
  "1380950100": ["1380950100 · Diversos", "#0ea5e9"],
  "2805050100": ["2805050100 · Saldos a favor", "#dc2626"],
  sin_condicion: ["Sin condición", "#64748b"],
  sin_condicion_real: ["Sin condición real", "#64748b"],
};

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function status(text) {
  setText("syncState", text);
}

function updateClock() {
  setText("currentClock", `Hora local: ${clockTime.format(new Date())}`);
}

function amount(value) {
  return Number(value || 0);
}

function isUncataloguedSeller(row) {
  const code = String(row.asesor_codigo || row.vendedor_codigo || "").trim();
  const name = String(row.asesor_nombre || row.vendedor_nombre || "").trim().toUpperCase();
  return code === "0" || name.includes("NO CATALOGADO");
}

function moneyM(value) {
  return `$${(amount(value) / 1000000).toLocaleString("es-CO", { maximumFractionDigits: 2 })}M`;
}

function docsClientsDetail(facturas, clientes) {
  const docsText = `${number.format(facturas || 0)} documentos`;
  return clientes ? `${docsText} · ${number.format(clientes)} clientes` : docsText;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateTime.format(date);
}

function signedNumber(value) {
  const n = amount(value);
  if (!n) return "Sin cambio";
  return `${n > 0 ? "+" : ""}${number.format(n)}`;
}

function signedMoneyM(value) {
  const n = amount(value);
  if (!n) return "Sin cambio";
  return `${n > 0 ? "+" : ""}${moneyM(n)}`;
}

function conditionValue(key) {
  return amount(((dashboard.view || dashboard).condition_mix.find((item) => item.condicion === key) || {}).saldo);
}

function conditionPrefixValue(prefixes, mode = "all") {
  return (dashboard.view || dashboard).condition_mix
    .filter((item) => prefixes.some((prefix) => String(item.condicion || "").startsWith(prefix)))
    .reduce((sum, item) => {
      const value = amount(item.saldo);
      if (mode === "positive" && value <= 0) return sum;
      if (mode === "negative" && value >= 0) return sum;
      return sum + value;
    }, 0);
}

function conditionLabel(key) {
  return (conditionLabels[key] || [key || "Sin condición"])[0];
}

function semaforoMeta(ratio) {
  if (ratio <= 0.08) return { key: "green", label: "Verde", copy: "Cartera dentro de meta operativa" };
  if (ratio <= 0.15) return { key: "yellow", label: "Amarillo", copy: "Seguimiento diario requerido" };
  return { key: "red", label: "Rojo", copy: "Priorizar cartera vencida hoy" };
}

function advisorInvoices(code) {
  return dashboard.invoices.filter((invoice) => invoice.asesor_codigo === code);
}

function advisorClients(code) {
  return dashboard.clients.filter((client) => client.asesor_codigo === code);
}

function advisorManageKey(row) {
  if (row.advisor_key) return row.advisor_key;
  if (isUncataloguedSeller(row)) return "__no_catalogado";
  const code = String(row.asesor_codigo || "").trim();
  const name = String(row.asesor_nombre || "").trim();
  if ((!code && !name) || code.toLowerCase() === "sin_codigo" || name.toUpperCase() === "SIN ASESOR") return "__sin_asesor";
  return `${code}|${name}`;
}

function cleanPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits || /^0+$/.test(digits)) return "";
  if (digits.length === 10) return `57${digits}`;
  return digits;
}

function activeFilters() {
  return {
    term: $("globalSearch").value.trim().toLowerCase(),
    seller: $("sellerFilter").value,
    aging: $("agingFilter").value,
    minAmount: Number($("minAmount").value || 0),
  };
}

function matchesText(row, term) {
  if (!term) return true;
  return [row.cliente, row.nit, row.numero_factura, row.asesor_nombre, row.ciudad, row.estado]
    .join(" ")
    .toLowerCase()
    .includes(term);
}

function filteredInvoices(useMode = true) {
  const filters = activeFilters();
  let rows = dashboard.invoices;
  if (useMode && tableMode === "overdue") rows = dashboard.overdue_invoices;
  if (useMode && tableMode === "soon") rows = dashboard.due_soon;

  return rows.filter((row) => {
    const sellerOk = filters.seller === "all" || row.asesor_codigo === filters.seller;
    const agingOk = filters.aging === "all" || row.aging_bucket === filters.aging;
    const amountOk = filters.minAmount <= 0 || amount(row.monto) >= filters.minAmount;
    return sellerOk && agingOk && amountOk && matchesText(row, filters.term);
  });
}

function filteredClients() {
  const filters = activeFilters();
  return dashboard.clients.filter((client) => {
    const sellerOk = filters.seller === "all" || client.asesor_codigo === filters.seller;
    const amountOk = filters.minAmount <= 0 || amount(client.total_saldo) >= filters.minAmount;
    const textOk =
      !filters.term ||
      [client.nit, client.razon_social, client.asesor_nombre, client.ciudad, client.telefono]
        .join(" ")
        .toLowerCase()
        .includes(filters.term);
    const clientBucket = agingBucketFromDays(amount(client.dias_mora_max), amount(client.total_vencido));
    const agingOk = filters.aging === "all" || clientBucket === filters.aging;
    const noGestionOk = !clientNoGestionMode || isNoGestion5d(client);
    return sellerOk && amountOk && textOk && agingOk && noGestionOk;
  });
}

function isNoGestion5d(client) {
  if (amount(client.total_vencido) <= 0) return false;
  const raw = client.ultimo_contacto;
  if (!raw) return true;
  const last = new Date(raw);
  if (Number.isNaN(last.getTime())) return true;
  return (Date.now() - last.getTime()) / 86400000 >= 5;
}

function agingBucketFromDays(days, overdueAmount = 1) {
  if (amount(overdueAmount) <= 0) return days >= -8 ? "por_vencer_8" : "vigente";
  if (days < -8) return "vigente";
  if (days <= 0) return "por_vencer_8";
  if (days <= 4) return "1_4";
  if (days <= 15) return "5_15";
  if (days <= 30) return "16_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  if (days <= 120) return "91_120";
  if (days <= 180) return "121_180";
  return "181_plus";
}

function buildSellerAging(rows) {
  const grouped = {};
  rows.forEach((invoice) => {
    const code = invoice.asesor_codigo || "sin_codigo";
    const row = grouped[code] || {
      codigo: code,
      nombre: invoice.asesor_nombre || "Sin asesor",
      total: 0,
      vencido: 0,
      ...emptyAging(),
      pct_vencido: 0,
    };
    const rawValue = amount(invoice.monto);
    row.total += rawValue;
    row[invoice.aging_bucket] += rawValue;
    if (amount(invoice.dias_mora) > 0) row.vencido += rawValue;
    grouped[code] = row;
  });
  return Object.values(grouped)
    .map((row) => ({ ...row, pct_vencido: row.total ? row.vencido / row.total : 0 }))
    .sort((a, b) => b.total - a.total);
}

function buildView() {
  const invoices = filteredInvoices(false);
  const clients = filteredClients();
  const managedInvoices = invoices.filter((invoice) => !isUncataloguedSeller(invoice));
  const uncataloguedInvoices = invoices.filter(isUncataloguedSeller);
  const managedClients = clients.filter((client) => !isUncataloguedSeller(client));
  const uncataloguedClients = clients.filter(isUncataloguedSeller);
  const aging = emptyAging();
  const conditionMap = {};
  const dueSoon = [];
  let totalVencido = 0;
  let totalVigente = 0;
  let facturasVencidas = 0;
  let moraSum = 0;
  let weightedDays = 0;

  managedInvoices.forEach((invoice) => {
    const rawValue = amount(invoice.monto);
    const days = amount(invoice.dias_mora);
    aging[invoice.aging_bucket] += rawValue;
    weightedDays += Math.max(days, 0) * rawValue;
    const conditionKey = rawValue < 0 ? "saldos_a_favor" : (invoice.condicion_pago_real || invoice.condicion_pago || "sin_condicion_real");
    conditionMap[conditionKey] = (conditionMap[conditionKey] || 0) + rawValue;
    if (days > 0) {
      totalVencido += rawValue;
      facturasVencidas += 1;
      moraSum += days;
    } else {
      totalVigente += rawValue;
      if (days >= -7) dueSoon.push(invoice);
    }
  });

  const totalSaldo = totalVencido + totalVigente;
  const importedTotal = invoices.reduce((sum, invoice) => sum + amount(invoice.monto), 0);
  const importedVencido = invoices.reduce((sum, invoice) => sum + (amount(invoice.dias_mora) > 0 ? amount(invoice.monto) : 0), 0);
  const uncataloguedTotal = uncataloguedInvoices.reduce((sum, invoice) => sum + amount(invoice.monto), 0);
  const uncataloguedVencido = uncataloguedInvoices.reduce((sum, invoice) => sum + (amount(invoice.dias_mora) > 0 ? amount(invoice.monto) : 0), 0);
  const uncataloguedVigente = uncataloguedTotal - uncataloguedVencido;
  const uncataloguedFavor = uncataloguedInvoices.reduce((sum, invoice) => {
    const value = amount(invoice.monto);
    return value < 0 ? sum + Math.abs(value) : sum;
  }, 0);
  const sellerRows = buildSellerAging(managedInvoices);
  const condition_mix = Object.entries(conditionMap)
    .map(([condicion, saldo]) => ({ condicion, saldo }))
    .sort((a, b) => b.saldo - a.saldo);

  return {
    invoices,
    clients,
    due_soon: dueSoon,
    overdue_invoices: invoices.filter((invoice) => amount(invoice.dias_mora) > 0),
    aging,
    condition_mix,
    seller_aging: sellerRows,
    sellers: sellerRows.map((row) => ({ codigo: row.codigo, nombre: row.nombre, saldo: row.total, vencido: row.vencido, clientes: managedClients.filter((c) => c.asesor_codigo === row.codigo).length })),
    cities: Object.entries(
      managedClients.reduce((acc, client) => {
        acc[client.ciudad || "Sin ciudad"] = (acc[client.ciudad || "Sin ciudad"] || 0) + amount(client.total_saldo);
        return acc;
      }, {}),
    )
      .map(([ciudad, saldo]) => ({ ciudad, saldo }))
      .sort((a, b) => b.saldo - a.saldo),
    summary: {
      ...dashboard.summary,
      total_saldo: totalSaldo,
      total_vencido: totalVencido,
      total_vigente: totalVigente,
      clientes: managedClients.length,
      clientes_vencidos: managedClients.filter((client) => amount(client.total_vencido) > 0).length,
      facturas: managedInvoices.length,
      facturas_vencidas: facturasVencidas,
      mora_promedio: facturasVencidas ? moraSum / facturasVencidas : 0,
      rotacion_cartera_dias: totalSaldo ? weightedDays / totalSaldo : 0,
      concentracion_top10: managedClients.slice(0, 10).reduce((sum, client) => sum + amount(client.total_saldo), 0),
      concentracion_top10_pct: totalSaldo ? managedClients.slice(0, 10).reduce((sum, client) => sum + amount(client.total_saldo), 0) / totalSaldo : 0,
      over_90: aging["91_120"] + aging["121_180"] + aging["181_plus"],
      over_90_pct: totalSaldo ? (aging["91_120"] + aging["121_180"] + aging["181_plus"]) / totalSaldo : 0,
      cartera_importada: {
        total_saldo: importedTotal,
        total_vencido: importedVencido,
        total_vigente: importedTotal - importedVencido,
        clientes: clients.length,
        facturas: invoices.length,
      },
      cartera_no_catalogada: {
        total_saldo: uncataloguedTotal,
        total_vencido: uncataloguedVencido,
        total_vigente: uncataloguedVigente,
        clientes: uncataloguedClients.length,
        facturas: uncataloguedInvoices.length,
        saldos_a_favor: uncataloguedFavor,
      },
    },
  };
}

async function loadDashboard() {
  status("Actualizando...");
  const response = await fetch("/api/dashboard", { cache: "no-store" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "No se pudo cargar la base de datos");
  }
  dashboard = await response.json();
  hydrateFilters();
  renderDashboard();
  status(`Datos actualizados ${new Date().toLocaleTimeString("es-CO")}`);
  if (currentPage === "historial") loadImportHistory();
}

async function loadImportHistory() {
  const grid = $("historyGrid");
  if (grid) grid.innerHTML = '<p class="drawer-empty">Cargando historial…</p>';
  try {
    const response = await fetch("/api/imports", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo cargar historial");
    importHistory = payload.batches || [];
    renderImportHistory();
  } catch (err) {
    if (grid) grid.innerHTML = `<p class="drawer-empty">Error: ${escapeHtml(err.message)}</p>`;
    setText("historyCount", "No se pudo cargar historial");
  }
}

function hydrateFilters() {
  const current = $("sellerFilter").value || "all";
  const options = dashboard.sellers
    .map((seller) => `<option value="${seller.codigo}">${seller.nombre}</option>`)
    .join("");
  $("sellerFilter").innerHTML = `<option value="all">Todos</option>${options}`;
  $("sellerFilter").value = [...$("sellerFilter").options].some((option) => option.value === current) ? current : "all";
}

function renderDashboard() {
  dashboard.view = buildView();
  const view = dashboard.view;
  const summary = view.summary;
  const overdueRatio = summary.total_saldo ? summary.total_vencido / summary.total_saldo : 0;
  const credito60 = conditionValue("credito_60d");
  const credito45 = conditionValue("credito_45d");
  const platam30 = conditionValue("platam_30d");
  const platam60 = conditionValue("platam_60d");
  const contado = conditionValue("contado");
  const saldosFavor = amount(summary.saldos_a_favor) || Math.abs(conditionValue("saldos_a_favor"));

  setText("cutDate", summary.fecha_corte || "Sin fecha de corte");
  setText("lastUpdate", `Última actualización: ${formatDateTime(summary.ultima_actualizacion)}`);
  setText("heroTitle", `${number.format(summary.facturas)} documentos · ${number.format(summary.clientes)} clientes`);
  setText("kpiTotal", money.format(summary.total_saldo));
  setText("kpiImportedTotal", money.format(summary.cartera_importada?.total_saldo || 0));
  setText(
    "kpiImportedDetail",
    docsClientsDetail(summary.cartera_importada?.facturas, summary.cartera_importada?.clientes),
  );
  setText("kpiUncatalogued", money.format(summary.cartera_no_catalogada?.total_saldo || 0));
  setText(
    "kpiUncataloguedDetail",
    `${docsClientsDetail(summary.cartera_no_catalogada?.facturas, summary.cartera_no_catalogada?.clientes)} pendientes`,
  );
  setText("kpiOverdue", money.format(summary.total_vencido));
  setText("kpiCurrent", money.format(summary.total_vigente));
  setText("kpiAvgMora", `${number.format(Math.round(summary.mora_promedio || 0))} días`);
  setText("kpiClients", number.format(summary.clientes));
  setText("kpiOverdueClients", `${number.format(summary.clientes_vencidos)} clientes vencidos`);
  setText("kpiOverdueInvoices", `${number.format(summary.facturas_vencidas)} facturas vencidas`);
  setText("kpiConcentration", pct.format(summary.concentracion_top10_pct || 0));
  setText("kpiConcentrationMoney", money.format(summary.concentracion_top10 || 0));
  setText("overduePctCard", pct.format(overdueRatio));
  setText("overduePctHero", pct.format(overdueRatio));
  setText("kpiCredito60", moneyM(credito60));
  setText("kpiCredito60Pct", pct.format(credito60 / summary.total_saldo || 0));
  setText("kpiCredito45", moneyM(credito45));
  setText("kpiCredito45Pct", pct.format(credito45 / summary.total_saldo || 0));
  setText("kpiPlatam30", moneyM(platam30));
  setText("kpiPlatam30Pct", pct.format(platam30 / summary.total_saldo || 0));
  setText("kpiPlatam60", moneyM(platam60));
  setText("kpiPlatam60Pct", pct.format(platam60 / summary.total_saldo || 0));
  setText("kpiContado", moneyM(contado));
  setText("kpiContadoPct", saldosFavor ? `Saldos a favor ${moneyM(saldosFavor)}` : pct.format(contado / summary.total_saldo || 0));
  setText("goalOverdue", pct.format(overdueRatio));
  setText("goalOver90", pct.format(summary.over_90_pct || 0));
  setText("kpiNoGestion5d", number.format(dashboard.clients.filter(isNoGestion5d).length));
  const riskClass = overdueRatio <= 0.08 ? "risk-green" : overdueRatio <= 0.15 ? "risk-yellow" : "risk-red";
  const riskText = overdueRatio <= 0.08 ? "Verde: cartera controlada" : overdueRatio <= 0.15 ? "Amarillo: seguimiento diario" : "Rojo: priorizar vencidos";
  $("riskPill").className = `risk-pill ${riskClass}`;
  setText("riskPill", riskText);
  const semaforo = semaforoMeta(overdueRatio);
  $("semaforoPanel").className = `semaforo-panel ${semaforo.key}`;
  setText("semaforoStatus", `${semaforo.label} · ${pct.format(overdueRatio)}`);
  setText("semaforoDetail", `${semaforo.copy}. Meta verde hasta 8%.`);
  document.querySelectorAll(".semaforo-lights i").forEach((light) => {
    light.classList.toggle("active", light.dataset.light === semaforo.key);
  });
  setText("kpiRotation", `${number.format(Math.round(summary.rotacion_cartera_dias || 0))} días`);
  setText("kpiRotationDetail", "Promedio ponderado sobre cartera gestionable");
  const promesasResumen = dashboard.promesas_resumen || {};
  const gestionCobertura = dashboard.gestion_cobertura || {};
  const deterioroRows = dashboard.clientes_deterioro || [];
  const pctPromesas = amount(summary.pct_promesas_cumplidas);
  const pctCoberturaSemana = amount(summary.pct_gestion_cobertura_semana);
  const pctCoberturaHoy = amount(summary.pct_gestion_cobertura_hoy);
  setText(
    "kpiPromesasCumplidas",
    promesasResumen.total ? pct.format(pctPromesas) : "Sin registros",
  );
  setText(
    "kpiPromesasCumplidasDetail",
    promesasResumen.total
      ? `${number.format(promesasResumen.cumplidas || 0)} cumplidas · ${number.format(promesasResumen.pendientes || 0)} pendientes`
      : "Registra promesas desde la ficha del cliente",
  );
  setText(
    "kpiGestionCobro",
    gestionCobertura.total_clientes_vencidos ? pct.format(pctCoberturaSemana) : "Sin gestiones",
  );
  setText(
    "kpiGestionCobroDetail",
    gestionCobertura.total_clientes_vencidos
      ? `${number.format(gestionCobertura.contactados_semana || 0)} / ${number.format(gestionCobertura.total_clientes_vencidos)} vencidos cubiertos · hoy ${pct.format(pctCoberturaHoy)}`
      : "Sin clientes vencidos por cubrir",
  );
  setText("kpiDeterioro", number.format(deterioroRows.length));
  setText(
    "kpiDeterioroDetail",
    deterioroRows.length
      ? `Mayor incremento: ${moneyM(deterioroRows[0].delta_vencido)}`
      : "Sin clientes con incremento vs. corte anterior",
  );
  $("donut").style.setProperty("--pct", `${Math.min(100, overdueRatio * 100)}%`);
  $("overdueProgress").style.width = `${Math.min(100, overdueRatio * 100)}%`;

  renderConditionMix();
  renderAgingColumns();
  renderAging();
  renderSellers();
  renderCities();
  renderPriority();
  renderInsights();
  renderAdvisorTable();
  renderInvoices();
  renderClients();
  renderImportHistory();
}

function renderImportHistory() {
  const grid = $("historyGrid");
  if (!grid) return;
  setText("historyCount", importHistory.length ? `${number.format(importHistory.length)} plantillas registradas` : "Sin cargas registradas");
  if (!importHistory.length) {
    grid.innerHTML = '<p class="drawer-empty">Todavía no hay plantillas registradas.</p>';
    return;
  }
  grid.innerHTML = importHistory.map((batch) => {
    const active = batch.is_active ? "Activa" : "Histórica";
    const source = batch.source === "backfill" ? "Registro inicial" : batch.source || "dashboard";
    const changes = batch.cambios || {};
    return `
      <article class="history-card ${batch.is_active ? "active" : ""}">
        <div class="history-card-head">
          <div>
            <span class="history-badge">${escapeHtml(active)}</span>
            <h3>Corte ${escapeHtml(batch.fecha_corte || "-")}</h3>
            <p>${escapeHtml(batch.filename || source)}</p>
          </div>
          <time>${escapeHtml(formatDateTime(batch.imported_at || batch.created_at))}</time>
        </div>
        <div class="history-metrics">
          <div><span>Clientes</span><strong>${number.format(amount(batch.clientes))}</strong></div>
          <div><span>Facturas</span><strong>${number.format(amount(batch.facturas))}</strong></div>
          <div><span>Saldo</span><strong>${moneyM(batch.saldo_total)}</strong></div>
          <div><span>Vencido</span><strong>${moneyM(batch.total_vencido)}</strong></div>
        </div>
        <div class="history-meta-row">
          <span>${escapeHtml(batch.mode || "snapshot_replace")}</span>
          <span>${escapeHtml(batch.status || "completed")}</span>
          <span>${escapeHtml(batch.id || "").slice(0, 8)}</span>
        </div>
        ${changes.backfill ? '<p class="history-note">Registro inicial creado al habilitar historial.</p>' : ""}
      </article>
    `;
  }).join("");
}

function renderConditionMix() {
  const view = dashboard.view || dashboard;
  const positiveItems = view.condition_mix.filter((item) => amount(item.saldo) > 0);
  const total = positiveItems.reduce((sum, item) => sum + amount(item.saldo), 0) || 1;
  let cursor = 0;
  const stops = positiveItems.map((item) => {
    const [label, color] = conditionLabels[item.condicion] || [item.condicion, "#64748b"];
    const start = cursor;
    cursor += (item.saldo / total) * 100;
    return `${color} ${start}% ${cursor}%`;
  });
  $("mixDonut").style.background = stops.length ? `conic-gradient(${stops.join(", ")})` : "var(--surface-3)";
  $("mixLegend").innerHTML = view.condition_mix
    .map((item) => {
      const [label, color] = conditionLabels[item.condicion] || [item.condicion, "#64748b"];
      const value = amount(item.saldo);
      const share = value > 0 ? value / total : 0;
      return `
        <div class="legend-row">
          <i style="background:${color}"></i>
          <span>${label}</span>
          <strong>${moneyM(value)} <em>${value < 0 ? "Saldo a favor" : pct.format(share)}</em></strong>
        </div>
      `;
    })
    .join("");
}

function renderAgingColumns() {
  const entries = Object.entries((dashboard.view || dashboard).aging).filter(([key]) => key !== "vigente");
  const max = Math.max(...entries.map(([, value]) => value), 1);
  $("agingColumns").innerHTML = entries
    .map(([key, value]) => {
      const [label, color] = agingLabels[key];
      const height = Math.max(3, (value / max) * 100);
      return `
        <div class="column-item">
          <div class="column-value">${moneyM(value)}</div>
          <div class="column-track"><i style="height:${height}%;background:${color}"></i></div>
          <span>${label}</span>
        </div>
      `;
    })
    .join("");
}

function renderAging() {
  const entries = Object.entries((dashboard.view || dashboard).aging);
  const max = Math.max(...entries.map(([, value]) => value), 1);
  $("agingBars").innerHTML = entries
    .map(([key, value]) => {
      const [label, color] = agingLabels[key];
      const width = Math.max(2, (value / max) * 100);
      return `
        <div class="bar-row">
          <div class="bar-meta"><span>${label}</span><span>${money.format(value)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${color}"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderSellers() {
  $("sellerList").innerHTML = (dashboard.view || dashboard).sellers
    .slice(0, 10)
    .map((seller) => {
      const ratio = seller.saldo ? seller.vencido / seller.saldo : 0;
      return `
        <button class="rank-row rich advisor-mini" data-advisor="${seller.codigo}">
          <div>
            <strong>${seller.nombre}</strong>
            <span>${number.format(seller.clientes)} clientes · ${pct.format(ratio)} vencido</span>
          </div>
          <b>${money.format(seller.saldo)}</b>
        </button>
      `;
    })
    .join("");
  document.querySelectorAll(".advisor-mini").forEach((button) => {
    button.addEventListener("click", () => openAdvisorModal(button.dataset.advisor));
  });
}

function renderAdvisorTable() {
  const rows = (dashboard.view || dashboard).seller_aging || [];
  const totals = rows.reduce(
    (acc, row) => {
      ["total", ...agingKeys, "vencido"].forEach((key) => {
        acc[key] += amount(row[key]);
      });
      return acc;
    },
    { total: 0, ...emptyAging(), vencido: 0 },
  );
  const body = rows
    .map((row) => {
      const cls = row.pct_vencido <= 0.08 ? "ok" : row.pct_vencido <= 0.15 ? "late" : "critical";
      return `
        <tr class="advisor-row" data-advisor="${row.codigo}">
          <td>${row.nombre}</td>
          <td>${moneyM(row.total)}</td>
          <td>${moneyM(row["1_4"])}</td>
          <td>${moneyM(row["5_15"])}</td>
          <td>${moneyM(row["16_30"])}</td>
          <td>${moneyM(row["31_60"])}</td>
          <td>${moneyM(row["61_90"])}</td>
          <td>${moneyM(row["91_120"])}</td>
          <td>${moneyM(row["121_180"])}</td>
          <td>${moneyM(row["181_plus"])}</td>
          <td>${moneyM(row.vencido)}</td>
          <td><span class="status ${cls}">${pct.format(row.pct_vencido)}</span></td>
        </tr>
      `;
    })
    .join("");
  const totalPct = totals.total ? totals.vencido / totals.total : 0;
  $("advisorTable").innerHTML =
    body +
    `
      <tr class="total-row">
        <td>Total asesores</td>
        <td>${moneyM(totals.total)}</td>
        <td>${moneyM(totals["1_4"])}</td>
        <td>${moneyM(totals["5_15"])}</td>
        <td>${moneyM(totals["16_30"])}</td>
        <td>${moneyM(totals["31_60"])}</td>
        <td>${moneyM(totals["61_90"])}</td>
        <td>${moneyM(totals["91_120"])}</td>
        <td>${moneyM(totals["121_180"])}</td>
        <td>${moneyM(totals["181_plus"])}</td>
        <td>${moneyM(totals.vencido)}</td>
        <td><span class="status critical">${pct.format(totalPct)}</span></td>
      </tr>
    `;
  document.querySelectorAll(".advisor-row").forEach((row) => {
    row.addEventListener("click", () => openAdvisorModal(row.dataset.advisor));
  });
}

async function loadAsesoresGestion(force = false) {
  const tbody = $("advisorManageClients");
  if (!force && asesoresGestion.clientes.length) {
    renderAsesoresGestion();
    return;
  }
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="muted">Cargando carteras activas…</td></tr>';
  try {
    const res = await fetch("/api/asesores/gestion", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudieron cargar carteras");
    asesoresGestion = data;
    asesoresCatalog = data.catalogo || [];
    advisorManageSelected = new Set();
    renderAsesoresGestion();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="muted">Error: ${escapeHtml(err.message)}</td></tr>`;
    setText("advisorManageCount", "No se pudieron cargar carteras");
  }
}

function advisorManageFilteredClients() {
  const term = advisorManageSearch.trim().toLowerCase();
  return (asesoresGestion.clientes || []).filter((client) => {
    const keyOk = advisorManageFilter === "all" || advisorManageKey(client) === advisorManageFilter;
    const textOk =
      !term ||
      [client.razon_social, client.nit, client.asesor_nombre, client.asesor_codigo, client.ciudad]
        .join(" ")
        .toLowerCase()
        .includes(term);
    return keyOk && textOk;
  });
}

function renderAdvisorTargetSelect() {
  const select = $("advisorManageTarget");
  if (!select) return;
  select.innerHTML =
    '<option value="">Seleccionar asesor</option>' +
    (asesoresGestion.catalogo || [])
      .map((row) => {
        const value = `${row.asesor_codigo || ""}|${row.asesor_nombre || ""}`;
        return `<option value="${escapeHtml(value)}">${escapeHtml(row.asesor_nombre || "Sin nombre")} · cód ${escapeHtml(row.asesor_codigo || "—")}</option>`;
      })
      .join("");
}

function renderAsesoresGestion() {
  const summary = asesoresGestion.summary || {};
  setText(
    "advisorManageCount",
    `${number.format(summary.clientes || 0)} clientes activos · corte ${summary.fecha_corte || "-"}`,
  );
  const strip = $("advisorManageSummary");
  if (strip) {
    strip.innerHTML = `
      <article class="brand"><span>Asesores activos</span><strong>${number.format(summary.asesores_activos || 0)}</strong></article>
      <article><span>Clientes activos</span><strong>${number.format(summary.clientes || 0)}</strong></article>
      <article class="warn"><span>Sin asesor</span><strong>${number.format(summary.clientes_sin_asesor || 0)}</strong></article>
      <article class="critical"><span>No catalogados</span><strong>${number.format(summary.clientes_no_catalogados || 0)}</strong></article>
    `;
  }
  renderAdvisorTargetSelect();
  const portfolioRows = [
    {
      key: "all",
      asesor_nombre: "Todas las carteras",
      clientes: summary.clientes || 0,
      saldo: (asesoresGestion.asesores || []).reduce((sum, row) => sum + amount(row.saldo), 0),
      vencido: (asesoresGestion.asesores || []).reduce((sum, row) => sum + amount(row.vencido), 0),
      tipo: "all",
    },
    ...(asesoresGestion.asesores || []),
  ];
  const list = $("advisorPortfolioList");
  if (list) {
    list.innerHTML = portfolioRows
      .map((row) => {
        const active = advisorManageFilter === row.key ? "active" : "";
        const label = row.asesor_nombre || "Sin asesor";
        const ratio = amount(row.saldo) ? amount(row.vencido) / amount(row.saldo) : 0;
        return `
          <button class="advisor-portfolio-btn ${active}" data-advisor-filter="${escapeHtml(row.key)}">
            <div>
              <strong>${escapeHtml(label)}</strong>
              <span>${number.format(row.clientes || 0)} clientes · ${pct.format(ratio)} vencido</span>
              <em>${row.tipo === "no_catalogado" ? "Pendiente de clasificación" : row.tipo === "sin_asesor" ? "Sin responsable asignado" : row.asesor_codigo ? `Código ${escapeHtml(row.asesor_codigo)}` : ""}</em>
            </div>
            <b>${moneyM(row.saldo || 0)}</b>
          </button>
        `;
      })
      .join("");
    list.querySelectorAll("[data-advisor-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        advisorManageFilter = button.dataset.advisorFilter || "all";
        advisorManageSelected = new Set();
        renderAsesoresGestion();
      });
    });
  }
  renderAdvisorManageClients();
}

function renderAdvisorManageClients() {
  const rows = advisorManageFilteredClients();
  const tbody = $("advisorManageClients");
  if (!tbody) return;
  const visibleNits = new Set(rows.map((row) => row.nit));
  advisorManageSelected = new Set([...advisorManageSelected].filter((nit) => visibleNits.has(nit)));
  setText(
    "advisorManageSelection",
    `${number.format(advisorManageSelected.size)} seleccionados · ${number.format(rows.length)} visibles`,
  );
  const selectAll = $("advisorManageSelectAll");
  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every((row) => advisorManageSelected.has(row.nit));
    selectAll.indeterminate = rows.some((row) => advisorManageSelected.has(row.nit)) && !selectAll.checked;
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">No hay clientes con este filtro.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((client) => {
      const checked = advisorManageSelected.has(client.nit) ? "checked" : "";
      const advisor = client.tipo_asignacion === "sin_asesor"
        ? "Sin asesor"
        : client.tipo_asignacion === "no_catalogado"
          ? "Vendedor no catalogado"
          : client.asesor_nombre || "Sin asesor";
      const manualBadge = client.tiene_override_asesor ? ' <span class="status ok">Manual</span>' : "";
      return `
        <tr>
          <td><input class="advisor-manage-check" type="checkbox" data-nit="${escapeHtml(client.nit)}" ${checked} /></td>
          <td>
            <div class="advisor-client-name">
              <strong>${escapeHtml(client.razon_social || "Cliente")}</strong>
              <span>${escapeHtml(client.ciudad || "Sin ciudad")}</span>
            </div>
          </td>
          <td>${escapeHtml(client.nit || "-")}</td>
          <td>${escapeHtml(advisor)}${client.asesor_codigo ? ` <span class="muted">(${escapeHtml(client.asesor_codigo)})</span>` : ""}${manualBadge}</td>
          <td>${moneyM(client.total_saldo)}</td>
          <td>${moneyM(client.total_vencido)}</td>
          <td>${number.format(Math.round(amount(client.dias_mora_max || 0)))}</td>
          <td>${number.format(client.num_facturas || 0)}</td>
        </tr>
      `;
    })
    .join("");
  tbody.querySelectorAll(".advisor-manage-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) advisorManageSelected.add(checkbox.dataset.nit);
      else advisorManageSelected.delete(checkbox.dataset.nit);
      renderAdvisorManageClients();
    });
  });
}

function advisorManagePayload(action = "") {
  const selected = $("advisorManageTarget")?.value || "";
  const nuevoCodigo = $("advisorManageNewCodigo")?.value.trim() || "";
  const nuevoNombre = $("advisorManageNewNombre")?.value.trim() || "";
  const nits = [...advisorManageSelected];
  if (action === "quitar") return { nits, action: "quitar" };
  if (nuevoCodigo || nuevoNombre) return { nits, asesor_codigo: nuevoCodigo, asesor_nombre: nuevoNombre };
  if (selected) {
    const [codigo, ...nombreParts] = selected.split("|");
    return { nits, asesor_codigo: codigo, asesor_nombre: nombreParts.join("|") };
  }
  throw new Error("Selecciona un asesor existente o ingresa código y nombre.");
}

async function saveAdvisorManageSelection(action = "") {
  if (!advisorManageSelected.size) {
    alert("Selecciona al menos un cliente.");
    return;
  }
  if (action === "quitar" && !confirm("¿Quitar el asesor de los clientes seleccionados?")) return;
  try {
    $("assignSelectedAdvisor").disabled = true;
    $("clearSelectedAdvisor").disabled = true;
    const payload = advisorManagePayload(action);
    const res = await fetch("/api/asesores/reassign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo actualizar la asignación");
    advisorManageSelected = new Set();
    $("advisorManageTarget").value = "";
    $("advisorManageNewCodigo").value = "";
    $("advisorManageNewNombre").value = "";
    await loadDashboard();
    await loadAsesoresGestion(true);
    await loadAsesoresCatalog();
    status(`Asignación actualizada: ${number.format(data.updated || 0)} clientes`);
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    $("assignSelectedAdvisor").disabled = false;
    $("clearSelectedAdvisor").disabled = false;
  }
}

function renderInsights() {
  renderPareto();
  renderEffortChart();
  renderDueSoonChart();
  renderContactChart();
  renderAdvisorRiskMap();
  renderWeeklyTrend();
  renderDeterioro();
  renderPromesasResumen();
  renderGestionAuxiliares();
}

function renderWeeklyTrend() {
  const target = $("weeklyTrendChart");
  if (!target) return;
  const rows = dashboard.weekly_trend || [];
  if (!rows.length) {
    target.innerHTML = '<p class="drawer-empty">Aún no hay suficientes cortes confirmados para calcular tendencia.</p>';
    return;
  }
  const maxPct = Math.max(...rows.map((row) => amount(row.pct_vencido)), 0.16);
  target.innerHTML = `
    <div class="trend-track">
      ${rows.map((row) => {
        const ratio = amount(row.pct_vencido);
        const height = Math.max(6, (ratio / maxPct) * 100);
        const tone = ratio <= 0.08 ? "green" : ratio <= 0.15 ? "yellow" : "red";
        return `
          <div class="trend-col">
            <div class="trend-bar"><i class="${tone}" style="height:${height}%" title="${moneyM(row.total_vencido)} / ${moneyM(row.total_saldo)}"></i></div>
            <strong>${pct.format(ratio)}</strong>
            <span>${escapeHtml(row.fecha_corte || "-")}</span>
          </div>
        `;
      }).join("")}
    </div>
    <div class="trend-meta">
      <span>Meta verde ≤ 8% · Amarillo 8-15% · Rojo &gt; 15%</span>
      <span>${number.format(rows.length)} cortes registrados</span>
    </div>
  `;
}

function renderDeterioro() {
  const target = $("deterioroList");
  if (!target) return;
  const rows = dashboard.clientes_deterioro || [];
  if (!rows.length) {
    target.innerHTML = '<p class="drawer-empty">Ningún cliente aumentó su vencido frente al corte anterior.</p>';
    return;
  }
  target.innerHTML = rows.slice(0, 8).map((row) => `
    <button class="deterioro-row" data-nit="${escapeHtml(row.nit || "")}">
      <div>
        <strong>${escapeHtml(row.razon_social || "Cliente")}</strong>
        <span>${escapeHtml(row.asesor_nombre || "Sin asesor")} · ${number.format(row.dias_mora_actual)}d (antes ${number.format(row.dias_mora_anterior)}d)</span>
      </div>
      <div class="deterioro-delta">
        <b>${moneyM(row.vencido_actual)}</b>
        <em>+${moneyM(row.delta_vencido)}</em>
      </div>
    </button>
  `).join("");
  target.querySelectorAll(".deterioro-row").forEach((button) => {
    button.addEventListener("click", () => {
      const nit = button.dataset.nit;
      if (nit) openClientDrawer(nit);
    });
  });
}

function renderPromesasResumen() {
  const target = $("promesasResumen");
  if (!target) return;
  const data = dashboard.promesas_resumen || {};
  if (!data.total) {
    target.innerHTML = '<p class="drawer-empty">Aún no hay promesas registradas. Usa "+ Registrar promesa" desde la ficha del cliente.</p>';
    return;
  }
  const total = data.total || 0;
  const items = [
    { label: "Cumplidas", value: data.cumplidas || 0, tone: "ok" },
    { label: "Pendientes", value: data.pendientes || 0, tone: "warn" },
    { label: "Incumplidas", value: data.incumplidas || 0, tone: "bad" },
  ];
  target.innerHTML = `
    <div class="promesas-summary">
      <div class="promesas-ratio">
        <strong>${pct.format(amount(data.pct_cumplidas))}</strong>
        <span>cumplidas de las resueltas</span>
      </div>
      <div class="promesas-bars">
        ${items.map((item) => `
          <div class="promesa-bar ${item.tone}">
            <span>${item.label}</span>
            <div><i style="width:${total ? (item.value / total) * 100 : 0}%"></i></div>
            <strong>${number.format(item.value)}</strong>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderGestionAuxiliares() {
  const target = $("gestionAuxiliares");
  if (!target) return;
  const data = dashboard.gestion_cobertura || {};
  const auxiliares = data.top_auxiliares || [];
  if (!auxiliares.length) {
    target.innerHTML = '<p class="drawer-empty">Aún no hay gestiones registradas esta semana.</p>';
    return;
  }
  const max = Math.max(...auxiliares.map((row) => amount(row.contactos_semana)), 1);
  target.innerHTML = `
    <div class="gestion-summary">
      <div>
        <strong>${number.format(data.contactados_semana || 0)}</strong>
        <span>clientes vencidos contactados esta semana</span>
      </div>
      <div>
        <strong>${pct.format(amount(data.pct_cobertura_semana))}</strong>
        <span>cobertura sobre ${number.format(data.total_clientes_vencidos || 0)} vencidos</span>
      </div>
    </div>
    <div class="gestion-bars">
      ${auxiliares.map((row) => {
        const width = Math.max(4, (amount(row.contactos_semana) / max) * 100);
        return `
          <div class="gestion-row">
            <div>
              <strong>${escapeHtml(row.nombre || "Sin asignar")}</strong>
              <span>${number.format(row.clientes_semana)} clientes · hoy ${number.format(row.contactos_hoy)}</span>
            </div>
            <div class="gestion-track"><i style="width:${width}%"></i></div>
            <b>${number.format(row.contactos_semana)}</b>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderPareto() {
  const view = dashboard.view || dashboard;
  const rows = view.clients
    .filter((client) => amount(client.total_vencido) > 0)
    .sort((a, b) => amount(b.total_vencido) - amount(a.total_vencido))
    .slice(0, 10);
  const total = view.summary.total_vencido || 1;
  $("paretoChart").innerHTML = rows
    .map((client, index) => {
      const width = Math.max(3, (amount(client.total_vencido) / amount(rows[0]?.total_vencido || 1)) * 100);
      return `
        <div class="pareto-row">
          <span>${index + 1}. ${client.razon_social}</span>
          <div class="pareto-track"><i style="width:${width}%"></i></div>
          <strong>${moneyM(client.total_vencido)} <em>${pct.format(amount(client.total_vencido) / total)}</em></strong>
        </div>
      `;
    })
    .join("");
}

function renderEffortChart() {
  const items = [
    { label: "Ciclo bot", keys: ["1_4"], color: "var(--yellow)", filter: "1_4" },
    { label: "Gestión humana", keys: ["5_15"], color: "var(--orange)", filter: "5_15" },
    { label: "Negociación", keys: ["16_30"], color: "var(--red)", filter: "16_30" },
    { label: "Plan especial", keys: ["31_60", "61_90", "91_120", "121_180", "181_plus"], color: "#5b1a14", filter: "31_60" },
  ];
  const aging = (dashboard.view || dashboard).aging;
  const max = Math.max(...items.map((item) => item.keys.reduce((sum, key) => sum + amount(aging[key]), 0)), 1);
  $("effortChart").innerHTML = items
    .map((item) => {
      const value = item.keys.reduce((sum, key) => sum + amount(aging[key]), 0);
      const height = Math.max(4, (value / max) * 100);
      return `
        <button class="effort-item effort-filter" data-aging="${item.filter}">
          <div class="effort-bar"><i style="height:${height}%;background:${item.color}"></i></div>
          <strong>${moneyM(value)}</strong>
          <span>${item.label}</span>
        </button>
      `;
    })
    .join("");
  document.querySelectorAll(".effort-filter").forEach((button) => {
    button.addEventListener("click", () => {
      $("agingFilter").value = button.dataset.aging;
      showPage("clientes");
      rerenderFilteredViews();
    });
  });
}

function renderDueSoonChart() {
  const view = dashboard.view || dashboard;
  const dueSoon = view.due_soon.reduce((sum, invoice) => sum + amount(invoice.monto), 0);
  const current = view.summary.total_vigente || 1;
  const ratio = dueSoon / current;
  $("dueSoonChart").innerHTML = `
    <div class="ring" style="--pct:${Math.min(100, ratio * 100)}%"></div>
    <div>
      <strong>${money.format(dueSoon)}</strong>
      <span>${pct.format(ratio)} del saldo vigente vence pronto</span>
      <small>${number.format(view.due_soon.length)} documentos para prevenir mora</small>
    </div>
  `;
}

function renderContactChart() {
  const totals = (dashboard.view || dashboard).clients.reduce(
    (acc, client) => {
      const hasPhone = String(client.telefono || client.telefono_2 || "").replace(/0/g, "").trim().length > 3;
      acc[hasPhone ? "withPhone" : "withoutPhone"] += amount(client.total_saldo);
      return acc;
    },
    { withPhone: 0, withoutPhone: 0 },
  );
  const total = totals.withPhone + totals.withoutPhone || 1;
  $("contactChart").innerHTML = `
    <div class="split-track">
      <i class="with" style="width:${(totals.withPhone / total) * 100}%"></i>
      <i class="without" style="width:${(totals.withoutPhone / total) * 100}%"></i>
    </div>
    <div class="split-row"><span>Con teléfono</span><strong>${moneyM(totals.withPhone)} · ${pct.format(totals.withPhone / total)}</strong></div>
    <div class="split-row"><span>Sin teléfono útil</span><strong>${moneyM(totals.withoutPhone)} · ${pct.format(totals.withoutPhone / total)}</strong></div>
  `;
}

function renderAdvisorRiskMap() {
  const rows = (dashboard.view || dashboard).seller_aging;
  const maxSaldo = Math.max(...rows.map((row) => amount(row.total)), 1);
  $("advisorRiskMap").innerHTML = rows
    .map((row) => {
      const x = Math.min(96, Math.max(4, row.pct_vencido * 100));
      const size = 28 + (amount(row.total) / maxSaldo) * 58;
      const cls = row.pct_vencido <= 0.08 ? "low" : row.pct_vencido <= 0.15 ? "mid" : "high";
      return `
        <button class="risk-bubble ${cls}" data-advisor="${row.codigo}" style="left:${x}%;width:${size}px;height:${size}px">
          <span>${row.nombre.split(" ")[0]}</span>
        </button>
      `;
    })
    .join("");
  document.querySelectorAll(".risk-bubble").forEach((button) => {
    button.addEventListener("click", () => openAdvisorModal(button.dataset.advisor));
  });
}

function openAdvisorModal(code) {
  const row = dashboard.seller_aging.find((item) => item.codigo === code);
  if (!row) return;
  const clients = advisorClients(code).sort((a, b) => amount(b.total_vencido) - amount(a.total_vencido));
  const invoices = advisorInvoices(code);
  const overdueInvoices = invoices.filter((invoice) => amount(invoice.dias_mora) > 0);
  const dueSoon = invoices.filter((invoice) => amount(invoice.dias_mora) <= 0 && amount(invoice.dias_mora) >= -7);
  const topClients = clients.filter((client) => amount(client.total_vencido) > 0).slice(0, 5);
  const cls = row.pct_vencido <= 0.08 ? "Verde" : row.pct_vencido <= 0.15 ? "Amarillo" : "Rojo";

  currentAdvisorReport = [
    `COPACOL - Reporte de cartera para ${row.nombre}`,
    `Cartera general: ${money.format(row.total)}`,
    `Cartera vencida: ${money.format(row.vencido)} (${pct.format(row.pct_vencido)})`,
    `Semáforo: ${cls}`,
    `Facturas vencidas: ${number.format(overdueInvoices.length)}`,
    `Facturas próximas a vencer: ${number.format(dueSoon.length)}`,
    `Top clientes vencidos:`,
    ...topClients.map((client, index) => `${index + 1}. ${client.razon_social}: ${money.format(client.total_vencido)} (${client.dias_mora_max} días)`),
  ].join("\n");

  setText("modalAdvisorName", row.nombre);
  $("advisorModalBody").innerHTML = `
    <div class="modal-kpis">
      <article><span>Cartera general</span><strong>${money.format(row.total)}</strong></article>
      <article><span>Vencida</span><strong>${money.format(row.vencido)}</strong></article>
      <article><span>% vencido</span><strong>${pct.format(row.pct_vencido)}</strong></article>
      <article><span>Semáforo</span><strong>${cls}</strong></article>
    </div>
    <div class="modal-aging">
      ${["1_4", "5_15", "16_30", "31_60", "61_90", "91_120", "121_180", "181_plus"]
        .map((key) => {
          const [label, color] = agingLabels[key];
          const width = Math.max(2, (amount(row[key]) / Math.max(row.vencido, 1)) * 100);
          return `<div><span>${label}</span><i style="width:${width}%;background:${color}"></i><strong>${moneyM(row[key])}</strong></div>`;
        })
        .join("")}
    </div>
    <div class="modal-clients">
      <h3>Clientes prioritarios</h3>
      ${topClients
        .map(
          (client) => `
            <article>
              <strong>${client.razon_social}</strong>
              <span>${money.format(client.total_vencido)} vencido · ${client.dias_mora_max} días mora · ${client.num_vencidas} docs</span>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
  $("advisorModal").showModal();
}

function renderCities() {
  const max = Math.max(...dashboard.cities.map((city) => city.saldo), 1);
  $("cityBars").innerHTML = dashboard.cities
    .slice(0, 10)
    .map((city) => {
      const width = Math.max(2, (city.saldo / max) * 100);
      return `
        <div class="bar-row">
          <div class="bar-meta"><span>${city.ciudad}</span><span>${money.format(city.saldo)}</span></div>
          <div class="bar-track"><div class="bar-fill steel" style="width:${width}%"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderPriority() {
  const rows = (dashboard.view || dashboard).clients
    .filter((client) => amount(client.total_vencido) > 0)
    .sort((a, b) => amount(b.total_vencido) + amount(b.dias_mora_max) * 100000 - (amount(a.total_vencido) + amount(a.dias_mora_max) * 100000))
    .slice(0, 8);

  $("priorityList").innerHTML = rows
    .map(
      (client) => `
        <article class="priority-card">
          <div>
            <strong>${client.razon_social}</strong>
            <span>${client.asesor_nombre || "Sin asesor"} · ${client.dias_mora_max || 0} días mora</span>
          </div>
          <div>
            <b>${money.format(amount(client.total_vencido))}</b>
            <em>${client.prioridad}</em>
          </div>
        </article>
      `,
    )
    .join("");
}

function invoiceRows(rows) {
  return rows
    .slice(0, 120)
    .map((invoice) => {
      const days = amount(invoice.dias_mora);
      const state = days > 60 ? "Crítica" : days > 0 ? "Vencida" : "Vigente";
      const stateClass = days > 60 ? "critical" : days > 0 ? "late" : "ok";
      return `
        <tr>
          <td>${invoice.cliente || "-"}</td>
          <td>${invoice.nit || "-"}</td>
          <td>${invoice.numero_factura || "-"}</td>
          <td>${invoice.asesor_nombre || "-"}</td>
          <td>${invoice.ciudad || "-"}</td>
          <td>${invoice.fecha_vencimiento || "-"}</td>
          <td>${number.format(days)}</td>
          <td>${money.format(amount(invoice.monto))}</td>
          <td><span class="status ${stateClass}">${invoice.estado || state}</span></td>
        </tr>
      `;
    })
    .join("");
}

function renderInvoices() {
  const rows = filteredInvoices().sort((a, b) => amount(b.dias_mora) - amount(a.dias_mora) || amount(b.monto) - amount(a.monto));
  setText("invoiceCount", `${number.format(rows.length)} facturas visibles`);
  $("invoiceTable").innerHTML = invoiceRows(rows);
}

function clientCards(rows) {
  return rows
    .slice(0, 36)
    .map((client) => {
      const overdue = amount(client.total_vencido);
      const phone = cleanPhone(client.telefono || client.telefono_2);
      return `
        <article class="client-card ${client.prioridad === "Alta" ? "hot" : ""}" data-nit="${client.nit}">
          <div class="client-top">
            <strong>${client.razon_social || "Cliente sin nombre"}</strong>
            <span class="tag">${client.prioridad || "Normal"}</span>
          </div>
          <span class="muted">NIT ${client.nit || "-"} · ${client.asesor_nombre || "Sin asesor"}</span>
          <span class="muted">${conditionLabel(client.condicion_pago_real)}${client.plazo_pago_real ? ` · Plazo real ${number.format(client.plazo_pago_real)} días` : ""}${client.cupo_credito ? ` · Cupo ${moneyM(client.cupo_credito)}` : ""}</span>
          <span class="amount">${money.format(amount(client.total_saldo))}</span>
          <div class="client-split">
            <span>Vencido <b>${money.format(overdue)}</b></span>
            <span>${client.num_facturas || 0} docs</span>
            <span>${client.dias_mora_max || 0} días</span>
          </div>
          <div class="client-actions" aria-label="Acciones rápidas">
            ${phone ? `<a href="tel:+${phone}" title="Llamar">Tel</a>` : `<span title="Sin teléfono">Tel</span>`}
            ${phone ? `<button class="whatsapp-trigger" data-nit="${client.nit}" title="Preparar contacto por WhatsApp">WA</button>` : `<span title="Sin WhatsApp">WA</span>`}
            <button class="drawer-trigger" data-nit="${client.nit}" title="Ver ficha completa">Ficha</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderClients() {
  const rows = filteredClients().sort((a, b) => amount(b.total_vencido) - amount(a.total_vencido) || amount(b.total_saldo) - amount(a.total_saldo));
  setText("clientCount", `${number.format(rows.length)} clientes visibles`);
  const btn = $("noGestion5dBtn");
  if (btn) btn.classList.toggle("active", clientNoGestionMode);
  $("clientGrid").innerHTML = clientCards(rows);
  $("clientGrid").querySelectorAll(".drawer-trigger").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openClientDrawer(btn.dataset.nit);
    });
  });
  $("clientGrid").querySelectorAll(".whatsapp-trigger").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerWhatsAppFlow(btn.dataset.nit, btn);
    });
  });
}

async function previewImport(event) {
  event.preventDefault();
  const file = $("xlsxFile").files[0];
  if (!file) {
    renderImportMessage("Selecciona un archivo .xlsx.", "El sistema validará estructura, corte y totales antes de permitir la importación.", "warn");
    return;
  }
  renderImportMessage("Validando archivo", "Estamos revisando columnas, corte, facturas, clientes y montos. Esto toma unos segundos.", "loading");
  $("importConfirm").classList.remove("visible");
  importToken = null;
  const formData = new FormData();
  formData.append("file", file);
  try {
    const response = await fetch("/api/import/preview", { method: "POST", body: formData });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "No se pudo validar el archivo");
    renderImportPreview(result);
    if (result.token) {
      importToken = result.token;
      setText("importConfirmMsg", `Importación lista para confirmar`);
      const route = "Al confirmar se enviará el archivo al flujo de actualización y luego se recargará el tablero.";
      setText("importConfirmDetail", `${number.format(result.facturas)} facturas · ${number.format(result.clientes)} clientes · ${moneyM(result.saldo_total)} · ${route}`);
      $("importConfirm").classList.add("visible");
    }
  } catch (err) {
    renderImportMessage("No se pudo validar el archivo", err.message, "error");
  }
}

function renderImportMessage(title, detail, tone = "info") {
  const el = $("importResult");
  el.className = `import-result import-empty ${tone}`;
  el.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(detail)}</span>
  `;
}

function renderImportPreview(result) {
  const aging = result.aging || {};
  const agingTotal = Object.values(aging).reduce((sum, value) => sum + amount(value), 0) || 1;
  const agingRows = Object.entries(aging)
    .filter(([, value]) => amount(value) !== 0)
    .map(([key, value]) => {
      const label = agingLabels[key]?.[0] || key;
      const width = Math.max(4, (amount(value) / agingTotal) * 100);
      return `
        <div class="import-aging-row">
          <div><strong>${escapeHtml(label)}</strong><span>${moneyM(value)}</span></div>
          <div class="import-track"><i style="width:${width}%"></i></div>
        </div>
      `;
    })
    .join("");
  const clients = (result.top_clientes || []).slice(0, 5).map((client) => `
    <tr>
      <td>${escapeHtml(client.razon_social || "Cliente")}</td>
      <td>${number.format(amount(client.facturas))}</td>
      <td>${moneyM(client.saldo)}</td>
    </tr>
  `).join("");
  const sellers = (result.top_vendedores || []).slice(0, 5).map((seller) => `
    <tr>
      <td>${escapeHtml(seller.vendedor || "Asesor")}</td>
      <td>${moneyM(seller.saldo)}</td>
    </tr>
  `).join("");
  const control = result.control_cambios || {};
  const current = control.current || {};
  const incoming = control.incoming || {};
  const delta = control.delta || {};
  const changeControl = `
    <section class="import-change-control">
      <div class="change-copy">
        <p class="eyebrow">Control de cambios</p>
        <h4>${escapeHtml(control.title || "Reemplazo completo")}</h4>
        <span>${escapeHtml(control.description || "La cartera activa se actualizará con la plantilla confirmada.")}</span>
      </div>
      <div class="change-grid">
        <article>
          <span>Corte activo</span>
          <strong>${escapeHtml(current.fecha_corte || "-")}</strong>
          <em>${escapeHtml(current.ultima_actualizacion ? formatDateTime(current.ultima_actualizacion) : "Sin actualización registrada")}</em>
        </article>
        <article>
          <span>Plantilla entrante</span>
          <strong>${escapeHtml(incoming.fecha_corte || result.fecha_corte_detectada || "-")}</strong>
          <em>Se convertirá en la cartera activa</em>
        </article>
        <article>
          <span>Clientes</span>
          <strong>${number.format(amount(current.clientes))} → ${number.format(amount(incoming.clientes))}</strong>
          <em>${signedNumber(delta.clientes)}</em>
        </article>
        <article>
          <span>Facturas</span>
          <strong>${number.format(amount(current.facturas))} → ${number.format(amount(incoming.facturas))}</strong>
          <em>${signedNumber(delta.facturas)}</em>
        </article>
        <article>
          <span>Saldo total</span>
          <strong>${moneyM(current.saldo_total)} → ${moneyM(incoming.saldo_total)}</strong>
          <em>${signedMoneyM(delta.saldo_total)}</em>
        </article>
        <article>
          <span>Vencido</span>
          <strong>${moneyM(current.total_vencido)} → ${moneyM(incoming.total_vencido)}</strong>
          <em>${signedMoneyM(delta.total_vencido)}</em>
        </article>
      </div>
    </section>
  `;

  const el = $("importResult");
  el.className = "import-result import-preview";
  const plazo = result.plazo_real || {};
  const sourceCounts = plazo.fuente_facturas || {};
  const realTermInvoices = amount(sourceCounts.copacol_terceros_credito);
  const fallbackInvoices = amount(sourceCounts.cartera_original);
  el.innerHTML = `
    <div class="import-status-head">
      <div>
        <p class="eyebrow">Validación completada</p>
        <h3>Corte ${escapeHtml(result.fecha_corte_detectada || "sin fecha detectada")}</h3>
        <span>El archivo cumple la estructura esperada de Siigo.</span>
      </div>
      <strong>Aprobado</strong>
    </div>
    <div class="import-kpis">
      <article><span>Saldo total</span><strong>${moneyM(result.saldo_total)}</strong></article>
      <article><span>Facturas</span><strong>${number.format(result.facturas || 0)}</strong></article>
      <article><span>Clientes</span><strong>${number.format(result.clientes || 0)}</strong></article>
      <article><span>Vendedores</span><strong>${number.format(result.vendedores || 0)}</strong></article>
      <article><span>Plazo real</span><strong>${number.format(realTermInvoices)} docs</strong><small>${number.format(fallbackInvoices)} fallback</small></article>
      <article><span>Cuentas Siigo</span><strong>13050501 / 13050522</strong><small>Únicas cuentas consideradas</small></article>
    </div>
    ${changeControl}
    <div class="import-preview-grid">
      <section>
        <h4>Distribución por edad</h4>
        <div class="import-aging">${agingRows || "<p>Sin saldos detectados.</p>"}</div>
      </section>
      <section>
        <h4>Clientes con mayor saldo</h4>
        <table class="import-mini-table"><tbody>${clients || "<tr><td>Sin clientes detectados.</td></tr>"}</tbody></table>
      </section>
      <section>
        <h4>Vendedores principales</h4>
        <table class="import-mini-table"><tbody>${sellers || "<tr><td>Sin vendedores detectados.</td></tr>"}</tbody></table>
      </section>
    </div>
  `;
}

function rerenderFilteredViews() {
  renderDashboard();
}

function showPage(page) {
  currentPage = page;
  const labels = {
    tablero: "Tablero de Cobranzas",
    inteligencia: "Inteligencia de Cobranza",
    asesores: "Gestión por Asesor",
    cartera: "Cartera Detallada",
    clientes: "Clientes",
    carga: "Carga de Datos",
    historial: "Historial de Plantillas",
    compromisos: "Compromisos de Pago",
  };
  setText("pageTitle", labels[page] || "Dashboard de Cobranzas");
  document.querySelectorAll("[data-page]").forEach((section) => {
    section.classList.toggle("active", section.dataset.page === page);
  });
  document.querySelectorAll("[data-page-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.pageLink === page);
  });
  if (page === "historial" && !importHistory.length) loadImportHistory();
  if (page === "compromisos") loadPromesas();
  if (page === "asesores") loadAsesoresGestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Compromisos de pago ───────────────────────────────────────────────────────

let promesasData = { summary: {}, promises: [], clientes: [] };
let promesaFilter = "all";

const promesaEstadoLabel = {
  pendiente: ["Pendiente", "warn"],
  cumplida: ["Cumplida", "ok"],
  incumplida: ["Incumplida", "critical"],
};

async function loadPromesas() {
  const tbody = $("promesasTable");
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="muted">Cargando compromisos…</td></tr>';
  try {
    const res = await fetch(`/api/promesas?status=${encodeURIComponent(promesaFilter)}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudieron cargar compromisos");
    promesasData = data;
    renderPromesas();
    populatePromesaClienteList();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="muted">Error: ${escapeHtml(err.message)}</td></tr>`;
    setText("promesasCount", "No se pudieron cargar compromisos");
  }
}

function renderPromesas() {
  const summary = promesasData.summary || {};
  setText(
    "promesasCount",
    summary.total
      ? `${number.format(summary.total)} compromisos registrados`
      : "Aún no hay compromisos registrados",
  );
  const strip = $("promesasSummary");
  if (strip) {
    strip.innerHTML = `
      <article><span>Total</span><strong>${number.format(summary.total || 0)}</strong></article>
      <article class="ok"><span>Cumplidas</span><strong>${number.format(summary.cumplidas || 0)}</strong></article>
      <article class="warn"><span>Pendientes</span><strong>${number.format(summary.pendientes || 0)}</strong></article>
      <article class="critical"><span>Incumplidas</span><strong>${number.format(summary.incumplidas || 0)}</strong></article>
      <article class="brand"><span>% cumplidas</span><strong>${pct.format(amount(summary.pct_cumplidas))}</strong></article>
    `;
  }
  const tbody = $("promesasTable");
  if (!tbody) return;
  const rows = promesasData.promises || [];
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted">No hay compromisos con el filtro seleccionado.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((row) => {
    const estado = (row.estado_calculado || "pendiente").toLowerCase();
    const [label, cls] = promesaEstadoLabel[estado] || ["Pendiente", "warn"];
    const monto = money.format(amount(row.monto_prometido));
    const observ = row.observacion ? escapeHtml(row.observacion) : '<span class="muted">—</span>';
    return `
      <tr data-promesa-id="${escapeHtml(row.id || "")}" data-nit="${escapeHtml(row.nit || "")}">
        <td>
          <button class="link-cell" data-action="open-client">${escapeHtml(row.cliente || "Cliente")}</button>
        </td>
        <td>${escapeHtml(row.nit || "-")}</td>
        <td>${escapeHtml(row.fecha_promesa || "-")}</td>
        <td>${monto}</td>
        <td><span class="status ${cls}">${label}</span></td>
        <td>${escapeHtml(row.asesor_nombre || "Sin asesor")}</td>
        <td>${escapeHtml(row.registrado_por || "—")}</td>
        <td>${observ}</td>
        <td>
          <div class="row-actions">
            ${estado !== "cumplida" ? '<button data-action="cumplir" title="Marcar cumplida">✓</button>' : ""}
            ${estado !== "incumplida" ? '<button data-action="incumplir" title="Marcar incumplida">✗</button>' : ""}
            <button data-action="editar" title="Editar">✎</button>
            <button data-action="eliminar" class="row-danger" title="Eliminar">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const action = btn.dataset.action;
        const id = tr.dataset.promesaId;
        const nit = tr.dataset.nit;
        if (action === "open-client" && nit) {
          openClientDrawer(nit);
        } else if (action === "cumplir") {
          patchPromesa(id, { status: "cumplida" });
        } else if (action === "incumplir") {
          patchPromesa(id, { status: "incumplida" });
        } else if (action === "editar") {
          openPromesaModal(promesasData.promises.find((row) => row.id === id) || null);
        } else if (action === "eliminar") {
          deletePromesaRow(id);
        }
      });
    });
  });
}

function populatePromesaClienteList() {
  const datalist = $("promesaClienteList");
  if (!datalist) return;
  const items = (promesasData.clientes || []).slice(0, 800);
  datalist.innerHTML = items.map((client) => `
    <option value="${escapeHtml(client.razon_social || client.nit || "")}" data-nit="${escapeHtml(client.nit || "")}">
      ${escapeHtml(client.nit || "")} · ${escapeHtml(client.asesor_nombre || "Sin asesor")}
    </option>
  `).join("");
}

async function patchPromesa(id, payload) {
  try {
    const res = await fetch(`/api/promesas/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo actualizar el compromiso");
    await loadPromesas();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function deletePromesaRow(id) {
  if (!id) return;
  if (!confirm("¿Eliminar este compromiso? No se puede recuperar.")) return;
  try {
    const res = await fetch(`/api/promesas/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo eliminar");
    await loadPromesas();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function openPromesaModal(promesa = null, prefillNit = null) {
  populatePromesaClienteList();
  const editing = Boolean(promesa);
  setText("promesaModalTitle", editing ? "Editar compromiso" : "Nueva promesa");
  $("promesaId").value = editing ? (promesa.id || "") : "";
  const targetNit = prefillNit || (promesa && promesa.nit) || "";
  if (targetNit) {
    const client = (promesasData.clientes || []).find((c) => c.nit === targetNit);
    $("promesaCliente").value = client ? (client.razon_social || targetNit) : targetNit;
    $("promesaNit").value = targetNit;
    if (client) {
      setText("promesaClienteHint", `${client.razon_social || "Cliente"} · NIT ${client.nit}`);
    }
  } else {
    $("promesaCliente").value = "";
    $("promesaNit").value = "";
    setText("promesaClienteHint", "Selecciona un cliente del listado.");
  }
  $("promesaFecha").value = (promesa && promesa.fecha_promesa) || new Date().toISOString().slice(0, 10);
  $("promesaMonto").value = promesa ? Math.round(amount(promesa.monto_prometido)) : "";
  $("promesaObs").value = (promesa && promesa.observacion) || "";
  $("promesaStatusGroup").style.display = editing ? "" : "none";
  if (editing) $("promesaStatus").value = (promesa.status || "pendiente").toLowerCase();
  $("promesaModal").showModal();
  setTimeout(() => $("promesaCliente").focus(), 50);
}

function resolvePromesaNit() {
  const explicit = $("promesaNit").value.trim();
  if (explicit) return explicit;
  const value = $("promesaCliente").value.trim();
  if (!value) return "";
  const direct = (promesasData.clientes || []).find(
    (client) => (client.razon_social || "").toLowerCase() === value.toLowerCase() || client.nit === value,
  );
  return direct ? direct.nit : value;
}

async function savePromesaForm() {
  const id = $("promesaId").value.trim();
  const nit = resolvePromesaNit();
  const payload = {
    nit,
    fecha_promesa: $("promesaFecha").value,
    monto_prometido: Number($("promesaMonto").value || 0),
    observacion: $("promesaObs").value.trim(),
    registrado_por: JSON.parse(sessionStorage.getItem("copacol_user") || "{}").email || "dashboard",
  };
  if (id) payload.status = $("promesaStatus").value;
  try {
    $("savePromesa").disabled = true;
    const url = id ? `/api/promesas/${encodeURIComponent(id)}` : "/api/promesas";
    const res = await fetch(url, {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo guardar");
    $("promesaModal").close();
    await loadPromesas();
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    $("savePromesa").disabled = false;
  }
}

// ── Gestión de asesor por cliente ─────────────────────────────────────────────

let asesoresCatalog = [];

async function loadAsesoresCatalog() {
  try {
    const res = await fetch("/api/asesores", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo cargar asesores");
    asesoresCatalog = data.asesores || [];
  } catch (err) {
    console.warn("asesores:", err);
    asesoresCatalog = [];
  }
}

function populateAsesorSelect(current = "") {
  const select = $("asesorExistente");
  if (!select) return;
  select.innerHTML =
    `<option value="">— Seleccionar de la lista —</option>` +
    asesoresCatalog
      .map((row) => {
        const value = `${row.asesor_codigo || ""}|${row.asesor_nombre || ""}`;
        const label = `${row.asesor_nombre || "Sin nombre"} (cód ${row.asesor_codigo || "—"}, ${row.clientes} clientes)`;
        const selected = current && current === row.asesor_codigo ? "selected" : "";
        return `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(label)}</option>`;
      })
      .join("");
}

async function openAsesorModal(nit, clientName, currentCodigo, currentNombre) {
  if (!asesoresCatalog.length) await loadAsesoresCatalog();
  $("asesorNit").value = nit;
  setText("asesorClienteName", clientName || "Cliente");
  populateAsesorSelect(currentCodigo);
  $("asesorNuevoCodigo").value = "";
  $("asesorNuevoNombre").value = "";
  const block = $("asesorActualBlock");
  if (currentNombre) {
    block.style.display = "";
    setText("asesorActualNombre", `${currentNombre}${currentCodigo ? ` (cód ${currentCodigo})` : ""}`);
  } else {
    block.style.display = "none";
  }
  $("asesorModal").showModal();
}

async function saveAsesorForm() {
  const nit = $("asesorNit").value;
  const selected = $("asesorExistente").value;
  const nuevoCodigo = $("asesorNuevoCodigo").value.trim();
  const nuevoNombre = $("asesorNuevoNombre").value.trim();
  let payload;
  if (nuevoCodigo || nuevoNombre) {
    payload = { asesor_codigo: nuevoCodigo, asesor_nombre: nuevoNombre };
  } else if (selected) {
    const [codigo, ...nombreParts] = selected.split("|");
    payload = { asesor_codigo: codigo, asesor_nombre: nombreParts.join("|") };
  } else {
    alert("Selecciona un asesor del listado o ingresa uno nuevo.");
    return;
  }
  try {
    $("saveAsesor").disabled = true;
    const res = await fetch(`/api/client/${encodeURIComponent(nit)}/asesor`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo actualizar el asesor");
    $("asesorModal").close();
    await loadAsesoresCatalog();
    if (drawerNit === nit) openClientDrawer(nit);
    if (currentPage === "asesores") loadAsesoresGestion(true);
    loadDashboard().catch((err) => status(err.message));
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    $("saveAsesor").disabled = false;
  }
}

async function removeAsesorFromClient() {
  const nit = $("asesorNit").value;
  if (!nit) return;
  if (!confirm("¿Quitar el asesor asignado a este cliente?")) return;
  try {
    $("removeAsesor").disabled = true;
    const res = await fetch(`/api/client/${encodeURIComponent(nit)}/asesor`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "quitar" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo quitar el asesor");
    $("asesorModal").close();
    await loadAsesoresCatalog();
    if (drawerNit === nit) openClientDrawer(nit);
    if (currentPage === "asesores") loadAsesoresGestion(true);
    loadDashboard().catch((err) => status(err.message));
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    $("removeAsesor").disabled = false;
  }
}

// ── Chat IA ───────────────────────────────────────────────────────────────────

let chatHistory = [];

function buildAssistantContext() {
  if (!dashboard) return {};
  const view = dashboard.view || dashboard;
  const s = view.summary;
  const overdueInvoices = [...(view.overdue_invoices || [])]
    .sort((a, b) => amount(b.dias_mora) - amount(a.dias_mora) || amount(b.monto) - amount(a.monto))
    .slice(0, 10)
    .map((inv) => ({
      numero_factura: inv.numero_factura,
      cliente: inv.cliente,
      nit: inv.nit,
      monto: inv.monto,
      dias_mora: inv.dias_mora,
      fecha_vencimiento: inv.fecha_vencimiento,
      asesor_nombre: inv.asesor_nombre,
    }));
  const paretoClientes = [...view.clients]
    .filter((c) => amount(c.total_vencido) > 0)
    .sort((a, b) => amount(b.total_vencido) - amount(a.total_vencido))
    .slice(0, 10)
    .map((c) => ({
      razon_social: c.razon_social,
      nit: c.nit,
      total_vencido: c.total_vencido,
      total_saldo: c.total_saldo,
      dias_mora_max: c.dias_mora_max,
      asesor_nombre: c.asesor_nombre,
      pct_vencido_total: s.total_vencido ? amount(c.total_vencido) / amount(s.total_vencido) : 0,
    }));
  return {
    fecha_corte: s.fecha_corte,
    total_saldo: s.total_saldo,
    saldo_neto: s.saldo_neto,
    saldos_a_favor: s.saldos_a_favor,
    total_vencido: s.total_vencido,
    total_vigente: s.total_vigente,
    pct_vencido: s.total_saldo ? (s.total_vencido / s.total_saldo) * 100 : 0,
    clientes: s.clientes,
    clientes_vencidos: s.clientes_vencidos,
    mora_promedio: s.mora_promedio,
    facturas_vencidas: s.facturas_vencidas,
    aging: view.aging,
    condition_mix: view.condition_mix,
    concentracion_top10: s.concentracion_top10,
    concentracion_top10_pct: s.concentracion_top10_pct,
    pareto_clientes: paretoClientes,
    facturas_vencidas_top: overdueInvoices,
    facturas_proximas: [...(view.due_soon || [])]
      .sort((a, b) => amount(b.monto) - amount(a.monto))
      .slice(0, 8)
      .map((inv) => ({
        numero_factura: inv.numero_factura,
        cliente: inv.cliente,
        monto: inv.monto,
        dias_mora: inv.dias_mora,
        fecha_vencimiento: inv.fecha_vencimiento,
        asesor_nombre: inv.asesor_nombre,
      })),
    top_clientes: [...view.clients]
      .filter((c) => amount(c.total_vencido) > 0)
      .sort((a, b) => amount(b.total_vencido) - amount(a.total_vencido))
      .slice(0, 8)
      .map((c) => ({ razon_social: c.razon_social, total_vencido: c.total_vencido, dias_mora_max: c.dias_mora_max, asesor_nombre: c.asesor_nombre })),
    top_asesores: [...(view.seller_aging || [])]
      .sort((a, b) => b.vencido - a.vencido)
      .slice(0, 5)
      .map((a) => ({ nombre: a.nombre, total: a.total, vencido: a.vencido, pct_vencido: a.pct_vencido })),
  };
}

function renderChatMessages() {
  const el = $("chatMessages");
  if (!el) return;
  if (chatHistory.length === 0) {
    el.innerHTML = `<div class="chat-message ai">Hola, soy el asistente de COPACOL con acceso a los datos reales de la cartera. Puedo explicarte cualquier métrica, sugerirte a quién cobrar primero y analizar riesgo por asesor o cliente. ¿En qué te ayudo?</div>`;
    return;
  }
  el.innerHTML = chatHistory.map((m) => `<div class="chat-message ${m.role}">${m.text.replace(/\n/g, "<br>")}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}

let chatBusy = false;

function setChatBusy(busy) {
  chatBusy = busy;
  $("chatSend").disabled = busy;
  $("chatInput").disabled = busy;
  document.querySelectorAll(".chat-chip").forEach((c) => (c.disabled = busy));
}

async function sendChatMessage(text) {
  if (!text.trim() || chatBusy) return;
  chatHistory.push({ role: "user", text });
  setChatBusy(true);
  renderChatMessages();
  const el = $("chatMessages");
  el.innerHTML += `<div class="chat-message ai typing">Analizando datos…</div>`;
  el.scrollTop = el.scrollHeight;
  try {
    const res = await fetch("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text, context: buildAssistantContext() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error del asistente");
    chatHistory.push({ role: "ai", text: data.answer });
  } catch (err) {
    chatHistory.push({ role: "ai", text: `No pude responder: ${err.message}` });
  } finally {
    setChatBusy(false);
    renderChatMessages();
    $("chatInput").focus();
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function initApp() {
  try {
    const res = await fetch("/api/config");
    supabaseConfig = await res.json();
  } catch (_) {
    supabaseConfig = { supabase_url: "", anon_key: "" };
  }
  if (supabaseConfig.anon_key && !sessionStorage.getItem("copacol_user")) {
    $("loginOverlay").classList.remove("hidden");
    return;
  }
  loadDashboard().catch((error) => {
    console.error(error);
    status(error.message);
  });
  loadAsesoresCatalog();
}

async function handleLogin(event) {
  event.preventDefault();
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  $("loginError").textContent = "";
  try {
    const res = await fetch(`${supabaseConfig.supabase_url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: supabaseConfig.anon_key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || "Credenciales incorrectas");
    sessionStorage.setItem("copacol_user", JSON.stringify({ email: data.user?.email, access_token: data.access_token }));
    $("loginOverlay").classList.add("hidden");
    loadDashboard().catch((err) => status(err.message));
  } catch (err) {
    $("loginError").textContent = err.message;
  }
}

// ── Client drawer ─────────────────────────────────────────────────────────────

function agingChipClass(days) {
  const d = Number(days || 0);
  if (d < -8) return "chip-vigente";
  if (d <= 0) return "chip-por_vencer_8";
  if (d <= 4) return "chip-1_4";
  if (d <= 15) return "chip-5_15";
  if (d <= 30) return "chip-16_30";
  if (d <= 60) return "chip-31_60";
  if (d <= 90) return "chip-61_90";
  if (d <= 120) return "chip-91_120";
  if (d <= 180) return "chip-121_180";
  return "chip-181_plus";
}

async function openClientDrawer(nit) {
  drawerNit = nit;
  $("drawerBackdrop").style.display = "block";
  $("clientDrawer").style.display = "flex";
  $("drawerName").textContent = "Cliente";
  $("drawerMeta").textContent = "Cargando…";
  $("drawerBody").innerHTML = '<p class="drawer-empty">Cargando…</p>';
  try {
    const res = await fetch(`/api/client/${encodeURIComponent(nit)}`);
    if (!res.ok) throw new Error("Error al cargar cliente");
    renderDrawer(await res.json());
  } catch (err) {
    $("drawerBody").innerHTML = `<p class="drawer-empty">Error: ${err.message}</p>`;
  }
}

function renderDrawer(payload) {
  const client = payload.client || {};
  const invoices = payload.invoices || [];
  const contacts = payload.contacts || [];
  const name = client.razon_social || "Cliente";
  $("drawerAvatar").textContent = name.substring(0, 2).toUpperCase();
  $("drawerName").textContent = name;
  $("drawerMeta").textContent = `NIT ${client.nit || "-"} · ${client.ciudad || "Sin ciudad"}`;

  const phone = cleanPhone(client.telefono || client.telefono_2 || "");

  const kpisHtml = `
    <div class="drawer-kpis">
      <div class="drawer-kpi"><span>Saldo total</span><strong>${moneyM(client.total_saldo)}</strong></div>
      <div class="drawer-kpi"><span>Vencido</span><strong>${moneyM(client.total_vencido)}</strong></div>
      <div class="drawer-kpi"><span>Mora máx.</span><strong>${number.format(client.dias_mora_max || 0)}d</strong></div>
    </div>`;

  const infoHtml = `
    <div class="drawer-info-grid">
      <div class="drawer-info-row"><span>Asesor</span><strong>${client.asesor_nombre || "Sin asesor"}</strong></div>
      <div class="drawer-info-row"><span>Condición</span><strong>${conditionLabel(client.condicion_pago_real)}</strong></div>
      <div class="drawer-info-row"><span>Plazo real</span><strong>${client.plazo_pago_real ? `${number.format(client.plazo_pago_real)} días` : "Fallback cartera"}</strong></div>
      ${client.cupo_credito ? `<div class="drawer-info-row"><span>Cupo crédito</span><strong>${money.format(amount(client.cupo_credito))}</strong></div>` : ""}
      <div class="drawer-info-row"><span>Ciudad</span><strong>${client.ciudad || "Sin ciudad"}</strong></div>
      <div class="drawer-info-row"><span>Registro plataforma</span><strong>${formatDateTime(client.created_at)}</strong></div>
      ${client.telefono ? `<div class="drawer-info-row"><span>Teléfono</span><strong>${client.telefono}</strong></div>` : ""}
      ${client.direccion ? `<div class="drawer-info-row"><span>Dirección</span><strong>${client.direccion}</strong></div>` : ""}
    </div>`;

  const actionsHtml = `
    <div class="drawer-actions-row">
      <button class="drawer-action-btn" id="registerGestionBtn">+ Registrar gestión</button>
      <button class="drawer-action-btn" id="registerPromesaBtn">+ Registrar promesa</button>
      <button class="drawer-action-btn" id="changeAsesorBtn">Cambiar asesor</button>
      ${phone ? `<a href="tel:+${phone}" class="drawer-action-btn">Llamar</a>` : ""}
      ${phone ? `<button class="drawer-action-btn" id="triggerWhatsAppBtn" data-nit="${client.nit}">Preparar WhatsApp</button>` : ""}
    </div>`;

  const overdueInvs = invoices.filter((inv) => Number(inv.dias_mora || 0) > 0).slice(0, 15);
  const invoicesHtml = overdueInvs.length
    ? `<div class="drawer-invoices"><h3>Facturas vencidas (${overdueInvs.length})</h3>
        ${overdueInvs.map((inv) => `
          <div class="drawer-invoice-row">
            <span class="inv-num">${inv.numero_factura || "-"}</span>
            <span class="inv-date">${inv.fecha_vencimiento || "-"}</span>
            <span class="inv-amount">${money.format(Number(inv.monto || 0))}</span>
            <span class="aging-chip ${agingChipClass(inv.dias_mora)}">${number.format(Number(inv.dias_mora || 0))}d</span>
          </div>`).join("")}
      </div>`
    : `<p class="drawer-empty">Sin facturas vencidas</p>`;

  const historyHtml = contacts.length
    ? `<div class="drawer-history"><h3>Historial (${contacts.length})</h3>
        ${contacts.map((c) => `
          <div class="history-row">
            <div class="history-dot"></div>
            <div>
              <div class="history-text"><strong>${c.tipo || "Contacto"}</strong> · ${c.resultado || "-"}</div>
              ${c.observacion ? `<div class="history-meta">${c.observacion}</div>` : ""}
              <div class="history-meta">${(c.created_at || "").slice(0, 10)} · ${c.registrado_por || "sistema"}</div>
            </div>
          </div>`).join("")}
      </div>`
    : "";

  $("drawerBody").innerHTML = kpisHtml + infoHtml + actionsHtml + invoicesHtml + historyHtml;
  $("registerGestionBtn").addEventListener("click", () => openContactModal(client.nit, name));
  $("registerPromesaBtn").addEventListener("click", () => {
    if (!promesasData.clientes.length) {
      loadPromesas().then(() => openPromesaModal(null, client.nit));
    } else {
      openPromesaModal(null, client.nit);
    }
  });
  $("changeAsesorBtn").addEventListener("click", () => {
    openAsesorModal(client.nit, name, client.asesor_codigo || "", client.asesor_nombre || "");
  });
  const waBtn = $("triggerWhatsAppBtn");
  if (waBtn) waBtn.addEventListener("click", () => triggerWhatsAppFlow(client.nit, waBtn));
}

function closeClientDrawer() {
  $("drawerBackdrop").style.display = "none";
  $("clientDrawer").style.display = "none";
  drawerNit = null;
}

async function triggerWhatsAppFlow(nit, button) {
  if (!nit || !button) return;
  const original = button.textContent;
  const user = JSON.parse(sessionStorage.getItem("copacol_user") || "{}");
  button.disabled = true;
  button.textContent = "Enviando…";
  try {
    const res = await fetch(`/api/client/${encodeURIComponent(nit)}/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requested_by: user.email || "dashboard" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo iniciar WhatsApp");
    button.textContent = "Listo";
    status(`WhatsApp preparado para ${data.cliente || nit}`);
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1800);
  } catch (err) {
    button.textContent = "Error";
    status(err.message);
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 2400);
  }
}

// ── Contact modal ─────────────────────────────────────────────────────────────

function openContactModal(nit, clientName) {
  $("contactNit").value = nit;
  setText("contactModalTitle", `Registrar gestión · ${clientName}`);
  $("contactResultado").value = "contactado";
  $("contactObs").value = "";
  $("contactFechaPromesa").value = "";
  $("contactMonto").value = "";
  $("promesaGroup").style.display = "none";
  $("montoGroup").style.display = "none";
  $("contactModal").showModal();
}

async function saveContact() {
  const nit = $("contactNit").value;
  const resultado = $("contactResultado").value;
  const needsExtra = ["promesa", "pago_reportado"].includes(resultado);
  const row = {
    tipo: $("contactTipo").value,
    resultado,
    observacion: $("contactObs").value.trim(),
    fecha_promesa: needsExtra ? ($("contactFechaPromesa").value || null) : null,
    monto_prometido: needsExtra ? (Number($("contactMonto").value || 0) || null) : null,
    registrado_por: JSON.parse(sessionStorage.getItem("copacol_user") || "{}").email || "sistema",
  };
  try {
    $("saveContact").disabled = true;
    $("saveContact").textContent = "Guardando…";
    const res = await fetch(`/api/client/${encodeURIComponent(nit)}/contacto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Error al guardar");
    $("contactModal").close();
    if (drawerNit === nit) openClientDrawer(nit);
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    $("saveContact").disabled = false;
    $("saveContact").textContent = "Guardar gestión";
  }
}

function downloadVisibleInvoices() {
  const rows = filteredInvoices().sort((a, b) => amount(b.dias_mora) - amount(a.dias_mora) || amount(b.monto) - amount(a.monto));
  const headers = ["Cliente", "NIT", "Factura", "Vendedor", "Ciudad", "Vence", "Dias", "Saldo", "Estado", "Condicion"];
  const csvRows = [
    headers,
    ...rows.map((invoice) => [
      invoice.cliente || "",
      invoice.nit || "",
      invoice.numero_factura || "",
      invoice.asesor_nombre || "",
      invoice.ciudad || "",
      invoice.fecha_vencimiento || "",
      amount(invoice.dias_mora),
      amount(invoice.monto),
      invoice.estado || "",
      conditionLabel(invoice.condicion_pago_real || invoice.condicion_pago),
    ]),
  ];
  const csv = csvRows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const suffix = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `cartera-copacol-${suffix}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ── Import confirm ────────────────────────────────────────────────────────────

async function confirmImport() {
  if (!importToken) return;
  $("confirmImportBtn").disabled = true;
  $("confirmImportBtn").textContent = "Actualizando base de datos…";
  try {
    const res = await fetch("/api/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: importToken }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Error en importación");
    renderImportMessage("Importación enviada", result.message || "El flujo de actualización recibió el archivo y el tablero se está recargando.", "success");
    $("importConfirm").classList.remove("visible");
    importToken = null;
    loadDashboard().catch((err) => status(err.message));
  } catch (err) {
    const rawMessage = err.message || "";
    const detail = /timed out|timeout/i.test(rawMessage)
      ? "La actualización tardó más de lo esperado. Revisa el historial y vuelve a intentar si la plantilla no aparece como activa."
      : rawMessage;
    renderImportMessage("No se pudo completar la actualización", detail, "error");
  } finally {
    $("confirmImportBtn").disabled = false;
    $("confirmImportBtn").textContent = "Confirmar importación";
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

$("refreshBtn").addEventListener("click", () => loadDashboard().catch((error) => status(error.message)));
$("globalSearch").addEventListener("input", rerenderFilteredViews);
$("sellerFilter").addEventListener("change", rerenderFilteredViews);
$("agingFilter").addEventListener("change", rerenderFilteredViews);
$("minAmount").addEventListener("input", rerenderFilteredViews);
$("clearFilters").addEventListener("click", () => {
  $("globalSearch").value = "";
  $("sellerFilter").value = "all";
  $("agingFilter").value = "all";
  $("minAmount").value = "";
  clientNoGestionMode = false;
  rerenderFilteredViews();
});
document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segment").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    tableMode = button.dataset.mode;
    renderInvoices();
  });
});
$("importForm").addEventListener("submit", previewImport);
$("confirmImportBtn").addEventListener("click", confirmImport);
$("downloadInvoicesBtn").addEventListener("click", downloadVisibleInvoices);
$("noGestion5dBtn").addEventListener("click", () => {
  clientNoGestionMode = !clientNoGestionMode;
  showPage("clientes");
  rerenderFilteredViews();
});
$("refreshHistoryBtn").addEventListener("click", loadImportHistory);
$("closeDrawer").addEventListener("click", closeClientDrawer);
$("drawerBackdrop").addEventListener("click", closeClientDrawer);
$("loginForm").addEventListener("submit", handleLogin);
$("promesaFilter").addEventListener("change", (event) => {
  promesaFilter = event.target.value || "all";
  loadPromesas();
});
$("newPromesaBtn").addEventListener("click", () => {
  if (!promesasData.clientes.length) {
    loadPromesas().then(() => openPromesaModal());
  } else {
    openPromesaModal();
  }
});
$("closePromesaModal").addEventListener("click", () => $("promesaModal").close());
$("cancelPromesa").addEventListener("click", () => $("promesaModal").close());
$("savePromesa").addEventListener("click", savePromesaForm);
$("promesaCliente").addEventListener("change", () => {
  const value = $("promesaCliente").value.trim();
  const found = (promesasData.clientes || []).find(
    (client) => (client.razon_social || "").toLowerCase() === value.toLowerCase() || client.nit === value,
  );
  if (found) {
    $("promesaNit").value = found.nit;
    setText("promesaClienteHint", `${found.razon_social || "Cliente"} · NIT ${found.nit} · ${found.asesor_nombre || "Sin asesor"}`);
  } else {
    $("promesaNit").value = "";
    setText("promesaClienteHint", "Cliente no reconocido — verifica el NIT.");
  }
});
$("closeAsesorModal").addEventListener("click", () => $("asesorModal").close());
$("saveAsesor").addEventListener("click", saveAsesorForm);
$("removeAsesor").addEventListener("click", removeAsesorFromClient);
$("asesorExistente").addEventListener("change", () => {
  if ($("asesorExistente").value) {
    $("asesorNuevoCodigo").value = "";
    $("asesorNuevoNombre").value = "";
  }
});
$("refreshAdvisorManage")?.addEventListener("click", () => loadAsesoresGestion(true));
$("advisorManageSearch")?.addEventListener("input", () => {
  advisorManageSearch = $("advisorManageSearch").value;
  renderAdvisorManageClients();
});
$("advisorManageTarget")?.addEventListener("change", () => {
  if ($("advisorManageTarget").value) {
    $("advisorManageNewCodigo").value = "";
    $("advisorManageNewNombre").value = "";
  }
});
$("advisorManageNewCodigo")?.addEventListener("input", () => {
  if ($("advisorManageNewCodigo").value || $("advisorManageNewNombre").value) $("advisorManageTarget").value = "";
});
$("advisorManageNewNombre")?.addEventListener("input", () => {
  if ($("advisorManageNewCodigo").value || $("advisorManageNewNombre").value) $("advisorManageTarget").value = "";
});
$("advisorManageSelectAll")?.addEventListener("change", () => {
  const visible = advisorManageFilteredClients();
  if ($("advisorManageSelectAll").checked) visible.forEach((client) => advisorManageSelected.add(client.nit));
  else visible.forEach((client) => advisorManageSelected.delete(client.nit));
  renderAdvisorManageClients();
});
$("assignSelectedAdvisor")?.addEventListener("click", () => saveAdvisorManageSelection());
$("clearSelectedAdvisor")?.addEventListener("click", () => saveAdvisorManageSelection("quitar"));
$("cancelContact").addEventListener("click", () => $("contactModal").close());
$("closeContactModal").addEventListener("click", () => $("contactModal").close());
$("saveContact").addEventListener("click", saveContact);
$("contactResultado").addEventListener("change", () => {
  const show = ["promesa", "pago_reportado"].includes($("contactResultado").value);
  $("promesaGroup").style.display = show ? "" : "none";
  $("montoGroup").style.display = show ? "" : "none";
});
$("assistantFab").addEventListener("click", () => {
  $("assistantPanel").classList.add("open");
  renderChatMessages();
  $("chatInput").focus();
});
$("closeAssistant").addEventListener("click", () => $("assistantPanel").classList.remove("open"));
$("chatSend").addEventListener("click", () => {
  const text = $("chatInput").value.trim();
  if (text) { $("chatInput").value = ""; sendChatMessage(text); }
});
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatSend").click(); }
});
document.querySelectorAll(".chat-chip").forEach((btn) => {
  btn.addEventListener("click", () => sendChatMessage(btn.dataset.prompt));
});
document.querySelectorAll("[data-page-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showPage(link.dataset.pageLink);
  });
});
updateClock();
setInterval(updateClock, 1000);
showPage(location.hash ? location.hash.replace("#", "") : "tablero");
$("closeAdvisorModal").addEventListener("click", () => $("advisorModal").close());
$("copyAdvisorReport").addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentAdvisorReport);
  $("copyAdvisorReport").textContent = "Copiado";
  setTimeout(() => {
    $("copyAdvisorReport").textContent = "Copiar resumen";
  }, 1400);
});
$("shareAdvisorReport").addEventListener("click", async () => {
  if (navigator.share) {
    await navigator.share({ title: "Reporte COPACOL", text: currentAdvisorReport });
  } else {
    await navigator.clipboard.writeText(currentAdvisorReport);
  }
});

initApp();
