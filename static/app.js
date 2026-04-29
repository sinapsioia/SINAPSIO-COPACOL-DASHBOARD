const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat("es-CO");
const pct = new Intl.NumberFormat("es-CO", { style: "percent", maximumFractionDigits: 1 });

let dashboard = null;
let tableMode = "all";
let currentAdvisorReport = "";
let currentPage = "tablero";
let supabaseConfig = null;
let importToken = null;
let drawerNit = null;

const agingLabels = {
  vigente: ["Vigente", "var(--green)"],
  "1_30": ["1-30 días", "var(--yellow)"],
  "31_60": ["31-60 días", "var(--orange)"],
  "61_90": ["61-90 días", "var(--red)"],
  "91_120": ["91-120 días", "#e5484d"],
  "121_180": ["121-180 días", "#9f2d20"],
  "181_plus": ["+181 días", "#5b1a14"],
};

const conditionLabels = {
  platam_30d: ["Platam 30d", "#3b82f6"],
  credito_45d: ["Crédito 45d", "#f97316"],
  credito_60d: ["Crédito 60d", "#60a5fa"],
  credito_otro: ["Crédito otro", "#8b5cf6"],
  contado: ["Contado", "#10b981"],
  sin_condicion: ["Sin condición", "#64748b"],
};

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function status(text) {
  setText("syncState", text);
}

function amount(value) {
  return Number(value || 0);
}

function moneyM(value) {
  return `$${(amount(value) / 1000000).toLocaleString("es-CO", { maximumFractionDigits: 2 })}M`;
}

function conditionValue(key) {
  return amount(((dashboard.view || dashboard).condition_mix.find((item) => item.condicion === key) || {}).saldo);
}

function advisorInvoices(code) {
  return dashboard.invoices.filter((invoice) => invoice.asesor_codigo === code);
}

function advisorClients(code) {
  return dashboard.clients.filter((client) => client.asesor_codigo === code);
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
    const amountOk = amount(row.monto) >= filters.minAmount;
    return sellerOk && agingOk && amountOk && matchesText(row, filters.term);
  });
}

function filteredClients() {
  const filters = activeFilters();
  return dashboard.clients.filter((client) => {
    const sellerOk = filters.seller === "all" || client.asesor_codigo === filters.seller;
    const amountOk = amount(client.total_saldo) >= filters.minAmount;
    const textOk =
      !filters.term ||
      [client.nit, client.razon_social, client.asesor_nombre, client.ciudad, client.telefono]
        .join(" ")
        .toLowerCase()
        .includes(filters.term);
    const agingOk =
      filters.aging === "all" ||
      (filters.aging === "vigente" && amount(client.total_vencido) === 0) ||
      (filters.aging !== "vigente" && amount(client.total_vencido) > 0);
    return sellerOk && amountOk && textOk && agingOk;
  });
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
      vigente: 0,
      "1_30": 0,
      "31_60": 0,
      "61_90": 0,
      "91_120": 0,
      "121_180": 0,
      "181_plus": 0,
      pct_vencido: 0,
    };
    const value = amount(invoice.monto);
    row.total += value;
    row[invoice.aging_bucket] += value;
    if (amount(invoice.dias_mora) > 0) row.vencido += value;
    grouped[code] = row;
  });
  return Object.values(grouped)
    .map((row) => ({ ...row, pct_vencido: row.total ? row.vencido / row.total : 0 }))
    .sort((a, b) => b.total - a.total);
}

function buildView() {
  const invoices = filteredInvoices(false);
  const clients = filteredClients();
  const aging = { vigente: 0, "1_30": 0, "31_60": 0, "61_90": 0, "91_120": 0, "121_180": 0, "181_plus": 0 };
  const conditionMap = {};
  const dueSoon = [];
  let totalVencido = 0;
  let totalVigente = 0;
  let facturasVencidas = 0;
  let moraSum = 0;

  invoices.forEach((invoice) => {
    const value = amount(invoice.monto);
    const days = amount(invoice.dias_mora);
    aging[invoice.aging_bucket] += value;
    conditionMap[invoice.condicion_pago || "sin_condicion"] = (conditionMap[invoice.condicion_pago || "sin_condicion"] || 0) + value;
    if (days > 0) {
      totalVencido += value;
      facturasVencidas += 1;
      moraSum += days;
    } else {
      totalVigente += value;
      if (days >= -7) dueSoon.push(invoice);
    }
  });

  const totalSaldo = totalVencido + totalVigente;
  const sellerRows = buildSellerAging(invoices);
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
    sellers: sellerRows.map((row) => ({ codigo: row.codigo, nombre: row.nombre, saldo: row.total, vencido: row.vencido, clientes: clients.filter((c) => c.asesor_codigo === row.codigo).length })),
    cities: Object.entries(
      clients.reduce((acc, client) => {
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
      clientes: clients.length,
      clientes_vencidos: clients.filter((client) => amount(client.total_vencido) > 0).length,
      facturas: invoices.length,
      facturas_vencidas: facturasVencidas,
      mora_promedio: facturasVencidas ? moraSum / facturasVencidas : 0,
      concentracion_top10: clients.slice(0, 10).reduce((sum, client) => sum + amount(client.total_saldo), 0),
      concentracion_top10_pct: totalSaldo ? clients.slice(0, 10).reduce((sum, client) => sum + amount(client.total_saldo), 0) / totalSaldo : 0,
      over_90: aging["91_120"] + aging["121_180"] + aging["181_plus"],
      over_90_pct: totalSaldo ? (aging["91_120"] + aging["121_180"] + aging["181_plus"]) / totalSaldo : 0,
    },
  };
}

async function loadDashboard() {
  status("Actualizando...");
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "No se pudo cargar Supabase");
  }
  dashboard = await response.json();
  hydrateFilters();
  renderDashboard();
  status("Datos actualizados");
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
  const contado = conditionValue("contado");

  setText("cutDate", summary.fecha_corte || "Sin fecha de corte");
  setText("heroTitle", `${number.format(summary.facturas)} documentos · ${number.format(summary.clientes)} clientes`);
  setText("kpiTotal", money.format(summary.total_saldo));
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
  setText("kpiContado", moneyM(contado));
  setText("kpiContadoPct", pct.format(contado / summary.total_saldo || 0));
  setText("goalOverdue", pct.format(overdueRatio));
  setText("goalOver90", pct.format(summary.over_90_pct || 0));
  setText("riskPill", overdueRatio > 0.55 ? "Riesgo alto: priorizar vencidos" : overdueRatio > 0.35 ? "Riesgo medio: seguimiento diario" : "Cartera controlada");
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
}

function renderConditionMix() {
  const view = dashboard.view || dashboard;
  const total = view.summary.total_saldo || 1;
  let cursor = 0;
  const stops = view.condition_mix.map((item) => {
    const [label, color] = conditionLabels[item.condicion] || [item.condicion, "#64748b"];
    const start = cursor;
    cursor += (item.saldo / total) * 100;
    return `${color} ${start}% ${cursor}%`;
  });
  $("mixDonut").style.background = `conic-gradient(${stops.join(", ")})`;
  $("mixLegend").innerHTML = view.condition_mix
    .map((item) => {
      const [label, color] = conditionLabels[item.condicion] || [item.condicion, "#64748b"];
      return `
        <div class="legend-row">
          <i style="background:${color}"></i>
          <span>${label}</span>
          <strong>${moneyM(item.saldo)} <em>${pct.format(item.saldo / total)}</em></strong>
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
      ["total", "1_30", "31_60", "61_90", "91_120", "121_180", "181_plus", "vencido"].forEach((key) => {
        acc[key] += amount(row[key]);
      });
      return acc;
    },
    { total: 0, "1_30": 0, "31_60": 0, "61_90": 0, "91_120": 0, "121_180": 0, "181_plus": 0, vencido: 0 },
  );
  const body = rows
    .map((row) => {
      const cls = row.pct_vencido <= 0.08 ? "ok" : row.pct_vencido <= 0.15 ? "late" : "critical";
      return `
        <tr class="advisor-row" data-advisor="${row.codigo}">
          <td>${row.nombre}</td>
          <td>${moneyM(row.total)}</td>
          <td>${moneyM(row["1_30"])}</td>
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
        <td>${moneyM(totals["1_30"])}</td>
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

function renderInsights() {
  renderPareto();
  renderEffortChart();
  renderDueSoonChart();
  renderContactChart();
  renderAdvisorRiskMap();
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
    { label: "Recordatorio", keys: ["1_30"], color: "var(--yellow)" },
    { label: "Negociación", keys: ["31_60"], color: "var(--orange)" },
    { label: "Escalar asesor", keys: ["61_90", "91_120"], color: "var(--red)" },
    { label: "Plan especial", keys: ["121_180", "181_plus"], color: "#5b1a14" },
  ];
  const aging = (dashboard.view || dashboard).aging;
  const max = Math.max(...items.map((item) => item.keys.reduce((sum, key) => sum + amount(aging[key]), 0)), 1);
  $("effortChart").innerHTML = items
    .map((item) => {
      const value = item.keys.reduce((sum, key) => sum + amount(aging[key]), 0);
      const height = Math.max(4, (value / max) * 100);
      return `
        <div class="effort-item">
          <div class="effort-bar"><i style="height:${height}%;background:${item.color}"></i></div>
          <strong>${moneyM(value)}</strong>
          <span>${item.label}</span>
        </div>
      `;
    })
    .join("");
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
      ${["1_30", "31_60", "61_90", "91_120", "121_180", "181_plus"]
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
      const waText = encodeURIComponent(`Hola ${client.razon_social}, le contactamos de COPACOL sobre su estado de cartera.`);
      return `
        <article class="client-card ${client.prioridad === "Alta" ? "hot" : ""}" data-nit="${client.nit}">
          <div class="client-top">
            <strong>${client.razon_social || "Cliente sin nombre"}</strong>
            <span class="tag">${client.prioridad || "Normal"}</span>
          </div>
          <span class="muted">NIT ${client.nit || "-"} · ${client.asesor_nombre || "Sin asesor"}</span>
          <span class="amount">${money.format(amount(client.total_saldo))}</span>
          <div class="client-split">
            <span>Vencido <b>${money.format(overdue)}</b></span>
            <span>${client.num_facturas || 0} docs</span>
            <span>${client.dias_mora_max || 0} días</span>
          </div>
          <div class="client-actions" aria-label="Acciones rápidas">
            ${phone ? `<a href="tel:+${phone}" title="Llamar">Tel</a>` : `<span title="Sin teléfono">Tel</span>`}
            ${phone ? `<a href="https://wa.me/${phone}?text=${waText}" target="_blank" rel="noreferrer" title="WhatsApp">WA</a>` : `<span title="Sin WhatsApp">WA</span>`}
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
  $("clientGrid").innerHTML = clientCards(rows);
  $("clientGrid").querySelectorAll(".drawer-trigger").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openClientDrawer(btn.dataset.nit);
    });
  });
}

async function previewImport(event) {
  event.preventDefault();
  const file = $("xlsxFile").files[0];
  if (!file) {
    $("importResult").textContent = "Selecciona un archivo .xlsx.";
    return;
  }
  $("importResult").textContent = "Validando archivo...";
  $("importConfirm").classList.remove("visible");
  importToken = null;
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/api/import/preview", { method: "POST", body: formData });
  const result = await response.json();
  $("importResult").textContent = JSON.stringify(result, null, 2);
  if (result.token) {
    importToken = result.token;
    setText("importConfirmMsg", `Validación exitosa: ${number.format(result.facturas)} facturas, ${number.format(result.clientes)} clientes · ${moneyM(result.saldo_total)}`);
    setText("importConfirmDetail", `Corte detectado: ${result.fecha_corte_detectada || "no detectado"} · ${number.format(result.vendedores)} vendedores`);
    $("importConfirm").classList.add("visible");
  }
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
  };
  setText("pageTitle", labels[page] || "Dashboard de Cobranzas");
  document.querySelectorAll("[data-page]").forEach((section) => {
    section.classList.toggle("active", section.dataset.page === page);
  });
  document.querySelectorAll("[data-page-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.pageLink === page);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderAssistantAnswer(type) {
  if (!dashboard) return;
  const view = dashboard.view || buildView();
  if (type === "asesor") {
    const advisor = [...view.seller_aging].sort((a, b) => b.pct_vencido - a.pct_vencido || b.vencido - a.vencido)[0];
    $("assistantAnswer").innerHTML = advisor
      ? `<strong>${advisor.nombre}</strong> es el asesor más crítico: ${pct.format(advisor.pct_vencido)} vencido sobre ${money.format(advisor.total)}. Prioriza sus clientes con mayor mora y revisa promesas de pago.`
      : "No hay asesor crítico con el filtro actual.";
  }
  if (type === "clientes") {
    const clients = [...view.clients].filter((client) => amount(client.total_vencido) > 0).sort((a, b) => amount(b.total_vencido) - amount(a.total_vencido)).slice(0, 3);
    $("assistantAnswer").innerHTML = clients.length
      ? clients.map((client, index) => `<strong>${index + 1}. ${client.razon_social}</strong>: ${money.format(client.total_vencido)} vencido, ${client.dias_mora_max} días.`).join("<br>")
      : "No hay clientes vencidos con el filtro actual.";
  }
  if (type === "riesgo") {
    const ratio = view.summary.total_saldo ? view.summary.total_vencido / view.summary.total_saldo : 0;
    const color = ratio <= 0.08 ? "verde" : ratio <= 0.15 ? "amarillo" : "rojo";
    $("assistantAnswer").innerHTML = `El semáforo está en <strong>${color}</strong>: ${pct.format(ratio)} de la cartera está vencida. La meta del PDF es verde hasta 8%, amarillo 8-15% y rojo por encima de 15%.`;
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
  if (d <= 0) return "chip-vigente";
  if (d <= 30) return "chip-1_30";
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
  const waText = encodeURIComponent(`Hola ${name}, le contactamos de COPACOL sobre su estado de cartera.`);

  const kpisHtml = `
    <div class="drawer-kpis">
      <div class="drawer-kpi"><span>Saldo total</span><strong>${moneyM(client.total_saldo)}</strong></div>
      <div class="drawer-kpi"><span>Vencido</span><strong>${moneyM(client.total_vencido)}</strong></div>
      <div class="drawer-kpi"><span>Mora máx.</span><strong>${number.format(client.dias_mora_max || 0)}d</strong></div>
    </div>`;

  const infoHtml = `
    <div class="drawer-info-grid">
      <div class="drawer-info-row"><span>Asesor</span><strong>${client.asesor_nombre || "Sin asesor"}</strong></div>
      <div class="drawer-info-row"><span>Ciudad</span><strong>${client.ciudad || "Sin ciudad"}</strong></div>
      ${client.telefono ? `<div class="drawer-info-row"><span>Teléfono</span><strong>${client.telefono}</strong></div>` : ""}
      ${client.direccion ? `<div class="drawer-info-row"><span>Dirección</span><strong>${client.direccion}</strong></div>` : ""}
    </div>`;

  const actionsHtml = `
    <div class="drawer-actions-row">
      <button class="drawer-action-btn" id="registerGestionBtn">+ Registrar gestión</button>
      ${phone ? `<a href="tel:+${phone}" class="drawer-action-btn">Llamar</a>` : ""}
      ${phone ? `<a href="https://wa.me/${phone}?text=${waText}" target="_blank" rel="noreferrer" class="drawer-action-btn">WhatsApp</a>` : ""}
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
}

function closeClientDrawer() {
  $("drawerBackdrop").style.display = "none";
  $("clientDrawer").style.display = "none";
  drawerNit = null;
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

// ── Import confirm ────────────────────────────────────────────────────────────

async function confirmImport() {
  if (!importToken) return;
  $("confirmImportBtn").disabled = true;
  $("confirmImportBtn").textContent = "Importando…";
  try {
    const res = await fetch("/api/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: importToken }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Error en importación");
    $("importResult").textContent = JSON.stringify(result, null, 2);
    $("importConfirm").classList.remove("visible");
    importToken = null;
    loadDashboard().catch((err) => status(err.message));
  } catch (err) {
    $("importResult").textContent = `Error: ${err.message}`;
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
$("closeDrawer").addEventListener("click", closeClientDrawer);
$("drawerBackdrop").addEventListener("click", closeClientDrawer);
$("loginForm").addEventListener("submit", handleLogin);
$("cancelContact").addEventListener("click", () => $("contactModal").close());
$("closeContactModal").addEventListener("click", () => $("contactModal").close());
$("saveContact").addEventListener("click", saveContact);
$("contactResultado").addEventListener("change", () => {
  const show = ["promesa", "pago_reportado"].includes($("contactResultado").value);
  $("promesaGroup").style.display = show ? "" : "none";
  $("montoGroup").style.display = show ? "" : "none";
});
$("assistantFab").addEventListener("click", () => $("assistantPanel").classList.add("open"));
$("closeAssistant").addEventListener("click", () => $("assistantPanel").classList.remove("open"));
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => renderAssistantAnswer(button.dataset.prompt));
});
document.querySelectorAll("[data-page-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showPage(link.dataset.pageLink);
  });
});
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
