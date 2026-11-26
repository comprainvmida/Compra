/* ============================================================================
 * MRP PRO · ALIMENTOS MIDA (QUIDY)
 * Integrado con Supabase Auth + Postgres + Proveedores Aprobados
 * ============================================================================ */

const sb = supabase.createClient(window.CFG.SUPABASE_URL, window.CFG.SUPABASE_ANON_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmt = (v, d = 2) => num(v).toLocaleString("es-VE", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUsd = v => "$" + fmt(v, 2);

const STATE = {
  tab: "dashboard",
  planes: [],
  activePlanId: null,
  materials: new Map(),   // code -> obj
  skus: new Map(),        // code -> obj
  bom: new Map(),         // sku_code -> [{ mat_code, qty_per_batch }]
  planItems: new Map(),   // sku_code -> { forecast, plan_qty, w1..w5 }
  compras: new Map(),     // mat_code -> { decision_qty, provider, oc, w1..w5 }
  proveedores: [],        // nombres de proveedores aprobados
  selectedSku: null,
  // Filtros UI persistentes en sesión
  fPlan: { q: "", cat: "", onlyWithQty: false },
  fAnalisis: { q: "", type: "", onlyActive: true, showAdv: false },
  fProcura: { q: "", onlyActive: true },
  fCatalogo: { q: "", type: "" },
  fCostos: { q: "", type: "", onlyZero: false },
  fBom: { q: "", cat: "" },
  charts: {}
};

// -------------------- UTILIDADES UI & SYNC --------------------
function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

let pendingSaves = 0;
function setSync(state, label) {
  const pill = $("#sync_pill");
  if (!pill) return;
  pill.className = "sync-pill" + (state === "saving" ? " saving" : state === "err" ? " err" : "");
  pill.textContent = label || (state === "saving" ? "Guardando…" : state === "err" ? "Error al guardar" : "Sincronizado ✓");
}

const timers = new Map();
function debounceSave(key, fn, delay = 450) {
  clearTimeout(timers.get(key));
  setSync("saving");
  timers.set(key, setTimeout(async () => {
    pendingSaves++;
    try {
      await fn();
      pendingSaves = Math.max(0, pendingSaves - 1);
      if (pendingSaves === 0) setSync("ok");
    } catch (err) {
      pendingSaves = Math.max(0, pendingSaves - 1);
      console.error("Supabase save error:", err);
      setSync("err");
      toast("Error guardando en Supabase: " + (err.message || err), true);
    }
  }, delay));
}

async function batchUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const opts = onConflict ? { onConflict } : {};
    const { error } = await sb.from(table).upsert(chunk, opts);
    if (error) throw error;
  }
}

// -------------------- AUTENTICACIÓN COMPARTIDA --------------------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  $("#login").hidden = !!session;
  $("#app").hidden = !session;
  $("#admin_nav").hidden = !session;
  if (session) await loadAll();
}

$("#lf").onsubmit = async e => {
  e.preventDefault();
  $("#lerr").textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: $("#em").value, password: $("#pw").value });
  if (error) $("#lerr").textContent = "Correo o contraseña incorrectos.";
  else boot();
};

$("#btn_out").onclick = async () => { await sb.auth.signOut(); boot(); };

// -------------------- CARGA INICIAL DESDE SUPABASE --------------------
async function loadAll() {
  setSync("saving", "Cargando datos…");
  try {
    const [rPlanes, rMats, rSkus, rBom, rProv] = await Promise.all([
      sb.from("mrp_planes").select("*").order("created_at", { ascending: false }),
      sb.from("mrp_materiales").select("*").order("code"),
      sb.from("mrp_skus").select("*").order("category").order("name"),
      sb.from("mrp_bom").select("*"),
      sb.from("proveedores").select("razon_social,nombre_comercial,estatus").eq("estatus", "aprobado").order("razon_social")
    ]);
    for (const r of [rPlanes, rMats, rSkus, rBom]) {
      if (r.error) throw r.error;
    }

    STATE.planes = rPlanes.data || [];
    if (!STATE.planes.length) {
      const { data: created, error } = await sb.from("mrp_planes").insert({
        name: "Planificación " + new Date().toISOString().slice(0, 7),
        is_active: true
      }).select().single();
      if (error) throw error;
      STATE.planes = [created];
    }

    if (!STATE.activePlanId || !STATE.planes.some(p => p.id === STATE.activePlanId)) {
      const act = STATE.planes.find(p => p.is_active) || STATE.planes[0];
      STATE.activePlanId = act.id;
    }

    STATE.materials.clear();
    (rMats.data || []).forEach(m => STATE.materials.set(m.code, m));

    STATE.skus.clear();
    (rSkus.data || []).forEach(s => STATE.skus.set(s.code, s));

    STATE.bom.clear();
    (rBom.data || []).forEach(b => {
      if (!STATE.bom.has(b.sku_code)) STATE.bom.set(b.sku_code, []);
      STATE.bom.get(b.sku_code).push({ id: b.id, mat_code: b.mat_code, qty_per_batch: num(b.qty_per_batch) });
    });

    STATE.proveedores = (rProv.data || []).map(p => p.nombre_comercial ? `${p.razon_social} (${p.nombre_comercial})` : p.razon_social);
    $("#dl_proveedores").innerHTML = STATE.proveedores.map(p => `<option value="${esc(p)}"></option>`).join("");

    renderPlanSelector();
    await loadPlanData(STATE.activePlanId);
    setSync("ok");
  } catch (err) {
    console.error(err);
    setSync("err", "Error de conexión");
    $("#view").innerHTML = `<div class="panel-card"><h3 style="color:var(--danger)">No se pudieron cargar las tablas MRP</h3>
      <p>Verifique que ejecutó <code>supabase_mrp.sql</code> en el SQL Editor de Supabase.</p>
      <p class="hint">Detalle: ${esc(err.message || err)}</p></div>`;
  }
}

async function loadPlanData(planId) {
  const [rItems, rComp] = await Promise.all([
    sb.from("mrp_plan_items").select("*").eq("plan_id", planId),
    sb.from("mrp_compras").select("*").eq("plan_id", planId)
  ]);
  if (rItems.error) throw rItems.error;
  if (rComp.error) throw rComp.error;

  STATE.planItems.clear();
  (rItems.data || []).forEach(it => STATE.planItems.set(it.sku_code, it));

  STATE.compras.clear();
  (rComp.data || []).forEach(c => STATE.compras.set(c.mat_code, c));

  if (!STATE.selectedSku && STATE.skus.size) STATE.selectedSku = [...STATE.skus.keys()][0];
  renderView();
}

function renderPlanSelector() {
  const sel = $("#plan_sel");
  sel.innerHTML = STATE.planes.map(p => `<option value="${p.id}" ${p.id === STATE.activePlanId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  sel.onchange = async () => {
    STATE.activePlanId = sel.value;
    setSync("saving", "Cambiando plan…");
    await loadPlanData(STATE.activePlanId);
    setSync("ok");
  };
}

// -------------------- MOTOR DE CÁLCULO MRP --------------------
function getPlanItem(skuCode) {
  return STATE.planItems.get(skuCode) || { forecast: 0, plan_qty: 0, w1: 0, w2: 0, w3: 0, w4: 0, w5: 0 };
}

function getCompra(matCode) {
  return STATE.compras.get(matCode) || { decision_qty: 0, provider: "", oc: "", w1: 0, w2: 0, w3: 0, w4: 0, w5: 0 };
}

function calcSuggestedPurchase(consumo, stock, safetyPct, moq, rounding) {
  if (consumo <= 0) return { rawReq: 0, suggested: 0 };
  const target = consumo * (1 + Math.max(0, safetyPct));
  const rawReq = Math.max(0, target - stock);
  if (rawReq <= 0) return { rawReq: 0, suggested: 0 };
  const m = Math.max(0, moq);
  const r = rounding > 0 ? rounding : 1;
  let suggested = rawReq;
  if (m > 0 && rawReq <= m) suggested = m;
  else if (m > 0) suggested = m + Math.ceil((rawReq - m) / r) * r;
  else suggested = Math.ceil(rawReq / r) * r;
  return { rawReq, suggested };
}

function computeMrp() {
  const consumption = new Map(); // mat_code -> { total, w1..w5, byCat: Map(cat -> qty) }
  const ensureCons = code => {
    if (!consumption.has(code)) consumption.set(code, { total: 0, w1: 0, w2: 0, w3: 0, w4: 0, w5: 0, byCat: new Map() });
    return consumption.get(code);
  };

  let totalCases = 0;
  const catCases = new Map();

  for (const [skuCode, sku] of STATE.skus.entries()) {
    const pi = getPlanItem(skuCode);
    const pQty = num(pi.plan_qty);
    totalCases += pQty;
    catCases.set(sku.category, (catCases.get(sku.category) || 0) + pQty);

    const bCases = num(sku.batch_size_cases) > 0 ? num(sku.batch_size_cases) : 1;
    const bomList = STATE.bom.get(skuCode) || [];
    if (!bomList.length) continue;

    const batchesTotal = pQty / bCases;
    const bw1 = num(pi.w1) / bCases, bw2 = num(pi.w2) / bCases, bw3 = num(pi.w3) / bCases, bw4 = num(pi.w4) / bCases, bw5 = num(pi.w5) / bCases;

    for (const item of bomList) {
      const q = num(item.qty_per_batch);
      if (q <= 0) continue;
      const c = ensureCons(item.mat_code);
      const addTot = batchesTotal * q;
      c.total += addTot;
      c.w1 += bw1 * q; c.w2 += bw2 * q; c.w3 += bw3 * q; c.w4 += bw4 * q; c.w5 += bw5 * q;
      if (addTot > 0) c.byCat.set(sku.category, (c.byCat.get(sku.category) || 0) + addTot);
    }
  }

  const rows = [];
  let totalInvUsd = 0, totalMpUsd = 0, totalMeUsd = 0, deficitCount = 0, noCostCount = 0;
  const weeklyUsd = [0, 0, 0, 0, 0];
  const catInv = new Map();

  for (const [code, m] of STATE.materials.entries()) {
    const c = consumption.get(code) || { total: 0, w1: 0, w2: 0, w3: 0, w4: 0, w5: 0, byCat: new Map() };
    const comp = getCompra(code);
    const stock = num(m.stock);
    const cost = num(m.cost);
    const diff = stock - c.total;
    const covInit = c.total > 0 ? stock / c.total : 0;
    const { rawReq, suggested } = calcSuggestedPurchase(c.total, stock, num(m.safety_pct), num(m.moq), num(m.rounding));
    const decision = num(comp.decision_qty);
    const stockFinal = stock - c.total + decision;
    const covFinal = c.total > 0 ? stockFinal / c.total : 0;
    const invUsd = decision * cost;

    totalInvUsd += invUsd;
    if (m.type === "MP") totalMpUsd += invUsd; else totalMeUsd += invUsd;
    if (stockFinal < -1e-6) deficitCount++;
    if ((c.total > 0 || decision > 0) && cost <= 0) noCostCount++;

    weeklyUsd[0] += num(comp.w1) * cost;
    weeklyUsd[1] += num(comp.w2) * cost;
    weeklyUsd[2] += num(comp.w3) * cost;
    weeklyUsd[3] += num(comp.w4) * cost;
    weeklyUsd[4] += num(comp.w5) * cost;

    if (invUsd > 0 && c.total > 0) {
      for (const [cat, qtyCat] of c.byCat.entries()) {
        const share = qtyCat / c.total;
        if (!catInv.has(cat)) catInv.set(cat, { mp: 0, me: 0 });
        if (m.type === "MP") catInv.get(cat).mp += invUsd * share;
        else catInv.get(cat).me += invUsd * share;
      }
    }

    rows.push({
      m, c, comp, stock, cost, diff, covInit, rawReq, suggested,
      decision, stockFinal, covFinal, invUsd,
      hasDeficit: stockFinal < -1e-6,
      noCost: (c.total > 0 || decision > 0) && cost <= 0
    });
  }

  return { rows, totalCases, totalInvUsd, totalMpUsd, totalMeUsd, deficitCount, noCostCount, weeklyUsd, catInv, catCases };
}

function getFilteredAnalisisRows(mrp) {
  const q = STATE.fAnalisis.q.toLowerCase().trim();
  return mrp.rows.filter(r =>
    (!STATE.fAnalisis.type || r.m.type === STATE.fAnalisis.type) &&
    (!STATE.fAnalisis.onlyActive || r.c.total > 0 || r.hasDeficit || r.decision > 0) &&
    (!q || r.m.code.toLowerCase().includes(q) || r.m.name.toLowerCase().includes(q))
  );
}

function skuCostBreakdown(skuCode) {
  const sku = STATE.skus.get(skuCode);
  const bom = STATE.bom.get(skuCode) || [];
  let mp = 0, me = 0, kgSum = 0;
  for (const item of bom) {
    const m = STATE.materials.get(item.mat_code);
    if (!m) continue;
    const q = num(item.qty_per_batch);
    const c = num(m.cost) * q;
    if (m.type === "MP") {
      mp += c;
      if (["kg", "l", "lt", "lts"].includes(String(m.um || "").toLowerCase())) kgSum += q;
    } else {
      me += c;
    }
  }
  const total = mp + me;
  const bCases = num(sku?.batch_size_cases) > 0 ? num(sku.batch_size_cases) : 1;
  const uCase = num(sku?.units_per_case) > 0 ? num(sku.units_per_case) : 1;
  return { mp, me, total, perCase: total / bCases, perUnit: total / (bCases * uCase), kgSum };
}

// -------------------- NAVEGACIÓN DE PESTAÑAS --------------------
$("#tabs").onclick = e => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  STATE.tab = btn.dataset.tab;
  document.querySelectorAll(".mrp-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === STATE.tab));
  renderView();
};

function renderView() {
  Object.values(STATE.charts).forEach(ch => ch?.destroy?.());
  STATE.charts = {};
  const v = $("#view");
  if (STATE.tab === "dashboard") renderDashboard(v);
  else if (STATE.tab === "plan") renderPlan(v);
  else if (STATE.tab === "analisis") renderAnalisis(v);
  else if (STATE.tab === "procura") renderProcura(v);
  else if (STATE.tab === "catalogo") renderCatalogo(v);
  else if (STATE.tab === "costos") renderCostos(v);
  else if (STATE.tab === "formulas") renderFormulas(v);
}

// -------------------- 1. DASHBOARD --------------------
function renderDashboard(v) {
  if (!STATE.skus.size && !STATE.materials.size) {
    v.innerHTML = `<div class="empty-hero">
      <h2>Comience su Planificación MRP</h2>
      <p class="hint" style="max-width:540px;margin:0 auto 20px">La base de datos está lista y vacía. Puede importar directamente su archivo <strong>planificacion 1.1.xlsx</strong> para cargar todas las fórmulas, insumos y costos en Supabase, o empezar creando su primera fórmula.</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="primary" onclick="document.getElementById('inp_xlsx').click()">Importar planificacion 1.1.xlsx</button>
        <button onclick="STATE.tab='formulas';document.querySelector('[data-tab=formulas]').click()">Crear Primera Fórmula</button>
      </div>
    </div>`;
    return;
  }

  const mrp = computeMrp();
  v.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Inversión Total Plan</div>
        <div class="kpi-val">${fmtUsd(mrp.totalInvUsd)}</div>
        <div class="kpi-sub">MP: ${fmtUsd(mrp.totalMpUsd)} · ME: ${fmtUsd(mrp.totalMeUsd)}</div>
      </div>
      <div class="kpi-card accent">
        <div class="kpi-label">Volumen Planificado</div>
        <div class="kpi-val">${fmt(mrp.totalCases, 0)} cj</div>
        <div class="kpi-sub">${STATE.skus.size} SKUs · ${STATE.materials.size} insumos</div>
      </div>
      <div class="kpi-card ${mrp.deficitCount ? "warn" : "ok"}">
        <div class="kpi-label">Insumos en Déficit</div>
        <div class="kpi-val">${mrp.deficitCount}</div>
        <div class="kpi-sub">${mrp.deficitCount ? "Stock final negativo tras consumo" : "Cobertura completa ✓"}</div>
      </div>
      <div class="kpi-card ${mrp.noCostCount ? "warn" : "ok"}">
        <div class="kpi-label">Insumos Sin Costo ($0)</div>
        <div class="kpi-val">${mrp.noCostCount}</div>
        <div class="kpi-sub">${mrp.noCostCount ? "Actualizar en pestaña Costos" : "Todos los activos valorizados ✓"}</div>
      </div>
    </div>
    <div class="charts-grid">
      <div class="panel-card">
        <h3>Inversión por Categoría (MP vs ME)</h3>
        <canvas id="ch_cat" height="210"></canvas>
      </div>
      <div class="panel-card">
        <h3>Flujo de Compras Semanal (S1 – S5)</h3>
        <canvas id="ch_sem" height="210"></canvas>
      </div>
    </div>
    <div class="panel-card">
      <h3>Top 10 Insumos por Inversión Requerida</h3>
      <div class="tablebox"><table class="mrp-table">
        <thead><tr><th>Código</th><th>Insumo</th><th>Tipo</th><th class="num">Consumo</th><th class="num">Stock</th><th class="num">Decisión</th><th class="num">Último Costo</th><th class="num">Inversión USD</th></tr></thead>
        <tbody>
          ${mrp.rows.filter(r => r.invUsd > 0).sort((a, b) => b.invUsd - a.invUsd).slice(0, 10).map(r => `
            <tr>
              <td><code>${esc(r.m.code)}</code></td>
              <td><strong>${esc(r.m.name)}</strong></td>
              <td><span class="badge ${r.m.type === "MP" ? "mp" : "me"}">${r.m.type}</span></td>
              <td class="num">${fmt(r.c.total)} ${esc(r.m.um)}</td>
              <td class="num">${fmt(r.stock)}</td>
              <td class="num"><strong>${fmt(r.decision)}</strong></td>
              <td class="num">${fmtUsd(r.cost)}</td>
              <td class="num"><strong>${fmtUsd(r.invUsd)}</strong></td>
            </tr>`).join("") || `<tr><td colspan="8" class="hint" style="text-align:center;padding:18px">Aún no hay decisiones de compra registradas para este plan.</td></tr>`}
        </tbody>
      </table></div>
    </div>`;

  const cats = [...mrp.catInv.keys()];
  STATE.charts.cat = new Chart($("#ch_cat"), {
    type: "bar",
    data: {
      labels: cats.length ? cats : ["Sin datos"],
      datasets: [
        { label: "Materia Prima (MP)", data: cats.length ? cats.map(c => mrp.catInv.get(c).mp) : [0], backgroundColor: "#011487" },
        { label: "Material Empaque (ME)", data: cats.length ? cats.map(c => mrp.catInv.get(c).me) : [0], backgroundColor: "#FFCB05" }
      ]
    },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true } } }
  });

  STATE.charts.sem = new Chart($("#ch_sem"), {
    type: "bar",
    data: {
      labels: ["Sem 01", "Sem 02", "Sem 03", "Sem 04", "Sem 05"],
      datasets: [{ label: "Inversión Semanal (USD)", data: mrp.weeklyUsd, backgroundColor: "#011487", borderRadius: 6 }]
    },
    options: { responsive: true }
  });
}

// -------------------- 2. PLAN DE PRODUCCIÓN (SIN PÉRDIDA DE FOCO) --------------------
function renderPlan(v) {
  const cats = [...new Set([...STATE.skus.values()].map(s => s.category))].sort();
  v.innerHTML = `
    <div class="bar">
      <input type="search" id="fp_q" placeholder="Buscar SKU o código…" value="${esc(STATE.fPlan.q)}">
      <select id="fp_cat"><option value="">Todas las categorías</option>${cats.map(c => `<option ${c === STATE.fPlan.cat ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <label class="toggle-lbl"><input type="checkbox" id="fp_qty" ${STATE.fPlan.onlyWithQty ? "checked" : ""}> Solo con cantidad en plan</label>
      <button id="btn_prorratear_all">Prorratear todo en 4 semanas</button>
    </div>
    <div class="tablebox"><table class="mrp-table">
      <thead><tr>
        <th>Código</th><th>Producto Terminado (SKU)</th><th>Categoría</th>
        <th class="num">Forecast</th><th class="num">Plan Mes (Cj)</th>
        <th class="num">Sem 1</th><th class="num">Sem 2</th><th class="num">Sem 3</th><th class="num">Sem 4</th><th class="num">Sem 5</th>
        <th>Check</th><th></th>
      </tr></thead>
      <tbody id="fp_body"></tbody>
    </table></div>`;

  const paintRows = () => {
    const q = STATE.fPlan.q.toLowerCase().trim();
    const list = [...STATE.skus.values()].filter(s => {
      if (STATE.fPlan.cat && s.category !== STATE.fPlan.cat) return false;
      if (q && !(s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q))) return false;
      if (STATE.fPlan.onlyWithQty) {
        const pi = getPlanItem(s.code);
        const totW = num(pi.w1) + num(pi.w2) + num(pi.w3) + num(pi.w4) + num(pi.w5);
        if (num(pi.plan_qty) <= 0 && totW <= 0) return false;
      }
      return true;
    });
    const tb = $("#fp_body");
    tb.innerHTML = list.map(s => {
      const pi = getPlanItem(s.code);
      const sumW = num(pi.w1) + num(pi.w2) + num(pi.w3) + num(pi.w4) + num(pi.w5);
      const ok = Math.abs(sumW - num(pi.plan_qty)) < 0.01;
      return `<tr data-sku="${esc(s.code)}">
        <td><code>${esc(s.code)}</code></td>
        <td><strong>${esc(s.name)}</strong><div class="hint">${fmt(s.net_weight_per_case, 2)} kg/cj · Lote ${fmt(s.batch_size_cases, 1)} cj</div></td>
        <td>${esc(s.category)}</td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-f="forecast" value="${num(pi.forecast)}"></td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-f="plan_qty" value="${num(pi.plan_qty)}" style="border-color:var(--brand)"></td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-f="w1" value="${num(pi.w1)}"></td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-f="w2" value="${num(pi.w2)}"></td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-f="w3" value="${num(pi.w3)}"></td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-f="w4" value="${num(pi.w4)}"></td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-f="w5" value="${num(pi.w5)}"></td>
        <td><span class="badge ${ok ? "ok" : "deficit"}">${ok ? "OK" : "REVISAR"}</span></td>
        <td><button class="btn-sm" data-pror="${esc(s.code)}" title="Dividir Plan Mes entre 4 semanas">÷4</button></td>
      </tr>`;
    }).join("") || `<tr><td colspan="12" class="hint" style="text-align:center;padding:20px">No hay SKUs que coincidan.</td></tr>`;

    tb.querySelectorAll("input[data-f]").forEach(inp => {
      inp.onchange = () => {
        const skuCode = inp.closest("tr").dataset.sku;
        const cur = { ...getPlanItem(skuCode), plan_id: STATE.activePlanId, sku_code: skuCode };
        cur[inp.dataset.f] = Math.max(0, num(inp.value));
        STATE.planItems.set(skuCode, cur);
        savePlanItem(cur);
        paintRows();
      };
    });

    tb.querySelectorAll("[data-pror]").forEach(btn => {
      btn.onclick = () => {
        const skuCode = btn.dataset.pror;
        const cur = { ...getPlanItem(skuCode), plan_id: STATE.activePlanId, sku_code: skuCode };
        const q4 = Math.round((num(cur.plan_qty) / 4) * 100) / 100;
        const rem = Math.round((num(cur.plan_qty) - q4 * 3) * 100) / 100;
        cur.w1 = q4; cur.w2 = q4; cur.w3 = q4; cur.w4 = Math.max(0, rem); cur.w5 = 0;
        STATE.planItems.set(skuCode, cur);
        savePlanItem(cur);
        paintRows();
      };
    });
  };

  paintRows();
  $("#fp_q").oninput = e => { STATE.fPlan.q = e.target.value; paintRows(); };
  $("#fp_cat").onchange = e => { STATE.fPlan.cat = e.target.value; paintRows(); };
  $("#fp_qty").onchange = e => { STATE.fPlan.onlyWithQty = e.target.checked; paintRows(); };

  $("#btn_prorratear_all").onclick = async () => {
    const updates = [];
    for (const [skuCode] of STATE.skus.entries()) {
      const cur = { ...getPlanItem(skuCode), plan_id: STATE.activePlanId, sku_code: skuCode };
      if (num(cur.plan_qty) <= 0) continue;
      const q4 = Math.round((num(cur.plan_qty) / 4) * 100) / 100;
      const rem = Math.round((num(cur.plan_qty) - q4 * 3) * 100) / 100;
      cur.w1 = q4; cur.w2 = q4; cur.w3 = q4; cur.w4 = Math.max(0, rem); cur.w5 = 0;
      STATE.planItems.set(skuCode, cur);
      updates.push({ plan_id: cur.plan_id, sku_code: cur.sku_code, forecast: num(cur.forecast), plan_qty: num(cur.plan_qty), w1: cur.w1, w2: cur.w2, w3: cur.w3, w4: cur.w4, w5: 0 });
    }
    if (!updates.length) return toast("No hay SKUs con Plan Mes > 0.");
    setSync("saving");
    try {
      await batchUpsert("mrp_plan_items", updates, "plan_id,sku_code");
      setSync("ok");
      toast(`Prorrateados ${updates.length} SKUs en 4 semanas.`);
      paintRows();
    } catch (e) { setSync("err"); toast(e.message, true); }
  };
}

function savePlanItem(it) {
  const payload = {
    plan_id: STATE.activePlanId, sku_code: it.sku_code,
    forecast: num(it.forecast), plan_qty: num(it.plan_qty),
    w1: num(it.w1), w2: num(it.w2), w3: num(it.w3), w4: num(it.w4), w5: num(it.w5)
  };
  debounceSave("pi_" + it.sku_code, async () => {
    const { error } = await sb.from("mrp_plan_items").upsert(payload, { onConflict: "plan_id,sku_code" });
    if (error) throw error;
  });
}

// -------------------- 3. ANÁLISIS MRP (SIN PÉRDIDA DE FOCO + REPORTES BONITOS) --------------------
function renderAnalisis(v) {
  v.innerHTML = `
    <div class="bar">
      <input type="search" id="fa_q" placeholder="Buscar insumo o código…" value="${esc(STATE.fAnalisis.q)}">
      <select id="fa_type">
        <option value="">MP y ME</option>
        <option value="MP" ${STATE.fAnalisis.type === "MP" ? "selected" : ""}>Solo MP</option>
        <option value="ME" ${STATE.fAnalisis.type === "ME" ? "selected" : ""}>Solo ME</option>
      </select>
      <label class="toggle-lbl"><input type="checkbox" id="fa_act" ${STATE.fAnalisis.onlyActive ? "checked" : ""}> Solo con consumo o déficit</label>
      <label class="toggle-lbl"><input type="checkbox" id="fa_adv" ${STATE.fAnalisis.showAdv ? "checked" : ""}> Mostrar columnas avanzadas</label>
      <button id="btn_copy_prop" class="primary" style="padding:8px 14px;font-size:.86rem">Aplicar Propuesta Sugerida</button>
      <button id="btn_rep_xlsx" style="padding:8px 12px;font-size:.86rem" title="Descargar solo este análisis MRP con diseño ejecutivo">Reporte Compra (Excel)</button>
      <button id="btn_rep_pdf" style="padding:8px 12px;font-size:.86rem" title="Descargar reporte de compra en PDF con membrete">Reporte Compra (PDF)</button>
    </div>
    <div id="fa_tblbox" class="tablebox ${STATE.fAnalisis.showAdv ? "show-adv" : ""}"><table class="mrp-table">
      <thead><tr>
        <th>Insumo</th>
        <th class="adv-col num">Lead (d)</th>
        <th class="adv-col num">MOQ</th>
        <th class="adv-col num">Red.</th>
        <th class="adv-col num">% SS</th>
        <th class="num">Stock Disp.</th>
        <th class="num">Consumo</th>
        <th class="adv-col num">Cob. Ini</th>
        <th class="num">Diferencia</th>
        <th class="num">Propuesta</th>
        <th class="num">Decisión Compra</th>
        <th class="adv-col">Proveedor</th>
        <th class="adv-col">N° O/C</th>
        <th class="adv-col num">Stock Final</th>
        <th class="adv-col num">Cob. Fin</th>
        <th class="num">Inversión USD</th>
        <th>Estado</th>
      </tr></thead>
      <tbody id="fa_body"></tbody>
    </table></div>
    <p id="fa_foot" class="hint" style="margin-top:8px"></p>`;

  const paintRows = () => {
    const mrp = computeMrp();
    const rows = getFilteredAnalisisRows(mrp);
    $("#fa_tblbox").classList.toggle("show-adv", STATE.fAnalisis.showAdv);
    const tb = $("#fa_body");
    tb.innerHTML = rows.map(r => {
      const badge = r.noCost
        ? `<span class="badge nocost">SIN COSTO</span>`
        : r.hasDeficit
          ? `<span class="badge deficit">DÉFICIT</span>`
          : `<span class="badge ok">OK</span>`;
      return `<tr data-mat="${esc(r.m.code)}">
        <td><strong>${esc(r.m.name)}</strong><button class="icon-edit" data-editmat="${esc(r.m.code)}" title="Editar insumo">✎</button><div class="hint"><code>${esc(r.m.code)}</code> · ${esc(r.m.um)} · <span class="badge ${r.m.type === "MP" ? "mp" : "me"}">${r.m.type}</span></div></td>
        <td class="adv-col num">${num(r.m.lead_time)}</td>
        <td class="adv-col num">${fmt(r.m.moq, 0)}</td>
        <td class="adv-col num">${fmt(r.m.rounding, 0)}</td>
        <td class="adv-col num">${fmt(num(r.m.safety_pct) * 100, 0)}%</td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-stock value="${r.stock}"></td>
        <td class="num">${fmt(r.c.total)}</td>
        <td class="adv-col num">${fmt(r.covInit * 100, 0)}%</td>
        <td class="num" style="color:${r.diff < 0 ? "var(--danger)" : "var(--ok)"};font-weight:700">${fmt(r.diff)}</td>
        <td class="num" style="font-weight:700;color:var(--brand)">${fmt(r.suggested)}</td>
        <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-dec value="${r.decision}" style="border-color:var(--brand)"></td>
        <td class="adv-col"><input class="cell-inp wide" type="text" list="dl_proveedores" placeholder="Seleccionar…" data-prov value="${esc(r.comp.provider || "")}"></td>
        <td class="adv-col"><input class="cell-inp" type="text" style="text-align:left;width:90px" placeholder="OC-" data-oc value="${esc(r.comp.oc || "")}"></td>
        <td class="adv-col num" style="color:${r.stockFinal < 0 ? "var(--danger)" : "inherit"}">${fmt(r.stockFinal)}</td>
        <td class="adv-col num">${fmt(r.covFinal * 100, 0)}%</td>
        <td class="num" title="Costo unitario: ${fmtUsd(r.cost)} (editar en pestaña Costos)"><strong>${fmtUsd(r.invUsd)}</strong></td>
        <td>${badge}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="17" class="hint" style="text-align:center;padding:22px">Sin insumos activos. Cargue cantidades en <strong>Plan de Producción</strong> o desactive el filtro.</td></tr>`;

    const viewInv = rows.reduce((acc, r) => acc + r.invUsd, 0);
    $("#fa_foot").innerHTML = `Mostrando <strong>${rows.length}</strong> insumos · Inversión en vista: <strong>${fmtUsd(viewInv)}</strong> (Total plan: <strong>${fmtUsd(mrp.totalInvUsd)}</strong>). Los costos unitarios se gestionan en <strong>Costos de Compra</strong>.`;

    tb.querySelectorAll("[data-editmat]").forEach(btn => {
      btn.onclick = () => openEditMaterialModal(btn.dataset.editmat, paintRows);
    });

    tb.querySelectorAll("input[data-stock]").forEach(inp => {
      inp.onchange = () => {
        const code = inp.closest("tr").dataset.mat;
        const m = STATE.materials.get(code);
        m.stock = Math.max(0, num(inp.value));
        debounceSave("st_" + code, async () => {
          const { error } = await sb.from("mrp_materiales").update({ stock: m.stock, updated_at: new Date().toISOString() }).eq("code", code);
          if (error) throw error;
        });
        paintRows();
      };
    });

    const onCompraEdit = (tr, field, val) => {
      const code = tr.dataset.mat;
      const cur = { ...getCompra(code), plan_id: STATE.activePlanId, mat_code: code };
      cur[field] = val;
      STATE.compras.set(code, cur);
      saveCompra(cur);
      if (field === "decision_qty") paintRows();
    };

    tb.querySelectorAll("input[data-dec]").forEach(inp => inp.onchange = () => onCompraEdit(inp.closest("tr"), "decision_qty", Math.max(0, num(inp.value))));
    tb.querySelectorAll("input[data-prov]").forEach(inp => inp.onchange = () => onCompraEdit(inp.closest("tr"), "provider", inp.value.trim()));
    tb.querySelectorAll("input[data-oc]").forEach(inp => inp.onchange = () => onCompraEdit(inp.closest("tr"), "oc", inp.value.trim()));
  };

  paintRows();
  $("#fa_q").oninput = e => { STATE.fAnalisis.q = e.target.value; paintRows(); };
  $("#fa_type").onchange = e => { STATE.fAnalisis.type = e.target.value; paintRows(); };
  $("#fa_act").onchange = e => { STATE.fAnalisis.onlyActive = e.target.checked; paintRows(); };
  $("#fa_adv").onchange = e => { STATE.fAnalisis.showAdv = e.target.checked; paintRows(); };

  $("#btn_copy_prop").onclick = async () => {
    const mrp = computeMrp();
    const rows = getFilteredAnalisisRows(mrp);
    const updates = [];
    for (const r of rows) {
      if (r.suggested <= 0) continue;
      const cur = { ...getCompra(r.m.code), plan_id: STATE.activePlanId, mat_code: r.m.code, decision_qty: r.suggested };
      STATE.compras.set(r.m.code, cur);
      updates.push({
        plan_id: STATE.activePlanId, mat_code: r.m.code, decision_qty: cur.decision_qty,
        provider: cur.provider || "", oc: cur.oc || "",
        w1: num(cur.w1), w2: num(cur.w2), w3: num(cur.w3), w4: num(cur.w4), w5: num(cur.w5)
      });
    }
    if (!updates.length) return toast("No hay propuestas > 0 para aplicar.");
    setSync("saving");
    try {
      await batchUpsert("mrp_compras", updates, "plan_id,mat_code");
      setSync("ok");
      toast(`Propuesta aplicada a ${updates.length} insumos.`);
      paintRows();
    } catch (e) { setSync("err"); toast(e.message, true); }
  };

  $("#btn_rep_xlsx").onclick = () => exportAnalisisReportExcel();
  $("#btn_rep_pdf").onclick = () => exportAnalisisReportPdf();
}

function saveCompra(c) {
  const payload = {
    plan_id: STATE.activePlanId, mat_code: c.mat_code,
    decision_qty: num(c.decision_qty), provider: c.provider || "", oc: c.oc || "",
    w1: num(c.w1), w2: num(c.w2), w3: num(c.w3), w4: num(c.w4), w5: num(c.w5),
    updated_at: new Date().toISOString()
  };
  debounceSave("cmp_" + c.mat_code, async () => {
    const { error } = await sb.from("mrp_compras").upsert(payload, { onConflict: "plan_id,mat_code" });
    if (error) throw error;
  });
}

// -------------------- REPORTES BONITOS DE ANÁLISIS MRP (EXCEL Y PDF) --------------------
async function exportAnalisisReportExcel() {
  const mrp = computeMrp();
  const rows = getFilteredAnalisisRows(mrp);
  if (!rows.length) return toast("No hay insumos en la vista actual para exportar.", true);
  if (typeof ExcelJS === "undefined") return toast("ExcelJS no cargó. Recargue la página.", true);

  const btn = $("#btn_rep_xlsx");
  btn.disabled = true; btn.textContent = "Generando…";
  try {
    const planName = STATE.planes.find(p => p.id === STATE.activePlanId)?.name || "Planificación MRP";
    const showAdv = STATE.fAnalisis.showAdv;
    const wb = new ExcelJS.Workbook();
    wb.creator = window.CFG.EMPRESA || "Alimentos Mida";
    wb.created = new Date();

    const ws = wb.addWorksheet("Planificación de Compra", { views: [{ state: "frozen", ySplit: 6 }] });

    const cols = showAdv ? [
      { header: "Código", key: "code", width: 13 },
      { header: "Insumo", key: "name", width: 34 },
      { header: "UM", key: "um", width: 8 },
      { header: "Tipo", key: "type", width: 8 },
      { header: "Lead (d)", key: "lt", width: 10 },
      { header: "MOQ", key: "moq", width: 11 },
      { header: "Red.", key: "red", width: 9 },
      { header: "% SS", key: "ss", width: 9 },
      { header: "Stock Disp.", key: "stock", width: 14 },
      { header: "Consumo", key: "cons", width: 14 },
      { header: "Cob. Ini", key: "cobi", width: 11 },
      { header: "Diferencia", key: "diff", width: 14 },
      { header: "Decisión Compra", key: "dec", width: 16 },
      { header: "Proveedor", key: "prov", width: 24 },
      { header: "N° O/C", key: "oc", width: 13 },
      { header: "Stock Final", key: "sfin", width: 14 },
      { header: "Cob. Fin", key: "cobf", width: 11 },
      { header: "Costo Unit.", key: "cost", width: 13 },
      { header: "Inversión USD", key: "inv", width: 16 },
      { header: "Estado", key: "est", width: 13 }
    ] : [
      { header: "Código", key: "code", width: 13 },
      { header: "Insumo", key: "name", width: 36 },
      { header: "UM", key: "um", width: 8 },
      { header: "Tipo", key: "type", width: 8 },
      { header: "Stock Disp.", key: "stock", width: 14 },
      { header: "Consumo", key: "cons", width: 14 },
      { header: "Diferencia", key: "diff", width: 14 },
      { header: "Decisión Compra", key: "dec", width: 16 },
      { header: "Costo Unit.", key: "cost", width: 13 },
      { header: "Inversión USD", key: "inv", width: 16 },
      { header: "Estado", key: "est", width: 13 }
    ];

    ws.columns = cols.map(c => ({ key: c.key, width: c.width }));
    const colCount = cols.length;
    const lastColLetter = ws.getColumn(colCount).letter;

    // Row 1: Corporate Banner
    ws.mergeCells(`A1:${lastColLetter}1`);
    const r1 = ws.getRow(1);
    r1.height = 30;
    r1.getCell(1).value = `${(window.CFG.EMPRESA || "ALIMENTOS MIDA").toUpperCase()} · REPORTE DE PLANIFICACIÓN DE COMPRA (MRP)`;
    r1.getCell(1).font = { name: "Calibri", size: 15, bold: true, color: { argb: "FFFFFFFF" } };
    r1.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF011487" } };
    r1.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };

    // Row 2: Subtitle with yellow bottom accent
    ws.mergeCells(`A2:${lastColLetter}2`);
    const r2 = ws.getRow(2);
    r2.height = 20;
    const filtros = [
      STATE.fAnalisis.type ? `Tipo: ${STATE.fAnalisis.type}` : "MP y ME",
      STATE.fAnalisis.onlyActive ? "Solo con consumo/déficit" : "Todos los insumos",
      showAdv ? "Vista Completa" : "Vista Esencial"
    ].join("  |  ");
    r2.getCell(1).value = `Plan: ${planName}   ·   Fecha: ${new Date().toLocaleDateString("es-VE")}   ·   ${filtros}`;
    r2.getCell(1).font = { name: "Calibri", size: 10, italic: true, color: { argb: "FFE8ECFF" } };
    r2.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000E5E" } };
    r2.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    r2.getCell(1).border = { bottom: { style: "thick", color: { argb: "FFFFCB05" } } };

    // Row 3-4: KPI Summary Strip
    const totInv = rows.reduce((s, r) => s + r.invUsd, 0);
    const totMp = rows.filter(r => r.m.type === "MP").reduce((s, r) => s + r.invUsd, 0);
    const totMe = rows.filter(r => r.m.type === "ME").reduce((s, r) => s + r.invUsd, 0);
    const defCnt = rows.filter(r => r.hasDeficit).length;

    ws.getRow(3).height = 8;
    ws.mergeCells(`A4:${lastColLetter}4`);
    const r4 = ws.getRow(4);
    r4.height = 24;
    r4.getCell(1).value = `RESUMEN:   Inversión Total: ${fmtUsd(totInv)}   |   Materia Prima (MP): ${fmtUsd(totMp)}   |   Material Empaque (ME): ${fmtUsd(totMe)}   |   Insumos: ${rows.length}   |   En Déficit: ${defCnt}`;
    r4.getCell(1).font = { name: "Calibri", size: 10.5, bold: true, color: { argb: "FF011487" } };
    r4.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1FA" } };
    r4.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    r4.getCell(1).border = {
      top: { style: "thin", color: { argb: "FFD3D9EE" } },
      bottom: { style: "thin", color: { argb: "FFD3D9EE" } }
    };
    ws.getRow(5).height = 8;

    // Row 6: Table Header
    const hRow = ws.getRow(6);
    hRow.height = 26;
    cols.forEach((c, idx) => {
      const cell = hRow.getCell(idx + 1);
      cell.value = c.header;
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF011487" } };
      cell.alignment = { vertical: "middle", horizontal: ["code", "name", "um", "type", "prov", "oc", "est"].includes(c.key) ? "left" : "right", wrapText: true };
      cell.border = { bottom: { style: "medium", color: { argb: "FFFFCB05" } } };
    });

    // Data rows starting at Row 7
    rows.forEach((r, idx) => {
      const estado = r.noCost ? "SIN COSTO" : r.hasDeficit ? "DÉFICIT" : "OK";
      const obj = {
        code: r.m.code, name: r.m.name, um: r.m.um, type: r.m.type,
        lt: num(r.m.lead_time), moq: num(r.m.moq), red: num(r.m.rounding), ss: num(r.m.safety_pct),
        stock: r.stock, cons: r.c.total, cobi: r.covInit, diff: r.diff,
        prop: r.suggested, dec: r.decision, prov: r.comp.provider || "", oc: r.comp.oc || "",
        sfin: r.stockFinal, cobf: r.covFinal, cost: r.cost, inv: r.invUsd, est: estado
      };
      const row = ws.addRow(obj);
      row.height = 20;
      const isZebra = idx % 2 === 1;
      row.eachCell((cell, colNumber) => {
        const key = cols[colNumber - 1].key;
        cell.font = { name: "Calibri", size: 10, color: { argb: "FF0B1033" } };
        if (isZebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F9FD" } };
        cell.border = { bottom: { style: "hair", color: { argb: "FFD3D9EE" } } };
        cell.alignment = { vertical: "middle", horizontal: ["code", "name", "um", "type", "prov", "oc", "est"].includes(key) ? "left" : "right" };

        if (["stock", "cons", "diff", "prop", "dec", "sfin", "moq", "red"].includes(key)) cell.numFmt = "#,##0.00";
        if (["cost", "inv"].includes(key)) cell.numFmt = "$#,##0.00";
        if (["ss", "cobi", "cobf"].includes(key)) cell.numFmt = "0%";
        if (key === "dec" || key === "inv") cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF011487" } };
        if (key === "diff") {
          cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: r.diff < 0 ? "FFB3261E" : "FF157A43" } };
        }
        if (key === "est") {
          cell.alignment = { vertical: "middle", horizontal: "center" };
          if (estado === "DÉFICIT") {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDECEC" } };
            cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: "FFB3261E" } };
          } else if (estado === "SIN COSTO") {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4CC" } };
            cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: "FF011487" } };
          } else {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7F6ED" } };
            cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: "FF157A43" } };
          }
        }
      });
    });

    // Totals Row
    const lastDataRow = 6 + rows.length;
    const totRow = ws.addRow({});
    totRow.height = 25;
    totRow.getCell(2).value = `TOTAL GENERAL (${rows.length} insumos)`;
    const invColIdx = cols.findIndex(c => c.key === "inv") + 1;
    const invLetter = ws.getColumn(invColIdx).letter;
    totRow.getCell(invColIdx).value = { formula: `SUM(${invLetter}7:${invLetter}${lastDataRow})`, result: Number(totInv.toFixed(2)) };
    totRow.getCell(invColIdx).numFmt = "$#,##0.00";

    for (let c = 1; c <= colCount; c++) {
      const cell = totRow.getCell(c);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF011487" } };
      cell.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: c === invColIdx ? "FFFFCB05" : "FFFFFFFF" } };
      cell.alignment = { vertical: "middle", horizontal: c === invColIdx ? "right" : "left" };
      cell.border = { top: { style: "medium", color: { argb: "FFFFCB05" } } };
    }

    ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: colCount } };

    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    a.download = `Reporte-Compra-MRP-${planName.replace(/[^a-zA-Z0-9_-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    toast("Reporte de Compra (Excel) descargado.");
  } catch (err) {
    console.error(err);
    toast("Error generando Excel: " + (err.message || err), true);
  } finally {
    btn.disabled = false; btn.textContent = "Reporte Compra (Excel)";
  }
}

let MRP_LOGO_CACHE = null;
async function getLogoBase64() {
  if (MRP_LOGO_CACHE !== null) return MRP_LOGO_CACHE;
  try {
    const b = await (await fetch("logo.png")).blob();
    MRP_LOGO_CACHE = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  } catch { MRP_LOGO_CACHE = ""; }
  return MRP_LOGO_CACHE;
}

async function exportAnalisisReportPdf() {
  const mrp = computeMrp();
  const rows = getFilteredAnalisisRows(mrp);
  if (!rows.length) return toast("No hay insumos en la vista actual para exportar.", true);
  if (!window.jspdf) return toast("jsPDF no cargó. Recargue la página.", true);

  const btn = $("#btn_rep_pdf");
  btn.disabled = true; btn.textContent = "Generando…";
  try {
    const planName = STATE.planes.find(p => p.id === STATE.activePlanId)?.name || "Planificación MRP";
    const showAdv = STATE.fAnalisis.showAdv;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const NAVY = [1, 20, 135], YEL = [255, 203, 5], SOFT = [238, 241, 250];
    const logo = await getLogoBase64();

    // Header Banner
    doc.setFillColor(...NAVY); doc.rect(0, 0, W, 74, "F");
    doc.setFillColor(...YEL); doc.rect(0, 74, W, 5, "F");
    if (logo) doc.addImage(logo, "PNG", 28, 9, 56, 56);
    doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(17);
    doc.text("Reporte de Planificación de Compra (MRP)", 96, 35);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
    const filtros = [STATE.fAnalisis.type || "MP y ME", STATE.fAnalisis.onlyActive ? "Solo activos" : "Todos", showAdv ? "Vista Completa" : "Vista Esencial"].join(" · ");
    doc.text(`Plan: ${planName}  ·  Fecha: ${new Date().toLocaleDateString("es-VE")}  ·  ${filtros}`, 96, 54);

    // KPI Summary Strip
    const totInv = rows.reduce((s, r) => s + r.invUsd, 0);
    const totMp = rows.filter(r => r.m.type === "MP").reduce((s, r) => s + r.invUsd, 0);
    const totMe = rows.filter(r => r.m.type === "ME").reduce((s, r) => s + r.invUsd, 0);
    const defCnt = rows.filter(r => r.hasDeficit).length;

    doc.setFillColor(...SOFT); doc.roundedRect(28, 88, W - 56, 26, 4, 4, "F");
    doc.setTextColor(...NAVY); doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
    doc.text(`Inversión Total: ${fmtUsd(totInv)}   |   MP: ${fmtUsd(totMp)}   |   ME: ${fmtUsd(totMe)}   |   Insumos: ${rows.length}   |   Déficit: ${defCnt}`, 38, 105);

    const head = showAdv
      ? [["Código", "Insumo", "UM", "Tipo", "Stock", "Consumo", "Dif.", "Decisión", "Proveedor", "O/C", "Stock Fin", "Inversión", "Estado"]]
      : [["Código", "Insumo", "UM", "Tipo", "Stock Disp.", "Consumo", "Diferencia", "Decisión", "Costo Unit.", "Inversión USD", "Estado"]];

    const body = rows.map(r => {
      const est = r.noCost ? "SIN COSTO" : r.hasDeficit ? "DÉFICIT" : "OK";
      return showAdv
        ? [r.m.code, r.m.name, r.m.um, r.m.type, fmt(r.stock), fmt(r.c.total), fmt(r.diff), fmt(r.decision), r.comp.provider || "—", r.comp.oc || "—", fmt(r.stockFinal), fmtUsd(r.invUsd), est]
        : [r.m.code, r.m.name, r.m.um, r.m.type, fmt(r.stock), fmt(r.c.total), fmt(r.diff), fmt(r.decision), fmtUsd(r.cost), fmtUsd(r.invUsd), est];
    });

    const totalRow = showAdv
      ? ["", `TOTAL GENERAL (${rows.length} insumos)`, "", "", "", "", "", "", "", "", "", fmtUsd(totInv), ""]
      : ["", `TOTAL GENERAL (${rows.length} insumos)`, "", "", "", "", "", "", "", fmtUsd(totInv), ""];
    body.push(totalRow);

    doc.autoTable({
      startY: 122,
      margin: { left: 28, right: 28, bottom: 34 },
      head,
      body,
      styles: { fontSize: showAdv ? 7.2 : 8.2, cellPadding: 4.5, overflow: "linebreak", valign: "middle" },
      headStyles: { fillColor: NAVY, textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [247, 249, 253] },
      didParseCell: data => {
        if (data.section === "body" && data.row.index === body.length - 1) {
          data.cell.styles.fillColor = NAVY;
          data.cell.styles.textColor = 255;
          data.cell.styles.fontStyle = "bold";
        }
        if (data.section === "body" && data.row.index < body.length - 1) {
          const val = String(data.cell.raw || "");
          if (val === "DÉFICIT") { data.cell.styles.textColor = [179, 38, 30]; data.cell.styles.fontStyle = "bold"; }
          else if (val === "OK") { data.cell.styles.textColor = [21, 122, 67]; data.cell.styles.fontStyle = "bold"; }
          else if (val === "SIN COSTO") { data.cell.styles.textColor = [150, 95, 0]; data.cell.styles.fontStyle = "bold"; }
        }
      }
    });

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8); doc.setTextColor(110);
      doc.text(`${window.CFG.EMPRESA || "Alimentos Mida"} · Departamento de Compras · Reporte MRP`, 28, H - 16);
      doc.text(`Página ${i} de ${pages}`, W - 28, H - 16, { align: "right" });
    }

    doc.save(`Reporte-Compra-MRP-${planName.replace(/[^a-zA-Z0-9_-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.pdf`);
    toast("Reporte de Compra (PDF) descargado.");
  } catch (err) {
    console.error(err);
    toast("Error generando PDF: " + (err.message || err), true);
  } finally {
    btn.disabled = false; btn.textContent = "Reporte Compra (PDF)";
  }
}

// -------------------- 4. PROCURA SEMANAL (SIN PÉRDIDA DE FOCO) --------------------
function renderProcura(v) {
  v.innerHTML = `
    <div id="fpr_kpis" class="kpi-grid"></div>
    <div class="bar">
      <input type="search" id="fpr_q" placeholder="Buscar insumo…" value="${esc(STATE.fProcura.q)}">
      <label class="toggle-lbl"><input type="checkbox" id="fpr_act" ${STATE.fProcura.onlyActive ? "checked" : ""}> Solo insumos con compra o consumo</label>
      <button id="btn_autodist" class="primary" style="padding:8px 14px;font-size:.86rem">Autodistribuir según Consumo</button>
    </div>
    <div class="tablebox"><table class="mrp-table">
      <thead><tr>
        <th>Insumo</th><th class="num">Decisión Mes</th>
        <th class="num">Sem 1</th><th class="num">Sem 2</th><th class="num">Sem 3</th><th class="num">Sem 4</th><th class="num">Sem 5</th>
        <th>Check</th>
      </tr></thead>
      <tbody id="fpr_body"></tbody>
    </table></div>`;

  const paintRows = () => {
    const mrp = computeMrp();
    $("#fpr_kpis").innerHTML = [0, 1, 2, 3, 4].map(i => `<div class="kpi-card"><div class="kpi-label">Inversión Sem 0${i + 1}</div><div class="kpi-val">${fmtUsd(mrp.weeklyUsd[i])}</div></div>`).join("");
    const q = STATE.fProcura.q.toLowerCase().trim();
    const rows = mrp.rows.filter(r =>
      (!STATE.fProcura.onlyActive || r.decision > 0 || r.c.total > 0) &&
      (!q || r.m.code.toLowerCase().includes(q) || r.m.name.toLowerCase().includes(q))
    );
    const tb = $("#fpr_body");
    tb.innerHTML = rows.map(r => {
      const sumW = num(r.comp.w1) + num(r.comp.w2) + num(r.comp.w3) + num(r.comp.w4) + num(r.comp.w5);
      const ok = Math.abs(sumW - r.decision) < 0.05;
      return `<tr data-mat="${esc(r.m.code)}">
        <td><strong>${esc(r.m.name)}</strong><div class="hint"><code>${esc(r.m.code)}</code> · ${esc(r.m.um)}</div></td>
        <td class="num"><strong>${fmt(r.decision)}</strong></td>
        ${["w1", "w2", "w3", "w4", "w5"].map(wk => `
          <td class="num">
            <input class="cell-inp" type="number" step="any" min="0" data-wk="${wk}" value="${num(r.comp[wk])}">
            <div class="hint">Cons: ${fmt(r.c[wk], 1)}</div>
          </td>`).join("")}
        <td><span class="badge ${ok ? "ok" : "deficit"}">${ok ? "OK" : "REVISAR"}</span></td>
      </tr>`;
    }).join("") || `<tr><td colspan="8" class="hint" style="text-align:center;padding:20px">No hay insumos activos en Procura Semanal.</td></tr>`;

    tb.querySelectorAll("input[data-wk]").forEach(inp => {
      inp.onchange = () => {
        const code = inp.closest("tr").dataset.mat;
        const cur = { ...getCompra(code), plan_id: STATE.activePlanId, mat_code: code };
        cur[inp.dataset.wk] = Math.max(0, num(inp.value));
        STATE.compras.set(code, cur);
        saveCompra(cur);
        paintRows();
      };
    });
  };

  paintRows();
  $("#fpr_q").oninput = e => { STATE.fProcura.q = e.target.value; paintRows(); };
  $("#fpr_act").onchange = e => { STATE.fProcura.onlyActive = e.target.checked; paintRows(); };

  $("#btn_autodist").onclick = async () => {
    const mrp = computeMrp();
    const q = STATE.fProcura.q.toLowerCase().trim();
    const rows = mrp.rows.filter(r =>
      (!STATE.fProcura.onlyActive || r.decision > 0 || r.c.total > 0) &&
      (!q || r.m.code.toLowerCase().includes(q) || r.m.name.toLowerCase().includes(q))
    );
    const updates = [];
    for (const r of rows) {
      if (r.decision <= 0) continue;
      const cur = { ...getCompra(r.m.code), plan_id: STATE.activePlanId, mat_code: r.m.code };
      const totW = r.c.w1 + r.c.w2 + r.c.w3 + r.c.w4 + r.c.w5;
      if (totW > 0) {
        cur.w1 = Math.round((r.decision * (r.c.w1 / totW)) * 100) / 100;
        cur.w2 = Math.round((r.decision * (r.c.w2 / totW)) * 100) / 100;
        cur.w3 = Math.round((r.decision * (r.c.w3 / totW)) * 100) / 100;
        cur.w4 = Math.round((r.decision * (r.c.w4 / totW)) * 100) / 100;
        cur.w5 = Math.max(0, Math.round((r.decision - cur.w1 - cur.w2 - cur.w3 - cur.w4) * 100) / 100);
      } else {
        const q4 = Math.round((r.decision / 4) * 100) / 100;
        cur.w1 = q4; cur.w2 = q4; cur.w3 = q4; cur.w4 = Math.max(0, Math.round((r.decision - q4 * 3) * 100) / 100); cur.w5 = 0;
      }
      STATE.compras.set(r.m.code, cur);
      updates.push({
        plan_id: STATE.activePlanId, mat_code: r.m.code, decision_qty: cur.decision_qty,
        provider: cur.provider || "", oc: cur.oc || "",
        w1: cur.w1, w2: cur.w2, w3: cur.w3, w4: cur.w4, w5: cur.w5
      });
    }
    if (!updates.length) return toast("No hay compras > 0 para distribuir.");
    setSync("saving");
    try {
      await batchUpsert("mrp_compras", updates, "plan_id,mat_code");
      setSync("ok");
      toast(`Distribuidas ${updates.length} compras semanalmente.`);
      paintRows();
    } catch (e) { setSync("err"); toast(e.message, true); }
  };
}

// -------------------- 5. CATÁLOGO E INVENTARIO (SIN PÉRDIDA DE FOCO + EDITAR INSUMOS) --------------------
function renderCatalogo(v) {
  v.innerHTML = `
    <div class="bar">
      <input type="search" id="fc_q" placeholder="Buscar insumo o código…" value="${esc(STATE.fCatalogo.q)}">
      <select id="fc_type">
        <option value="">MP y ME</option>
        <option value="MP" ${STATE.fCatalogo.type === "MP" ? "selected" : ""}>Materia Prima (MP)</option>
        <option value="ME" ${STATE.fCatalogo.type === "ME" ? "selected" : ""}>Material Empaque (ME)</option>
      </select>
      <button id="btn_new_mat" class="primary" style="padding:8px 14px;font-size:.86rem">+ Nuevo Insumo</button>
      <button id="btn_bulk_mat" style="padding:8px 14px;font-size:.86rem">Carga Masiva (Excel / CSV)</button>
    </div>
    <div class="tablebox"><table class="mrp-table">
      <thead><tr>
        <th>Código</th><th>Descripción</th><th>UM</th><th>Tipo</th>
        <th class="num">Stock Disponible</th><th class="num">Lead (días)</th><th class="num">MOQ</th><th class="num">Redondeo</th><th class="num">% Stock Seg.</th>
        <th>Acciones</th>
      </tr></thead>
      <tbody id="fc_body"></tbody>
    </table></div>`;

  const paintRows = () => {
    const q = STATE.fCatalogo.q.toLowerCase().trim();
    const list = [...STATE.materials.values()].filter(m =>
      (!STATE.fCatalogo.type || m.type === STATE.fCatalogo.type) &&
      (!q || m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    );
    const tb = $("#fc_body");
    tb.innerHTML = list.map(m => `<tr data-mat="${esc(m.code)}">
      <td><code>${esc(m.code)}</code></td>
      <td><strong>${esc(m.name)}</strong></td>
      <td>${esc(m.um)}</td>
      <td><span class="badge ${m.type === "MP" ? "mp" : "me"}">${m.type}</span></td>
      <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-mf="stock" value="${num(m.stock)}"></td>
      <td class="num"><input class="cell-inp" type="number" step="1" min="0" data-mf="lead_time" value="${num(m.lead_time)}"></td>
      <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-mf="moq" value="${num(m.moq)}"></td>
      <td class="num"><input class="cell-inp" type="number" step="any" min="0.01" data-mf="rounding" value="${num(m.rounding)}"></td>
      <td class="num"><input class="cell-inp" type="number" step="1" min="0" data-mf="safety_pct" value="${Math.round(num(m.safety_pct) * 100)}"></td>
      <td style="white-space:nowrap">
        <button class="btn-sm" data-editmat="${esc(m.code)}">Editar</button>
        <button class="btn-sm btn-danger" data-delmat="${esc(m.code)}">Eliminar</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="10" class="hint" style="text-align:center;padding:20px">Sin insumos registrados.</td></tr>`;

    tb.querySelectorAll("input[data-mf]").forEach(inp => {
      inp.onchange = () => {
        const code = inp.closest("tr").dataset.mat;
        const m = STATE.materials.get(code);
        const f = inp.dataset.mf;
        m[f] = f === "safety_pct" ? Math.max(0, num(inp.value) / 100) : Math.max(0, num(inp.value));
        debounceSave("mat_" + code, async () => {
          const { error } = await sb.from("mrp_materiales").update({ [f]: m[f], updated_at: new Date().toISOString() }).eq("code", code);
          if (error) throw error;
        });
      };
    });

    tb.querySelectorAll("[data-editmat]").forEach(btn => {
      btn.onclick = () => openEditMaterialModal(btn.dataset.editmat, paintRows);
    });

    tb.querySelectorAll("[data-delmat]").forEach(btn => {
      btn.onclick = async () => {
        const code = btn.dataset.delmat;
        const usedIn = [];
        for (const [skuCode, items] of STATE.bom.entries()) {
          if (items.some(i => i.mat_code === code)) usedIn.push(skuCode);
        }
        if (usedIn.length) {
          return toast(`No se puede eliminar: usado en ${usedIn.length} fórmula(s) (${usedIn.slice(0, 3).join(", ")}).`, true);
        }
        if (!confirm(`¿Eliminar el insumo ${code} de Supabase?`)) return;
        const { error } = await sb.from("mrp_materiales").delete().eq("code", code);
        if (error) return toast("Error al eliminar: " + error.message, true);
        STATE.materials.delete(code);
        STATE.compras.delete(code);
        toast("Insumo eliminado.");
        paintRows();
      };
    });
  };

  paintRows();
  $("#fc_q").oninput = e => { STATE.fCatalogo.q = e.target.value; paintRows(); };
  $("#fc_type").onchange = e => { STATE.fCatalogo.type = e.target.value; paintRows(); };
  $("#btn_new_mat").onclick = () => openNewMaterialModal(paintRows);
  $("#btn_bulk_mat").onclick = () => openBulkMaterialModal(paintRows);
}

function openNewMaterialModal(onCreated) {
  const d = $("#dlg");
  d.innerHTML = `<form id="mf_new" autocomplete="off">
    <h2>Nuevo Insumo (MP / ME)</h2>
    <p class="hint" style="margin:0 0 12px">El costo unitario se asigna después en la pestaña <strong>Costos de Compra</strong>.</p>
    <div class="row">
      <label>Código *<input type="text" name="code" required placeholder="Ej. 105099"></label>
      <label>Tipo *<select name="type"><option value="MP">Materia Prima (MP)</option><option value="ME">Material Empaque (ME)</option></select></label>
    </div>
    <label>Descripción *<input type="text" name="name" required placeholder="Nombre del insumo"></label>
    <div class="row">
      <label>Unidad de Medida<input type="text" name="um" value="Kg"></label>
      <label>Stock Disponible<input type="number" step="any" min="0" name="stock" value="0"></label>
    </div>
    <div class="row">
      <label>Lead Time (días)<input type="number" step="1" min="0" name="lead_time" value="3"></label>
      <label>Compra Mínima (MOQ)<input type="number" step="any" min="0" name="moq" value="1"></label>
    </div>
    <div class="row">
      <label>Redondeo<input type="number" step="any" min="0.01" name="rounding" value="1"></label>
      <label>% Stock Seguridad<input type="number" step="1" min="0" name="safety_pct" value="20"></label>
    </div>
    <div class="err" id="m_err"></div>
    <div class="bar"><button class="primary" type="submit">Guardar Insumo</button><button type="button" id="m_cls">Cancelar</button></div>
  </form>`;
  d.showModal();
  $("#m_cls").onclick = () => d.close();
  $("#mf_new").onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const code = f.code.value.trim();
    const name = f.name.value.trim();
    if (!code || !name) return $("#m_err").textContent = "Complete código y descripción.";
    if (STATE.materials.has(code)) return $("#m_err").textContent = "Ese código ya existe.";
    const rec = {
      code, name, um: f.um.value.trim() || "Kg", type: f.type.value,
      stock: num(f.stock.value), lead_time: num(f.lead_time.value),
      moq: num(f.moq.value), rounding: num(f.rounding.value) || 1,
      safety_pct: num(f.safety_pct.value) / 100, cost: 0, prev_cost: 0
    };
    const { error } = await sb.from("mrp_materiales").insert(rec);
    if (error) return $("#m_err").textContent = error.message;
    STATE.materials.set(code, rec);
    d.close();
    toast("Insumo creado en Supabase.");
    if (onCreated) onCreated(code); else renderView();
  };
}

function openEditMaterialModal(code, onSaved) {
  const m = STATE.materials.get(code);
  if (!m) return;
  let usedCount = 0;
  for (const items of STATE.bom.values()) {
    if (items.some(i => i.mat_code === code)) usedCount++;
  }
  const d = $("#dlg");
  d.innerHTML = `<form id="mf_edit" autocomplete="off">
    <h2>Editar Insumo</h2>
    <p class="hint" style="margin:0 0 12px">Usado en <strong>${usedCount}</strong> fórmula(s). Los cambios se reflejan en todo el sistema y se guardan en Supabase. El costo unitario se edita en <strong>Costos de Compra</strong>.</p>
    <div class="row">
      <label>Código (fijo)<input type="text" value="${esc(m.code)}" disabled></label>
      <label>Tipo *<select name="type">
        <option value="MP" ${m.type === "MP" ? "selected" : ""}>Materia Prima (MP)</option>
        <option value="ME" ${m.type === "ME" ? "selected" : ""}>Material Empaque (ME)</option>
      </select></label>
    </div>
    <label>Descripción *<input type="text" name="name" required value="${esc(m.name)}"></label>
    <div class="row">
      <label>Unidad de Medida *<input type="text" name="um" required value="${esc(m.um)}"></label>
      <label>Stock Disponible<input type="number" step="any" min="0" name="stock" value="${num(m.stock)}"></label>
    </div>
    <div class="row">
      <label>Lead Time (días)<input type="number" step="1" min="0" name="lead_time" value="${num(m.lead_time)}"></label>
      <label>Compra Mínima (MOQ)<input type="number" step="any" min="0" name="moq" value="${num(m.moq)}"></label>
    </div>
    <div class="row">
      <label>Redondeo<input type="number" step="any" min="0.01" name="rounding" value="${num(m.rounding) || 1}"></label>
      <label>% Stock Seguridad<input type="number" step="1" min="0" name="safety_pct" value="${Math.round(num(m.safety_pct) * 100)}"></label>
    </div>
    <div class="err" id="me_err"></div>
    <div class="bar"><button class="primary" type="submit" id="me_save">Guardar Cambios</button><button type="button" id="me_cls">Cancelar</button></div>
  </form>`;
  d.showModal();
  $("#me_cls").onclick = () => d.close();
  $("#mf_edit").onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    const um = f.um.value.trim() || "Kg";
    if (!name) return $("#me_err").textContent = "La descripción es obligatoria.";
    const btn = $("#me_save");
    btn.disabled = true; btn.textContent = "Guardando…";
    const updates = {
      name,
      um,
      type: f.type.value,
      stock: Math.max(0, num(f.stock.value)),
      lead_time: Math.max(0, num(f.lead_time.value)),
      moq: Math.max(0, num(f.moq.value)),
      rounding: Math.max(0.01, num(f.rounding.value) || 1),
      safety_pct: Math.max(0, num(f.safety_pct.value) / 100),
      updated_at: new Date().toISOString()
    };
    const { error } = await sb.from("mrp_materiales").update(updates).eq("code", code);
    if (error) {
      $("#me_err").textContent = error.message;
      btn.disabled = false; btn.textContent = "Guardar Cambios";
      return;
    }
    Object.assign(m, updates);
    d.close();
    toast(`Insumo "${name}" actualizado.`);
    if (onSaved) onSaved(); else renderView();
  };
}

// -------------------- 5B. CARGA MASIVA DE INSUMOS CON VALIDADOR DE CONFLICTOS --------------------
function normText(t) {
  return String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function downloadBulkMaterialTemplate() {
  const wb = XLSX.utils.book_new();
  const sample = [
    {
      Codigo: "105099",
      Descripcion: "EJEMPLO INSUMO NUEVO",
      UM: "Kg",
      Tipo: "MP",
      Stock_Disponible: 150,
      Lead_Time: 3,
      MOQ: 25,
      Redondeo: 5,
      Stock_Seguridad_Pct: 20
    },
    {
      Codigo: "105009",
      Descripcion: "AZUCAR",
      UM: "Kg",
      Tipo: "MP",
      Stock_Disponible: 500,
      Lead_Time: "",
      MOQ: "",
      Redondeo: "",
      Stock_Seguridad_Pct: ""
    }
  ];
  const ws = XLSX.utils.json_to_sheet(sample);
  ws["!cols"] = [{ wch: 14 }, { wch: 32 }, { wch: 10 }, { wch: 8 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 11 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws, "Carga_Insumos");
  XLSX.writeFile(wb, "Plantilla-Carga-Masiva-Insumos.xlsx");
  toast("Plantilla descargada. Los campos vacíos en insumos existentes conservan su valor actual.");
}

function parseBulkMaterialWorkbook(wb) {
  // Prioriza hojas con nombre de inventario/insumos o usa la primera hoja
  const preferred = wb.SheetNames.find(n => /carga|insumo|inventario|catalogo|analisis|material/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[preferred], { header: 1, defval: null });
  if (!rows.length) return { sheetName: preferred, parsed: [], invalid: 0 };

  // Detectar fila de encabezados buscando columnas típicas en las primeras 12 filas
  let headerRowIdx = -1;
  let colMap = {};
  const matchers = {
    code: /^(codigo|cod|code|cod\.|id|sku|articulo|art)$/,
    name: /^(descripcion|nombre|insumo|producto|material|detalle|description|name)$/,
    um: /^(um|u\.m\.|unidad|unidad de medida|und|medida)$/,
    type: /^(tipo|clase|categoria|mp\/me|type)$/,
    stock: /^(stock|stock disponible|inventario|inventario disponible|disponible|cantidad|existencia|saldo)$/,
    lead_time: /^(lead time|lead time dias|lead|tiempo entrega|lt)$/,
    moq: /^(moq|volumen de compra minima|compra minima|minimo)$/,
    rounding: /^(redondeo|valor de redondeo|red|multiplo)$/,
    safety_pct: /^(stock seguridad|stock seguridad pct|ss|stock seg|seguridad)$/
  };

  for (let r = 0; r < Math.min(12, rows.length); r++) {
    const row = rows[r] || [];
    const temp = {};
    for (let c = 0; c < row.length; c++) {
      const h = normText(row[c]).replace(/%/g, "").trim();
      if (!h) continue;
      for (const [k, rx] of Object.entries(matchers)) {
        if (temp[k] === undefined && (rx.test(h) || (k === "code" && h.startsWith("cod")) || (k === "name" && h.startsWith("desc")) || (k === "stock" && (h.includes("stock disp") || h.includes("inventario disp"))))) {
          temp[k] = c;
        }
      }
    }
    if (temp.code !== undefined && temp.name !== undefined) {
      headerRowIdx = r;
      colMap = temp;
      break;
    }
  }

  // Respaldo si no tiene encabezados estándar: asumir Col A=Código, Col B=Descripción, Col C=UM, Col D=Stock
  if (headerRowIdx < 0) {
    headerRowIdx = 0;
    colMap = { code: 0, name: 1, um: 2, stock: 3 };
  }

  const parsed = [];
  let invalid = 0;
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(v => v === null || v === undefined || String(v).trim() === "")) continue;
    const rawCode = row[colMap.code];
    const rawName = row[colMap.name];
    const code = rawCode != null ? String(rawCode).trim() : "";
    const name = rawName != null ? String(rawName).trim() : "";

    // Ignorar encabezados de categoría o ceros
    if (!code || code === "0" || !name || name === "0") {
      invalid++;
      continue;
    }

    const hasVal = idx => idx !== undefined && row[idx] !== null && row[idx] !== undefined && String(row[idx]).trim() !== "";
    const rawType = hasVal(colMap.type) ? String(row[colMap.type]).trim().toUpperCase() : "";
    let safetyVal = null;
    if (hasVal(colMap.safety_pct)) {
      const sv = cleanNum(row[colMap.safety_pct]);
      safetyVal = sv > 1 ? sv / 100 : sv;
    }

    parsed.push({
      rowNum: r + 1,
      code,
      name,
      um: hasVal(colMap.um) ? String(row[colMap.um]).trim() : null,
      type: ["MP", "ME"].includes(rawType) ? rawType : null,
      stock: hasVal(colMap.stock) ? Math.max(0, cleanNum(row[colMap.stock])) : null,
      lead_time: hasVal(colMap.lead_time) ? Math.max(0, cleanNum(row[colMap.lead_time])) : null,
      moq: hasVal(colMap.moq) ? Math.max(0, cleanNum(row[colMap.moq])) : null,
      rounding: hasVal(colMap.rounding) ? Math.max(0.01, cleanNum(row[colMap.rounding])) : null,
      safety_pct: safetyVal !== null ? Math.max(0, safetyVal) : null
    });
  }
  return { sheetName: preferred, parsed, invalid };
}

function analyzeBulkMaterials(parsedRows) {
  // Índice de nombres normalizados en la base de datos actual
  const dbByNormName = new Map(); // normName -> [mat, ...]
  for (const m of STATE.materials.values()) {
    const nk = normText(m.name);
    if (!nk) continue;
    if (!dbByNormName.has(nk)) dbByNormName.set(nk, []);
    dbByNormName.get(nk).push(m);
  }

  const seenCodes = new Map();
  const seenNames = new Map();
  const analyzed = [];

  for (let idx = 0; idx < parsedRows.length; idx++) {
    const item = parsedRows[idx];
    const nk = normText(item.name);
    const existingByCode = STATE.materials.get(item.code) || null;
    const existingByNameList = (dbByNormName.get(nk) || []).filter(m => m.code !== item.code);

    let status = "NUEVO";
    let action = "create";
    let detail = "Insumo nuevo (se creará)";
    let conflictTarget = null;

    if (seenCodes.has(item.code)) {
      status = "DUP_ARCHIVO";
      action = "skip";
      detail = `Código repetido dentro del mismo archivo (ya apareció en fila ${seenCodes.get(item.code)}).`;
    } else if (existingByCode) {
      const existingNorm = normText(existingByCode.name);
      if (existingNorm === nk) {
        status = "ACTUALIZAR";
        action = "update";
        const stInfo = item.stock !== null ? `Stock: ${fmt(existingByCode.stock)} → ${fmt(item.stock)}` : "Sin cambio de stock";
        detail = `Coincidencia exacta · ${stInfo}`;
      } else {
        status = "CONFLICTO_CODIGO";
        action = "keep_current"; // Seguro por defecto: el usuario valida qué se queda
        conflictTarget = existingByCode;
        detail = `Código ya existe en BD como "${existingByCode.name}".`;
      }
    } else if (existingByNameList.length > 0) {
      status = "DUP_NOMBRE";
      action = "skip"; // Seguro por defecto: evitar duplicar el mismo artículo con otro código
      conflictTarget = existingByNameList[0];
      detail = `Nombre ya existe en BD bajo código ${conflictTarget.code} ("${conflictTarget.name}").`;
    } else if (nk && seenNames.has(nk)) {
      status = "DUP_ARCHIVO";
      action = "skip";
      detail = `Nombre repetido en el archivo con otro código (fila ${seenNames.get(nk)}).`;
    }

    if (!seenCodes.has(item.code)) seenCodes.set(item.code, item.rowNum);
    if (nk && !seenNames.has(nk)) seenNames.set(nk, item.rowNum);

    analyzed.push({ idx, item, status, action, detail, existingByCode, conflictTarget });
  }

  return analyzed;
}

function openBulkMaterialModal(onDone) {
  const d = $("#dlg");
  d.classList.add("wide-dlg");
  const closeDlg = () => { d.classList.remove("wide-dlg"); d.close(); };
  d.onclose = () => d.classList.remove("wide-dlg");

  let analyzed = [];
  let meta = { sheetName: "", invalid: 0, fileName: "" };
  let filterMode = "ALL"; // ALL, CONFLICTS, NUEVO, ACTUALIZAR

  const renderUploadStep = () => {
    d.innerHTML = `
      <h2>Carga Masiva de Insumos e Inventario</h2>
      <p class="notice" style="margin:8px 0 14px">
        <strong>Carga segura (no destructiva):</strong> Los <strong>${STATE.materials.size}</strong> insumos actuales que NO aparezcan en el archivo se mantendrán intactos. Antes de guardar, el sistema validará códigos repetidos, cambios de descripción y posibles duplicados por nombre para que usted decida qué se queda.
      </p>
      <div class="bar" style="margin-bottom:14px">
        <button type="button" id="bk_tpl">Descargar Plantilla Excel (.xlsx)</button>
        <span class="hint">También acepta cualquier Excel/CSV con columnas Código, Descripción, UM, Tipo y Stock.</span>
      </div>
      <label>Seleccione el archivo Excel (.xlsx / .xls) o CSV *
        <input type="file" id="bk_file" accept=".xlsx,.xls,.csv">
      </label>
      <div class="err" id="bk_err"></div>
      <div class="bar" style="margin-top:14px">
        <button type="button" id="bk_cls" style="margin-left:auto">Cerrar</button>
      </div>`;

    $("#bk_cls").onclick = closeDlg;
    $("#bk_tpl").onclick = downloadBulkMaterialTemplate;
    $("#bk_file").onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      $("#bk_err").textContent = "";
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const res = parseBulkMaterialWorkbook(wb);
        if (!res.parsed.length) {
          $("#bk_err").textContent = "No se encontraron filas válidas (se requiere al menos Código y Descripción).";
          return;
        }
        meta = { sheetName: res.sheetName, invalid: res.invalid, fileName: file.name };
        analyzed = analyzeBulkMaterials(res.parsed);
        const hasConflicts = analyzed.some(x => ["CONFLICTO_CODIGO", "DUP_NOMBRE", "DUP_ARCHIVO"].includes(x.status));
        filterMode = hasConflicts ? "CONFLICTS" : "ALL";
        renderReviewStep();
      } catch (err) {
        console.error(err);
        $("#bk_err").textContent = "No se pudo leer el archivo: " + (err.message || err);
      }
    };
  };

  const renderReviewStep = () => {
    const cnt = st => analyzed.filter(x => x.status === st).length;
    const cNuevo = cnt("NUEVO");
    const cAct = cnt("ACTUALIZAR");
    const cConfCod = cnt("CONFLICTO_CODIGO");
    const cDupNom = cnt("DUP_NOMBRE");
    const cDupArc = cnt("DUP_ARCHIVO");
    const cTotalConf = cConfCod + cDupNom + cDupArc;

    const inFileCodes = new Set(analyzed.map(x => x.item.code));
    let untouchedCount = 0;
    for (const code of STATE.materials.keys()) if (!inFileCodes.has(code)) untouchedCount++;

    const visible = analyzed.filter(x => {
      if (filterMode === "CONFLICTS") return ["CONFLICTO_CODIGO", "DUP_NOMBRE", "DUP_ARCHIVO"].includes(x.status);
      if (filterMode === "NUEVO") return x.status === "NUEVO";
      if (filterMode === "ACTUALIZAR") return x.status === "ACTUALIZAR";
      return true;
    });

    const willApply = analyzed.filter(x => !["skip", "keep_current"].includes(x.action)).length;

    const badgeFor = st => {
      if (st === "NUEVO") return `<span class="badge ok">NUEVO</span>`;
      if (st === "ACTUALIZAR") return `<span class="badge info">ACTUALIZAR</span>`;
      if (st === "CONFLICTO_CODIGO") return `<span class="badge deficit">CONFLICTO CÓDIGO</span>`;
      if (st === "DUP_NOMBRE") return `<span class="badge warn">DUPLICADO NOMBRE</span>`;
      return `<span class="badge warn">REPETIDO EN ARCHIVO</span>`;
    };

    const actionOptions = x => {
      if (x.status === "NUEVO") {
        return `<option value="create" ${x.action === "create" ? "selected" : ""}>Crear insumo nuevo</option>
                <option value="skip" ${x.action === "skip" ? "selected" : ""}>Omitir</option>`;
      }
      if (x.status === "ACTUALIZAR") {
        return `<option value="update" ${x.action === "update" ? "selected" : ""}>Actualizar datos / stock</option>
                <option value="skip" ${x.action === "skip" ? "selected" : ""}>Omitir (dejar igual)</option>`;
      }
      if (x.status === "CONFLICTO_CODIGO") {
        return `<option value="keep_current" ${x.action === "keep_current" ? "selected" : ""}>Mantener actual (ignorar fila)</option>
                <option value="stock_only" ${x.action === "stock_only" ? "selected" : ""}>Actualizar solo Stock (conservar nombre)</option>
                <option value="overwrite" ${x.action === "overwrite" ? "selected" : ""}>Sobrescribir nombre y datos</option>`;
      }
      if (x.status === "DUP_NOMBRE") {
        const tc = esc(x.conflictTarget?.code || "");
        return `<option value="skip" ${x.action === "skip" ? "selected" : ""}>Omitir (evitar duplicado)</option>
                <option value="merge_existing" ${x.action === "merge_existing" ? "selected" : ""}>Actualizar existente (${tc})</option>
                <option value="create_new" ${x.action === "create_new" ? "selected" : ""}>Crear de todas formas (${esc(x.item.code)})</option>`;
      }
      return `<option value="skip" ${x.action === "skip" ? "selected" : ""}>Omitir repetido</option>
              <option value="apply_dup" ${x.action === "apply_dup" ? "selected" : ""}>Aplicar de todas formas</option>`;
    };

    d.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <h2 style="margin:0">Validación de Carga Masiva</h2>
          <div class="hint">Archivo: <strong>${esc(meta.fileName)}</strong> (Hoja: ${esc(meta.sheetName)}) · ${analyzed.length} filas leídas${meta.invalid ? ` · ${meta.invalid} filas vacías/incompletas ignoradas` : ""}</div>
        </div>
        <button type="button" class="btn-sm" id="bk_back">Cambiar archivo</button>
      </div>

      <p class="notice" style="margin:10px 0;border-left-color:var(--ok)">
        <strong>Protección de catálogo activa:</strong> Los <strong>${untouchedCount}</strong> insumos existentes que no vienen en este archivo permanecerán intactos. Los costos actuales tampoco se alteran.
      </p>

      <div class="bulk-pills">
        <button type="button" class="bulk-pill ${filterMode === "ALL" ? "on" : ""}" data-bf="ALL">Todos (${analyzed.length})</button>
        <button type="button" class="bulk-pill ${cTotalConf ? "err" : ""} ${filterMode === "CONFLICTS" ? "on" : ""}" data-bf="CONFLICTS">Conflictos / Duplicados (${cTotalConf})</button>
        <button type="button" class="bulk-pill ${filterMode === "NUEVO" ? "on" : ""}" data-bf="NUEVO">Nuevos (${cNuevo})</button>
        <button type="button" class="bulk-pill ${filterMode === "ACTUALIZAR" ? "on" : ""}" data-bf="ACTUALIZAR">Actualizaciones (${cAct})</button>
      </div>

      ${cConfCod > 0 ? `<div class="bar" style="margin-bottom:10px">
        <span class="hint">Acción rápida para los <strong>${cConfCod}</strong> conflictos de código:</span>
        <button type="button" class="btn-sm" id="bk_conf_keep">Mantener todos actuales</button>
        <button type="button" class="btn-sm" id="bk_conf_stock">Solo actualizar Stock</button>
        <button type="button" class="btn-sm" id="bk_conf_over">Sobrescribir todos</button>
      </div>` : ""}

      <div class="tablebox" style="max-height:46vh;overflow-y:auto"><table class="mrp-table">
        <thead><tr>
          <th>Fila</th><th>Estado</th><th>Archivo (Código y Descripción)</th><th>En Base Actual</th><th class="num">Stock Archivo</th><th>Decisión</th>
        </tr></thead>
        <tbody>
          ${visible.map(x => {
            const curObj = x.existingByCode || x.conflictTarget;
            const curHtml = curObj
              ? `<div><strong>${esc(curObj.name)}</strong></div><div class="hint"><code>${esc(curObj.code)}</code> · ${esc(curObj.um)} · Stock: ${fmt(curObj.stock)}</div>`
              : `<span class="hint">— No existe —</span>`;
            return `<tr>
              <td class="hint">#${x.item.rowNum}</td>
              <td>${badgeFor(x.status)}</td>
              <td>
                <div><strong>${esc(x.item.name)}</strong></div>
                <div class="hint"><code>${esc(x.item.code)}</code>${x.item.um ? ` · ${esc(x.item.um)}` : ""}${x.item.type ? ` · ${x.item.type}` : ""}</div>
                <div class="hint" style="color:var(--brand)">${esc(x.detail)}</div>
              </td>
              <td>${curHtml}</td>
              <td class="num">${x.item.stock !== null ? `<strong>${fmt(x.item.stock)}</strong>` : `<span class="hint">Sin cambio</span>`}</td>
              <td><select class="bulk-sel" data-bidx="${x.idx}">${actionOptions(x)}</select></td>
            </tr>`;
          }).join("") || `<tr><td colspan="6" class="hint" style="text-align:center;padding:18px">No hay filas en esta categoría.</td></tr>`}
        </tbody>
      </table></div>

      <div class="err" id="bk_save_err"></div>
      <div class="bar" style="margin-top:14px">
        <button type="button" class="primary" id="bk_apply" ${willApply === 0 ? "disabled" : ""}>Confirmar y Aplicar (${willApply} cambios)</button>
        <button type="button" id="bk_cls2" style="margin-left:auto">Cancelar</button>
      </div>`;

    $("#bk_cls2").onclick = closeDlg;
    $("#bk_back").onclick = renderUploadStep;
    d.querySelectorAll("[data-bf]").forEach(b => b.onclick = () => { filterMode = b.dataset.bf; renderReviewStep(); });

    if ($("#bk_conf_keep")) $("#bk_conf_keep").onclick = () => { analyzed.forEach(x => { if (x.status === "CONFLICTO_CODIGO") x.action = "keep_current"; }); renderReviewStep(); };
    if ($("#bk_conf_stock")) $("#bk_conf_stock").onclick = () => { analyzed.forEach(x => { if (x.status === "CONFLICTO_CODIGO") x.action = "stock_only"; }); renderReviewStep(); };
    if ($("#bk_conf_over")) $("#bk_conf_over").onclick = () => { analyzed.forEach(x => { if (x.status === "CONFLICTO_CODIGO") x.action = "overwrite"; }); renderReviewStep(); };

    d.querySelectorAll("[data-bidx]").forEach(sel => {
      sel.onchange = () => {
        const entry = analyzed[Number(sel.dataset.bidx)];
        entry.action = sel.value;
        const countNow = analyzed.filter(x => !["skip", "keep_current"].includes(x.action)).length;
        const btn = $("#bk_apply");
        btn.disabled = countNow === 0;
        btn.textContent = `Confirmar y Aplicar (${countNow} cambios)`;
      };
    });

    $("#bk_apply").onclick = async () => {
      const btn = $("#bk_apply");
      btn.disabled = true; btn.textContent = "Guardando en Supabase…";
      $("#bk_save_err").textContent = "";
      try {
        const now = new Date().toISOString();
        const upsertMap = new Map(); // code -> record

        const mergeWithExisting = (base, it, overwriteName) => ({
          code: base.code,
          name: overwriteName ? it.name : base.name,
          um: it.um ?? base.um ?? "Kg",
          type: it.type ?? base.type ?? "MP",
          lead_time: it.lead_time ?? num(base.lead_time) ?? 3,
          moq: it.moq ?? num(base.moq) ?? 1,
          rounding: it.rounding ?? (num(base.rounding) || 1),
          safety_pct: it.safety_pct ?? num(base.safety_pct),
          stock: it.stock !== null ? it.stock : num(base.stock),
          cost: num(base.cost),
          prev_cost: num(base.prev_cost),
          cost_updated_at: base.cost_updated_at || null,
          updated_at: now
        });

        const buildNew = it => ({
          code: it.code,
          name: it.name,
          um: it.um || "Kg",
          type: it.type || "MP",
          lead_time: it.lead_time ?? 3,
          moq: it.moq ?? 1,
          rounding: it.rounding ?? 1,
          safety_pct: it.safety_pct ?? 0.2,
          stock: it.stock ?? 0,
          cost: 0,
          prev_cost: 0,
          updated_at: now
        });

        let createdCnt = 0, updatedCnt = 0;

        for (const x of analyzed) {
          if (x.action === "skip" || x.action === "keep_current") continue;
          const it = x.item;
          if (x.action === "create" || x.action === "create_new") {
            upsertMap.set(it.code, buildNew(it));
            createdCnt++;
          } else if (x.action === "update" || x.action === "overwrite") {
            const base = upsertMap.get(it.code) || STATE.materials.get(it.code);
            upsertMap.set(it.code, base ? mergeWithExisting(base, it, x.action === "overwrite") : buildNew(it));
            updatedCnt++;
          } else if (x.action === "stock_only") {
            const base = upsertMap.get(it.code) || STATE.materials.get(it.code);
            if (base && it.stock !== null) {
              upsertMap.set(it.code, { ...base, stock: it.stock, updated_at: now });
              updatedCnt++;
            }
          } else if (x.action === "merge_existing" && x.conflictTarget) {
            const tCode = x.conflictTarget.code;
            const base = upsertMap.get(tCode) || STATE.materials.get(tCode);
            if (base) {
              upsertMap.set(tCode, mergeWithExisting(base, it, false));
              updatedCnt++;
            }
          } else if (x.action === "apply_dup") {
            const base = upsertMap.get(it.code) || STATE.materials.get(it.code);
            upsertMap.set(it.code, base ? mergeWithExisting(base, it, true) : buildNew(it));
            if (base) updatedCnt++; else createdCnt++;
          }
        }

        const records = [...upsertMap.values()];
        if (!records.length) {
          closeDlg();
          return toast("No hubo cambios para aplicar.");
        }

        await batchUpsert("mrp_materiales", records, "code");
        records.forEach(rec => STATE.materials.set(rec.code, rec));
        closeDlg();
        toast(`Carga masiva aplicada: ${createdCnt} creado(s), ${updatedCnt} actualizado(s). Los demás insumos quedaron intactos.`);
        if (onDone) onDone(); else renderView();
      } catch (err) {
        console.error(err);
        $("#bk_save_err").textContent = "Error al guardar en Supabase: " + (err.message || err);
        btn.disabled = false;
        btn.textContent = "Reintentar Guardar";
      }
    };
  };

  renderUploadStep();
  d.showModal();
}

// -------------------- 6. COSTOS DE COMPRA (SIN PÉRDIDA DE FOCO) --------------------
function renderCostos(v) {
  v.innerHTML = `
    <div id="fco_kpis" class="kpi-grid"></div>
    <div class="bar">
      <input type="search" id="fco_q" placeholder="Buscar insumo o código…" value="${esc(STATE.fCostos.q)}">
      <select id="fco_type">
        <option value="">MP y ME</option>
        <option value="MP" ${STATE.fCostos.type === "MP" ? "selected" : ""}>Solo MP</option>
        <option value="ME" ${STATE.fCostos.type === "ME" ? "selected" : ""}>Solo ME</option>
      </select>
      <label class="toggle-lbl"><input type="checkbox" id="fco_zero" ${STATE.fCostos.onlyZero ? "checked" : ""}> Solo sin costo ($0)</label>
    </div>
    <div class="tablebox"><table class="mrp-table">
      <thead><tr>
        <th>Código</th><th>Insumo</th><th>UM</th><th>Tipo</th>
        <th class="num">Costo Anterior</th><th class="num">Último Costo (USD)</th><th class="num">% Variación</th><th>Actualizado</th><th>Acciones</th>
      </tr></thead>
      <tbody id="fco_body"></tbody>
    </table></div>`;

  const paintRows = () => {
    const q = STATE.fCostos.q.toLowerCase().trim();
    const all = [...STATE.materials.values()];
    const zeroCount = all.filter(m => num(m.cost) <= 0).length;
    $("#fco_kpis").innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Total Insumos</div><div class="kpi-val">${all.length}</div></div>
      <div class="kpi-card ok"><div class="kpi-label">Con Último Costo</div><div class="kpi-val">${all.length - zeroCount}</div></div>
      <div class="kpi-card ${zeroCount ? "warn" : "ok"}"><div class="kpi-label">Pendientes ($0)</div><div class="kpi-val">${zeroCount}</div></div>`;

    const list = all.filter(m =>
      (!STATE.fCostos.type || m.type === STATE.fCostos.type) &&
      (!STATE.fCostos.onlyZero || num(m.cost) <= 0) &&
      (!q || m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    );
    const tb = $("#fco_body");
    tb.innerHTML = list.map(m => {
      const c = num(m.cost), pc = num(m.prev_cost);
      const diffPct = pc > 0 ? ((c - pc) / pc) * 100 : null;
      const upd = m.cost_updated_at ? new Date(m.cost_updated_at).toLocaleDateString("es-VE") : "—";
      return `<tr>
        <td><code>${esc(m.code)}</code></td>
        <td><strong>${esc(m.name)}</strong></td>
        <td>${esc(m.um)}</td>
        <td><span class="badge ${m.type === "MP" ? "mp" : "me"}">${m.type}</span></td>
        <td class="num">${pc > 0 ? fmtUsd(pc) : "—"}</td>
        <td class="num"><strong style="color:${c <= 0 ? "var(--danger)" : "var(--brand)"}">${fmtUsd(c)}</strong></td>
        <td class="num">${diffPct === null ? "—" : `<span style="color:${diffPct > 0 ? "var(--danger)" : "var(--ok)"};font-weight:700">${diffPct > 0 ? "+" : ""}${fmt(diffPct, 1)}%</span>`}</td>
        <td class="hint">${upd}</td>
        <td style="white-space:nowrap">
          <button class="btn-sm primary" data-updcost="${esc(m.code)}">Actualizar Costo</button>
          <button class="btn-sm" data-hist="${esc(m.code)}">Historial</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="9" class="hint" style="text-align:center;padding:20px">No hay insumos que coincidan.</td></tr>`;

    tb.querySelectorAll("[data-updcost]").forEach(b => b.onclick = () => openUpdateCostModal(b.dataset.updcost, paintRows));
    tb.querySelectorAll("[data-hist]").forEach(b => b.onclick = () => openCostHistoryModal(b.dataset.hist));
  };

  paintRows();
  $("#fco_q").oninput = e => { STATE.fCostos.q = e.target.value; paintRows(); };
  $("#fco_type").onchange = e => { STATE.fCostos.type = e.target.value; paintRows(); };
  $("#fco_zero").onchange = e => { STATE.fCostos.onlyZero = e.target.checked; paintRows(); };
}

function openUpdateCostModal(code, onSaved) {
  const m = STATE.materials.get(code);
  const d = $("#dlg");
  d.innerHTML = `<form id="cf_upd" autocomplete="off">
    <h2>Actualizar Último Costo</h2>
    <p class="hint" style="margin:0 0 12px"><strong>${esc(m.name)}</strong> (<code>${esc(m.code)}</code> · ${esc(m.um)})</p>
    <div class="row">
      <label>Costo Vigente Actual (USD)<input type="text" value="${fmtUsd(m.cost)}" disabled></label>
      <label>Nuevo Último Costo (USD) *<input type="number" step="any" min="0" name="new_cost" required value="${num(m.cost)}"></label>
    </div>
    <label>Proveedor (opcional)<input type="text" name="provider" list="dl_proveedores" placeholder="Seleccione un proveedor aprobado…"></label>
    <label>Referencia / Nota (ej. Factura o O/C)<input type="text" name="note" placeholder="Ej. O/C #1042"></label>
    <div class="err" id="cu_err"></div>
    <div class="bar"><button class="primary" type="submit">Guardar Nuevo Costo</button><button type="button" id="cu_cls">Cancelar</button></div>
  </form>`;
  d.showModal();
  $("#cu_cls").onclick = () => d.close();
  $("#cf_upd").onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const newCost = Math.max(0, num(f.new_cost.value));
    const oldCost = num(m.cost);
    const now = new Date().toISOString();
    try {
      const { error: e1 } = await sb.from("mrp_materiales").update({
        prev_cost: oldCost, cost: newCost, cost_updated_at: now, updated_at: now
      }).eq("code", code);
      if (e1) throw e1;
      const { error: e2 } = await sb.from("mrp_costos_historial").insert({
        mat_code: code, old_cost: oldCost, new_cost: newCost,
        provider: f.provider.value.trim() || null, note: f.note.value.trim() || null
      });
      if (e2) throw e2;
      m.prev_cost = oldCost; m.cost = newCost; m.cost_updated_at = now;
      d.close();
      toast(`Último costo de ${m.name} actualizado a ${fmtUsd(newCost)}.`);
      if (onSaved) onSaved(); else renderView();
    } catch (err) {
      $("#cu_err").textContent = err.message || "Error al guardar.";
    }
  };
}

async function openCostHistoryModal(code) {
  const m = STATE.materials.get(code);
  const d = $("#dlg");
  d.innerHTML = `<h2>Historial de Costos · ${esc(m.name)}</h2><p class="hint">Cargando…</p>`;
  d.showModal();
  const { data, error } = await sb.from("mrp_costos_historial").select("*").eq("mat_code", code).order("created_at", { ascending: false }).limit(50);
  if (error) { d.innerHTML = `<p class="err">${esc(error.message)}</p><button onclick="this.closest('dialog').close()">Cerrar</button>`; return; }
  d.innerHTML = `
    <h2>Historial de Costos</h2>
    <p class="hint" style="margin:0 0 12px"><strong>${esc(m.name)}</strong> (<code>${esc(m.code)}</code>)</p>
    <div class="tablebox"><table class="mrp-table">
      <thead><tr><th>Fecha</th><th class="num">Anterior</th><th class="num">Nuevo Costo</th><th>Proveedor</th><th>Nota</th></tr></thead>
      <tbody>
        ${(data || []).map(h => `<tr>
          <td>${new Date(h.created_at).toLocaleString("es-VE")}</td>
          <td class="num">${fmtUsd(h.old_cost)}</td>
          <td class="num"><strong>${fmtUsd(h.new_cost)}</strong></td>
          <td>${esc(h.provider || "—")}</td>
          <td>${esc(h.note || "—")}</td>
        </tr>`).join("") || `<tr><td colspan="5" class="hint" style="text-align:center;padding:16px">Sin cambios registrados todavía.</td></tr>`}
      </tbody>
    </table></div>
    <div class="bar" style="margin-top:14px"><button type="button" onclick="this.closest('dialog').close()">Cerrar</button></div>`;
}

// -------------------- 7. FÓRMULAS (BOM) SIN PÉRDIDA DE FOCO --------------------
function renderFormulas(v) {
  const cats = [...new Set([...STATE.skus.values()].map(s => s.category))].sort();
  v.innerHTML = `
    <div class="bom-layout">
      <div class="panel-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h3 style="margin:0">SKUs (<span id="fb_cnt">${STATE.skus.size}</span>)</h3>
          <button id="btn_new_sku" class="btn-sm primary">+ Nueva</button>
        </div>
        <input type="search" id="fb_q" placeholder="Filtrar SKU…" value="${esc(STATE.fBom.q)}" style="margin-bottom:8px">
        <select id="fb_cat" style="margin-bottom:10px"><option value="">Todas las categorías</option>${cats.map(c => `<option ${c === STATE.fBom.cat ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <div class="sku-list" id="fb_list"></div>
      </div>
      <div class="panel-card" id="fb_detail"></div>
    </div>`;

  const paintList = () => {
    const q = STATE.fBom.q.toLowerCase().trim();
    const skus = [...STATE.skus.values()].filter(s =>
      (!STATE.fBom.cat || s.category === STATE.fBom.cat) &&
      (!q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    );
    if (STATE.selectedSku && !STATE.skus.has(STATE.selectedSku)) STATE.selectedSku = skus[0]?.code || null;
    if (!STATE.selectedSku && skus.length) STATE.selectedSku = skus[0].code;

    $("#fb_cnt").textContent = STATE.skus.size;
    const box = $("#fb_list");
    box.innerHTML = skus.map(s => `<button class="sku-item ${s.code === STATE.selectedSku ? "active" : ""}" data-selsku="${esc(s.code)}">
      <div><strong>${esc(s.name)}</strong></div>
      <div class="hint">${esc(s.code)} · ${esc(s.category)} · ${(STATE.bom.get(s.code) || []).length} ins.</div>
    </button>`).join("") || `<p class="hint">Sin fórmulas.</p>`;

    box.querySelectorAll("[data-selsku]").forEach(b => b.onclick = () => {
      STATE.selectedSku = b.dataset.selsku;
      paintList();
      paintDetail();
    });
  };

  const paintDetail = () => {
    const det = $("#fb_detail");
    const sel = STATE.selectedSku ? STATE.skus.get(STATE.selectedSku) : null;
    if (!sel) {
      det.innerHTML = `<div class="empty-hero"><h3>Seleccione o cree una fórmula</h3><button class="primary" id="btn_new_sku2">+ Nueva Fórmula</button></div>`;
      $("#btn_new_sku2").onclick = () => openNewSkuModal();
      return;
    }
    const bom = STATE.bom.get(sel.code) || [];
    const cb = skuCostBreakdown(sel.code);
    const massOk = Math.abs(cb.kgSum - num(sel.batch_size_kg)) <= Math.max(1, num(sel.batch_size_kg) * 0.01);

    det.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <div>
          <h3 style="margin:0">${esc(sel.name)}</h3>
          <div class="hint">Código: <code>${esc(sel.code)}</code> · Categoría: <strong>${esc(sel.category)}</strong></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-sm primary" id="btn_imp_bom" title="Cargar ingredientes desde Excel (ej. Lista de materiales SAP)">Cargar Fórmula (Excel)</button>
          <button class="btn-sm" id="btn_dup_sku">Duplicar Fórmula</button>
          <button class="btn-sm btn-danger" id="btn_del_sku">Eliminar Fórmula</button>
        </div>
      </div>

      <div class="row" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin-bottom:12px">
        <label>Unds / Caja<input type="number" step="1" min="1" id="sk_uc" value="${num(sel.units_per_case)}"></label>
        <label>Peso Neto / Caja (Kg)<input type="number" step="any" min="0.01" id="sk_pw" value="${num(sel.net_weight_per_case)}"></label>
        <label>Tamaño Lote (Kg)<input type="number" step="any" min="1" id="sk_bk" value="${num(sel.batch_size_kg)}"></label>
        <label>Rendimiento (%)<input type="number" step="any" min="1" max="100" id="sk_yp" value="${num(sel.yield_pct || 98)}"></label>
        <label>Lote (Cajas)<input type="number" step="any" id="sk_bc" value="${fmt(sel.batch_size_cases, 2).replace(",", ".")}" disabled></label>
      </div>

      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi-card"><div class="kpi-label">Costo Lote (MP / ME)</div><div class="kpi-val">${fmtUsd(cb.total)}</div><div class="kpi-sub">MP: ${fmtUsd(cb.mp)} · ME: ${fmtUsd(cb.me)}</div></div>
        <div class="kpi-card accent"><div class="kpi-label">Costo / Caja</div><div class="kpi-val">${fmtUsd(cb.perCase)}</div><div class="kpi-sub">Costo / Und: ${fmtUsd(cb.perUnit)}</div></div>
        <div class="kpi-card ${massOk ? "ok" : "warn"}"><div class="kpi-label">Balance Masa MP</div><div class="kpi-val">${fmt(cb.kgSum, 2)} kg</div><div class="kpi-sub">Meta: ${fmt(sel.batch_size_kg, 0)} kg · ${massOk ? "OK ✓" : "REVISAR (±1%)"}</div></div>
      </div>

      <div class="bar" style="align-items:flex-start">
        <div class="combo-wrap">
          <input type="search" id="bom_search_mat" placeholder="Buscar insumo por nombre o código para agregar…" autocomplete="off">
          <input type="hidden" id="bom_add_mat" value="">
          <div id="bom_combo_list" class="combo-list" hidden></div>
        </div>
        <input type="number" id="bom_add_qty" step="any" min="0" placeholder="Cant/Lote" style="width:120px">
        <button id="btn_bom_add" class="primary" style="padding:8px 14px;font-size:.86rem">Agregar</button>
        <button id="btn_bom_newmat" class="btn-sm">+ Crear Insumo</button>
      </div>

      <div class="tablebox"><table class="mrp-table">
        <thead><tr><th>Código</th><th>Insumo</th><th>Tipo</th><th>UM</th><th class="num">Cant. / Lote</th><th class="num">Último Costo</th><th class="num">Subtotal Lote</th><th></th></tr></thead>
        <tbody>
          ${bom.map(it => {
            const m = STATE.materials.get(it.mat_code);
            if (!m) return "";
            return `<tr data-mat="${esc(m.code)}">
              <td><code>${esc(m.code)}</code></td>
              <td><strong>${esc(m.name)}</strong></td>
              <td><span class="badge ${m.type === "MP" ? "mp" : "me"}">${m.type}</span></td>
              <td>${esc(m.um)}</td>
              <td class="num"><input class="cell-inp" type="number" step="any" min="0" data-bqty value="${num(it.qty_per_batch)}"></td>
              <td class="num">${fmtUsd(m.cost)}</td>
              <td class="num"><strong>${fmtUsd(num(it.qty_per_batch) * num(m.cost))}</strong></td>
              <td><button class="btn-sm btn-danger" data-brm="${esc(m.code)}">Quitar</button></td>
            </tr>`;
          }).join("") || `<tr><td colspan="8" class="hint" style="text-align:center;padding:18px">Esta fórmula no tiene ingredientes cargados.</td></tr>`}
        </tbody>
      </table></div>`;

    const saveSkuParams = () => {
      sel.units_per_case = Math.max(1, num($("#sk_uc").value));
      sel.net_weight_per_case = Math.max(0.001, num($("#sk_pw").value));
      sel.batch_size_kg = Math.max(1, num($("#sk_bk").value));
      sel.yield_pct = Math.max(1, Math.min(100, num($("#sk_yp").value)));
      sel.batch_size_cases = (sel.batch_size_kg / sel.net_weight_per_case) * (sel.yield_pct / 100);
      debounceSave("sku_" + sel.code, async () => {
        const { error } = await sb.from("mrp_skus").update({
          units_per_case: sel.units_per_case, net_weight_per_case: sel.net_weight_per_case,
          batch_size_kg: sel.batch_size_kg, yield_pct: sel.yield_pct,
          batch_size_cases: sel.batch_size_cases, updated_at: new Date().toISOString()
        }).eq("code", sel.code);
        if (error) throw error;
      });
      paintDetail();
    };
    ["#sk_uc", "#sk_pw", "#sk_bk", "#sk_yp"].forEach(id => $(id).onchange = saveSkuParams);

    // Buscador predictivo rápido de insumos para la fórmula
    const sInp = $("#bom_search_mat");
    const hCode = $("#bom_add_mat");
    const cList = $("#bom_combo_list");
    const qInp = $("#bom_add_qty");
    const allMats = [...STATE.materials.values()];
    let hiIdx = -1;
    let curMatches = [];

    const selectMat = m => {
      hCode.value = m.code;
      sInp.value = `${m.code} — ${m.name} (${m.um})`;
      cList.hidden = true;
      qInp.focus();
      qInp.select();
    };

    const renderCombo = () => {
      const q = sInp.value.toLowerCase().trim();
      curMatches = allMats.filter(m => !q || m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 25);
      hiIdx = curMatches.length ? 0 : -1;
      if (!curMatches.length) {
        cList.innerHTML = `<div class="hint" style="padding:10px">Sin coincidencias. Puede crearlo con "+ Crear Insumo".</div>`;
      } else {
        cList.innerHTML = curMatches.map((m, i) => `
          <button type="button" class="combo-item ${i === hiIdx ? "hi" : ""}" data-ci="${i}">
            <span><strong>${esc(m.name)}</strong> <span class="hint">(${esc(m.code)})</span></span>
            <span class="badge ${m.type === "MP" ? "mp" : "me"}">${m.type} · ${esc(m.um)}</span>
          </button>`).join("");
        cList.querySelectorAll("[data-ci]").forEach(b => {
          b.onmousedown = ev => { ev.preventDefault(); selectMat(curMatches[Number(b.dataset.ci)]); };
        });
      }
      cList.hidden = false;
    };

    sInp.onfocus = renderCombo;
    sInp.oninput = () => { hCode.value = ""; renderCombo(); };
    sInp.onblur = () => setTimeout(() => { cList.hidden = true; }, 160);
    sInp.onkeydown = ev => {
      if (cList.hidden) return;
      if (ev.key === "ArrowDown") { ev.preventDefault(); hiIdx = Math.min(curMatches.length - 1, hiIdx + 1); cList.querySelectorAll(".combo-item").forEach((el, i) => el.classList.toggle("hi", i === hiIdx)); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); hiIdx = Math.max(0, hiIdx - 1); cList.querySelectorAll(".combo-item").forEach((el, i) => el.classList.toggle("hi", i === hiIdx)); }
      else if (ev.key === "Enter" && hiIdx >= 0 && curMatches[hiIdx]) { ev.preventDefault(); selectMat(curMatches[hiIdx]); }
      else if (ev.key === "Escape") { cList.hidden = true; }
    };

    const doAddBom = async () => {
      let matCode = hCode.value;
      if (!matCode && sInp.value.trim()) {
        const exact = allMats.find(m => m.code.toLowerCase() === sInp.value.trim().toLowerCase());
        if (exact) matCode = exact.code;
      }
      const qty = num(qInp.value);
      if (!matCode || qty <= 0) return toast("Busque y seleccione un insumo de la lista y escriba una cantidad > 0.", true);
      const { error } = await sb.from("mrp_bom").upsert({ sku_code: sel.code, mat_code: matCode, qty_per_batch: qty }, { onConflict: "sku_code,mat_code" });
      if (error) return toast(error.message, true);
      if (!STATE.bom.has(sel.code)) STATE.bom.set(sel.code, []);
      const arr = STATE.bom.get(sel.code);
      const ex = arr.find(x => x.mat_code === matCode);
      if (ex) ex.qty_per_batch = qty; else arr.push({ mat_code: matCode, qty_per_batch: qty });
      toast("Ingrediente agregado.");
      paintList();
      paintDetail();
      setTimeout(() => $("#bom_search_mat")?.focus(), 40);
    };

    $("#btn_bom_add").onclick = doAddBom;
    qInp.onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); doAddBom(); } };

    $("#btn_bom_newmat").onclick = () => openNewMaterialModal(() => paintDetail());

    det.querySelectorAll("input[data-bqty]").forEach(inp => {
      inp.onchange = () => {
        const matCode = inp.closest("tr").dataset.mat;
        const qty = Math.max(0, num(inp.value));
        const item = (STATE.bom.get(sel.code) || []).find(x => x.mat_code === matCode);
        if (item) item.qty_per_batch = qty;
        debounceSave(`bom_${sel.code}_${matCode}`, async () => {
          const { error } = await sb.from("mrp_bom").upsert({ sku_code: sel.code, mat_code: matCode, qty_per_batch: qty }, { onConflict: "sku_code,mat_code" });
          if (error) throw error;
        });
        paintDetail();
      };
    });

    det.querySelectorAll("[data-brm]").forEach(btn => {
      btn.onclick = async () => {
        const matCode = btn.dataset.brm;
        const { error } = await sb.from("mrp_bom").delete().eq("sku_code", sel.code).eq("mat_code", matCode);
        if (error) return toast(error.message, true);
        STATE.bom.set(sel.code, (STATE.bom.get(sel.code) || []).filter(x => x.mat_code !== matCode));
        paintList();
        paintDetail();
      };
    });

    $("#btn_imp_bom").onclick = () => openImportBomModal(sel, () => { paintList(); paintDetail(); });
    $("#btn_dup_sku").onclick = () => openDuplicateSkuModal(sel);
    $("#btn_del_sku").onclick = () => openDeleteSkuModal(sel);
  };

  paintList();
  paintDetail();
  $("#fb_q").oninput = e => { STATE.fBom.q = e.target.value; paintList(); };
  $("#fb_cat").onchange = e => { STATE.fBom.cat = e.target.value; paintList(); };
  $("#btn_new_sku").onclick = () => openNewSkuModal();
}

// -------------------- 7B. CARGA DE FÓRMULA (BOM) DESDE EXCEL (EJ. LISTA DE MATERIALES SAP) --------------------
function isNonMaterialLine(code, name, um) {
  const c = String(code || "").trim().toUpperCase();
  const n = normText(name);
  if (/^(MO|CF)\d+/.test(c)) return true;
  if (/(mano de obra|carga fabril|horas hombre|hora maquina|gasto fabril|depreciacion|energia electrica)/.test(n)) return true;
  if (!um && /^(MO|CF|GG|CIF)/i.test(c)) return true;
  return false;
}

function guessMaterialType(name, um) {
  const n = normText(name);
  const u = normText(um);
  if (/(unidad|und|pza|pieza|rollo|caja|tapa|bolsa|envase|etiqueta|frasco|botella|bobina|strech|stretch|carton|embalaje|empaque|saco|pote|galon|tambor|bandeja|cinta)/.test(u + " " + n)) {
    return "ME";
  }
  return "MP";
}

function normalizeUm(rawUm) {
  const s = String(rawUm || "").trim();
  if (!s) return "Kg";
  const low = s.toLowerCase();
  if (low === "kg" || low === "kgs" || low === "kilo" || low === "kilos") return "Kg";
  if (low === "l" || low === "lt" || low === "lts" || low === "litro" || low === "litros") return "L";
  if (low === "unidad" || low === "unidades" || low === "und" || low === "unds" || low === "pza") return "Und";
  return s;
}

function parseBomExcelFile(wb) {
  const sheetName = wb.SheetNames.find(n => /lista|material|formula|bom|receta/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
  if (!rows.length) return { sheetName, items: [], skippedEmpty: 0 };

  // Detectar fila de encabezados (compatible con SAP "Lista de materiales.xlsx" y plantillas genéricas)
  let headerIdx = -1;
  let colMap = {};
  const matchers = {
    code: /^(n|no|n°|nro|numero|codigo|cod|code|articulo|item|codigo insumo)$/,
    name: /^(descripcion|nombre|insumo|material|articulo descripcion|description)$/,
    qty: /^(cantidad|cant|cant lote|cant por lote|cantidad por lote|qty|peso)$/,
    um: /^(nombre de unidad de medida|unidad de medida|um|u m|unidad|medida)$/
  };

  for (let r = 0; r < Math.min(15, rows.length); r++) {
    const row = rows[r] || [];
    const temp = {};
    for (let c = 0; c < row.length; c++) {
      const rawH = String(row[c] ?? "").trim();
      const h = normText(rawH);
      const rawLow = rawH.toLowerCase();
      if (!rawH) continue;
      if (temp.code === undefined && (rawLow === "nº" || rawLow === "n°" || matchers.code.test(h) || h.startsWith("cod"))) {
        temp.code = c;
      } else if (temp.name === undefined && (matchers.name.test(h) || h.startsWith("desc"))) {
        temp.name = c;
      } else if (temp.qty === undefined && (matchers.qty.test(h) || h.startsWith("cant"))) {
        temp.qty = c;
      } else if (temp.um === undefined && (matchers.um.test(h) || h.includes("unidad de medida"))) {
        temp.um = c;
      }
    }
    if (temp.code !== undefined && temp.qty !== undefined) {
      headerIdx = r;
      colMap = temp;
      break;
    }
  }

  // Respaldo: estructura exacta de "Lista de materiales.xlsx" (Col C=Nº, Col D=Descripción, Col E=Cantidad, Col F=UM)
  if (headerIdx < 0) {
    headerIdx = 0;
    colMap = { code: 2, name: 3, qty: 4, um: 5 };
  }

  const items = [];
  let skippedEmpty = 0;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const code = row[colMap.code] != null ? String(row[colMap.code]).trim() : "";
    const name = colMap.name !== undefined && row[colMap.name] != null ? String(row[colMap.name]).trim() : "";
    const qty = cleanNum(row[colMap.qty]);
    const rawUm = colMap.um !== undefined && row[colMap.um] != null ? String(row[colMap.um]).trim() : "";

    // Ignorar filas vacías o sin código / cantidad <= 0
    if (!code || code === "0" || qty <= 0) {
      skippedEmpty++;
      continue;
    }

    items.push({
      rowNum: r + 1,
      code,
      name: name || code,
      qty,
      rawUm,
      um: normalizeUm(rawUm)
    });
  }
  return { sheetName, items, skippedEmpty };
}

function openImportBomModal(sku, onDone) {
  const d = $("#dlg");
  d.classList.add("wide-dlg");
  const closeDlg = () => { d.classList.remove("wide-dlg"); d.close(); };
  d.onclose = () => d.classList.remove("wide-dlg");

  let analyzed = [];
  let meta = { sheetName: "", fileName: "", skippedEmpty: 0 };
  let mode = "replace"; // "replace" o "merge"

  const renderUploadStep = () => {
    const curCount = (STATE.bom.get(sku.code) || []).length;
    d.innerHTML = `
      <h2>Cargar Fórmula desde Excel</h2>
      <p class="hint" style="margin:0 0 10px">Producto destino: <strong>${esc(sku.name)}</strong> (<code>${esc(sku.code)}</code> · Lote ${fmt(sku.batch_size_kg, 0)} kg · ${curCount} insumo(s) actuales)</p>
      <p class="notice" style="margin:0 0 14px">
        Compatible directamente con el archivo <strong>Lista de materiales.xlsx</strong> (SAP) o cualquier Excel con columnas <strong>Nº / Código</strong>, <strong>Descripción</strong>, <strong>Cantidad</strong> y <strong>Unidad de medida</strong>. Solo se toman los datos necesarios para la receta; costos, almacenes y líneas de <em>Mano de Obra / Carga Fabril</em> se filtran automáticamente.
      </p>
      <label>Seleccione el archivo Excel (.xlsx / .xls / .csv) *
        <input type="file" id="bm_file" accept=".xlsx,.xls,.csv">
      </label>
      <div class="err" id="bm_err"></div>
      <div class="bar" style="margin-top:14px">
        <button type="button" id="bm_cls" style="margin-left:auto">Cancelar</button>
      </div>`;

    $("#bm_cls").onclick = closeDlg;
    $("#bm_file").onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      $("#bm_err").textContent = "";
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const res = parseBomExcelFile(wb);
        if (!res.items.length) {
          $("#bm_err").textContent = "No se encontraron líneas con Código y Cantidad > 0.";
          return;
        }
        meta = { sheetName: res.sheetName, fileName: file.name, skippedEmpty: res.skippedEmpty };

        const seen = new Map();
        analyzed = res.items.map((it, idx) => {
          const existing = STATE.materials.get(it.code) || null;
          const nonMat = isNonMaterialLine(it.code, it.name, it.rawUm);
          const isDup = seen.has(it.code);
          if (!isDup) seen.set(it.code, it.rowNum);

          let status = "OK";
          let action = "include";
          let note = existing ? `En catálogo: ${existing.name}` : "";

          if (isDup) {
            status = "DUP";
            action = "sum";
            note = `Código repetido en el archivo (fila ${seen.get(it.code)}).`;
          } else if (nonMat) {
            status = "NO_MATERIAL";
            action = "skip";
            note = "Línea de costo indirecto / mano de obra (omitida por defecto).";
          } else if (!existing) {
            status = "FALTANTE";
            const gType = guessMaterialType(it.name, it.rawUm);
            action = gType === "ME" ? "create_me" : "create_mp";
            note = `No existe en catálogo · se creará como ${gType} si se aprueba.`;
          } else if (normText(existing.name) !== normText(it.name)) {
            note = `En catálogo figura como "${existing.name}" (se usará el catálogo).`;
          }

          return { idx, it, existing, status, action, note };
        });

        renderReviewStep();
      } catch (err) {
        console.error(err);
        $("#bm_err").textContent = "Error al leer el archivo: " + (err.message || err);
      }
    };
  };

  const renderReviewStep = () => {
    const activeItems = analyzed.filter(x => x.action !== "skip");
    const newMatsCount = analyzed.filter(x => x.action === "create_mp" || x.action === "create_me").length;
    const nonMatCount = analyzed.filter(x => x.status === "NO_MATERIAL").length;

    // Calcular balance de masa MP estimado (kg/l)
    let estKg = 0;
    for (const x of activeItems) {
      const mType = x.existing ? x.existing.type : (x.action === "create_me" ? "ME" : "MP");
      const mUm = x.existing ? x.existing.um : x.it.um;
      if (mType === "MP" && ["kg", "l", "lt", "lts"].includes(String(mUm || "").toLowerCase())) {
        estKg += x.it.qty;
      }
    }
    const massOk = Math.abs(estKg - num(sku.batch_size_kg)) <= Math.max(1, num(sku.batch_size_kg) * 0.01);

    const badgeFor = st => {
      if (st === "OK") return `<span class="badge ok">EN CATÁLOGO</span>`;
      if (st === "FALTANTE") return `<span class="badge warn">NO EN CATÁLOGO</span>`;
      if (st === "NO_MATERIAL") return `<span class="badge info">MO / CARGA FABRIL</span>`;
      return `<span class="badge warn">REPETIDO</span>`;
    };

    const actionOptions = x => {
      if (x.status === "OK") {
        return `<option value="include" ${x.action === "include" ? "selected" : ""}>Incluir en fórmula</option>
                <option value="skip" ${x.action === "skip" ? "selected" : ""}>Omitir</option>`;
      }
      if (x.status === "FALTANTE") {
        return `<option value="create_mp" ${x.action === "create_mp" ? "selected" : ""}>Crear como MP e incluir</option>
                <option value="create_me" ${x.action === "create_me" ? "selected" : ""}>Crear como ME e incluir</option>
                <option value="skip" ${x.action === "skip" ? "selected" : ""}>Omitir</option>`;
      }
      if (x.status === "NO_MATERIAL") {
        return `<option value="skip" ${x.action === "skip" ? "selected" : ""}>Omitir (recomendado)</option>
                <option value="create_mp" ${x.action === "create_mp" ? "selected" : ""}>Crear como MP e incluir</option>
                <option value="create_me" ${x.action === "create_me" ? "selected" : ""}>Crear como ME e incluir</option>`;
      }
      return `<option value="sum" ${x.action === "sum" ? "selected" : ""}>Sumar cantidad al código</option>
              <option value="skip" ${x.action === "skip" ? "selected" : ""}>Omitir repetido</option>`;
    };

    d.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <div>
          <h2 style="margin:0">Validar Fórmula · ${esc(sku.name)}</h2>
          <div class="hint">Archivo: <strong>${esc(meta.fileName)}</strong> · ${analyzed.length} líneas detectadas${nonMatCount ? ` · ${nonMatCount} de MO/Carga Fabril filtradas` : ""}</div>
        </div>
        <button type="button" class="btn-sm" id="bm_back">Cambiar archivo</button>
      </div>

      <div class="kpi-grid" style="margin-bottom:12px">
        <div class="kpi-card"><div class="kpi-label">Insumos a Cargar</div><div class="kpi-val">${activeItems.length}</div><div class="kpi-sub">${newMatsCount ? `${newMatsCount} nuevo(s) al catálogo` : "Todos existen en catálogo ✓"}</div></div>
        <div class="kpi-card ${massOk ? "ok" : "warn"}"><div class="kpi-label">Balance Masa MP</div><div class="kpi-val">${fmt(estKg, 2)} kg</div><div class="kpi-sub">Lote SKU: ${fmt(sku.batch_size_kg, 0)} kg · ${massOk ? "OK ✓" : "Revisar lote o cantidades"}</div></div>
        <div class="kpi-card accent">
          <div class="kpi-label">Modo de Carga</div>
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px;font-size:.83rem">
            <label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:600"><input type="radio" name="bm_mode" value="replace" ${mode === "replace" ? "checked" : ""}> Reemplazar receta actual</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:600"><input type="radio" name="bm_mode" value="merge" ${mode === "merge" ? "checked" : ""}> Combinar con receta actual</label>
          </div>
        </div>
      </div>

      <div class="tablebox" style="max-height:44vh;overflow-y:auto"><table class="mrp-table">
        <thead><tr>
          <th>Fila</th><th>Estado</th><th>Código</th><th>Descripción en Archivo</th><th class="num">Cantidad / Lote</th><th>UM</th><th>Acción</th>
        </tr></thead>
        <tbody>
          ${analyzed.map(x => `<tr>
            <td class="hint">#${x.it.rowNum}</td>
            <td>${badgeFor(x.status)}</td>
            <td><code>${esc(x.it.code)}</code></td>
            <td>
              <strong>${esc(x.it.name)}</strong>
              ${x.note ? `<div class="hint">${esc(x.note)}</div>` : ""}
            </td>
            <td class="num"><strong>${fmt(x.it.qty, 3)}</strong></td>
            <td>${esc(x.existing ? x.existing.um : (x.it.rawUm || "—"))}</td>
            <td><select class="bulk-sel" data-bmidx="${x.idx}">${actionOptions(x)}</select></td>
          </tr>`).join("")}
        </tbody>
      </table></div>

      <div class="err" id="bm_save_err"></div>
      <div class="bar" style="margin-top:14px">
        <button type="button" class="primary" id="bm_apply" ${activeItems.length === 0 ? "disabled" : ""}>Cargar ${activeItems.length} Insumo(s) a la Fórmula</button>
        <button type="button" id="bm_cls2" style="margin-left:auto">Cancelar</button>
      </div>`;

    $("#bm_cls2").onclick = closeDlg;
    $("#bm_back").onclick = renderUploadStep;
    d.querySelectorAll("input[name=bm_mode]").forEach(r => r.onchange = () => { mode = r.value; });
    d.querySelectorAll("[data-bmidx]").forEach(sel => {
      sel.onchange = () => {
        analyzed[Number(sel.dataset.bmidx)].action = sel.value;
        renderReviewStep();
      };
    });

    $("#bm_apply").onclick = async () => {
      const btn = $("#bm_apply");
      btn.disabled = true; btn.textContent = "Guardando en Supabase…";
      $("#bm_save_err").textContent = "";
      try {
        const now = new Date().toISOString();
        const newMats = [];
        const qtyByMat = new Map();

        for (const x of analyzed) {
          if (x.action === "skip") continue;
          const c = x.it.code;
          if (!STATE.materials.has(c) && (x.action === "create_mp" || x.action === "create_me")) {
            const rec = {
              code: c,
              name: x.it.name,
              um: x.it.um || "Kg",
              type: x.action === "create_me" ? "ME" : "MP",
              lead_time: 3, moq: 1, rounding: 1, safety_pct: 0.2,
              stock: 0, cost: 0, prev_cost: 0, updated_at: now
            };
            newMats.push(rec);
            STATE.materials.set(c, rec);
          }
          if (STATE.materials.has(c)) {
            qtyByMat.set(c, (qtyByMat.get(c) || 0) + x.it.qty);
          }
        }

        // 1. Crear materiales faltantes si el usuario los aprobó
        if (newMats.length) {
          await batchUpsert("mrp_materiales", newMats, "code");
        }

        // 2. Si es modo Reemplazar, limpiar ingredientes previos del SKU
        if (mode === "replace") {
          const { error: delErr } = await sb.from("mrp_bom").delete().eq("sku_code", sku.code);
          if (delErr) throw delErr;
        }

        // 3. Guardar líneas de receta
        const bomRows = [...qtyByMat.entries()].map(([mat_code, qty_per_batch]) => ({
          sku_code: sku.code,
          mat_code,
          qty_per_batch
        }));
        if (bomRows.length) {
          await batchUpsert("mrp_bom", bomRows, "sku_code,mat_code");
        }

        // 4. Actualizar estado local
        if (mode === "replace") {
          STATE.bom.set(sku.code, bomRows.map(b => ({ mat_code: b.mat_code, qty_per_batch: b.qty_per_batch })));
        } else {
          const curArr = STATE.bom.get(sku.code) || [];
          const mapCur = new Map(curArr.map(i => [i.mat_code, i.qty_per_batch]));
          for (const b of bomRows) mapCur.set(b.mat_code, b.qty_per_batch);
          STATE.bom.set(sku.code, [...mapCur.entries()].map(([mat_code, qty_per_batch]) => ({ mat_code, qty_per_batch })));
        }

        closeDlg();
        toast(`Fórmula cargada: ${bomRows.length} insumo(s)${newMats.length ? ` (${newMats.length} creado(s) en catálogo)` : ""}.`);
        if (onDone) onDone(); else renderView();
      } catch (err) {
        console.error(err);
        $("#bm_save_err").textContent = "Error al guardar en Supabase: " + (err.message || err);
        btn.disabled = false;
        btn.textContent = "Reintentar";
      }
    };
  };

  renderUploadStep();
  d.showModal();
}

function openNewSkuModal() {
  const d = $("#dlg");
  d.innerHTML = `<form id="sf_new" autocomplete="off">
    <h2>Nueva Fórmula (Producto Terminado)</h2>
    <div class="row">
      <label>Código SKU *<input type="text" name="code" required placeholder="Ej. 124099"></label>
      <label>Categoría *<input type="text" name="category" required placeholder="Ej. KETCHUP"></label>
    </div>
    <label>Descripción del Producto *<input type="text" name="name" required placeholder="Ej. KETCHUP 12X397 GRS"></label>
    <div class="row">
      <label>Unidades / Caja<input type="number" step="1" min="1" name="uc" value="12"></label>
      <label>Peso Neto / Caja (Kg)<input type="number" step="any" min="0.01" name="pw" value="4.8"></label>
    </div>
    <div class="row">
      <label>Tamaño Lote (Kg)<input type="number" step="any" min="1" name="bk" value="1000"></label>
      <label>Rendimiento (%)<input type="number" step="any" min="1" max="100" name="yp" value="98"></label>
    </div>
    <div class="err" id="s_err"></div>
    <div class="bar"><button class="primary" type="submit">Crear Fórmula</button><button type="button" id="s_cls">Cancelar</button></div>
  </form>`;
  d.showModal();
  $("#s_cls").onclick = () => d.close();
  $("#sf_new").onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const code = f.code.value.trim(), name = f.name.value.trim(), category = f.category.value.trim().toUpperCase();
    if (!code || !name || !category) return $("#s_err").textContent = "Complete los campos obligatorios.";
    if (STATE.skus.has(code)) return $("#s_err").textContent = "Ese código SKU ya existe.";
    const pw = Math.max(0.001, num(f.pw.value)), bk = Math.max(1, num(f.bk.value)), yp = Math.max(1, Math.min(100, num(f.yp.value)));
    const rec = { code, name, category, units_per_case: Math.max(1, num(f.uc.value)), net_weight_per_case: pw, batch_size_kg: bk, yield_pct: yp, batch_size_cases: (bk / pw) * (yp / 100) };
    const { error } = await sb.from("mrp_skus").insert(rec);
    if (error) return $("#s_err").textContent = error.message;
    STATE.skus.set(code, rec);
    STATE.bom.set(code, []);
    STATE.selectedSku = code;
    d.close();
    toast("Fórmula creada.");
    renderView();
  };
}

function openDuplicateSkuModal(src) {
  const d = $("#dlg");
  d.innerHTML = `<form id="sf_dup" autocomplete="off">
    <h2>Duplicar Fórmula</h2>
    <p class="hint" style="margin:0 0 12px">Copiando ingredientes de <strong>${esc(src.name)}</strong></p>
    <div class="row">
      <label>Nuevo Código SKU *<input type="text" name="code" required value="${esc(src.code)}-COPIA"></label>
      <label>Categoría *<input type="text" name="category" required value="${esc(src.category)}"></label>
    </div>
    <label>Nueva Descripción *<input type="text" name="name" required value="${esc(src.name)} (Copia)"></label>
    <div class="err" id="sd_err"></div>
    <div class="bar"><button class="primary" type="submit">Duplicar</button><button type="button" id="sd_cls">Cancelar</button></div>
  </form>`;
  d.showModal();
  $("#sd_cls").onclick = () => d.close();
  $("#sf_dup").onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const code = f.code.value.trim(), name = f.name.value.trim(), category = f.category.value.trim().toUpperCase();
    if (!code || !name) return $("#sd_err").textContent = "Complete código y nombre.";
    if (STATE.skus.has(code)) return $("#sd_err").textContent = "Ese código SKU ya existe.";
    const rec = { ...src, code, name, category, updated_at: new Date().toISOString() };
    const { error: e1 } = await sb.from("mrp_skus").insert(rec);
    if (e1) return $("#sd_err").textContent = e1.message;
    const srcBom = (STATE.bom.get(src.code) || []).map(x => ({ sku_code: code, mat_code: x.mat_code, qty_per_batch: x.qty_per_batch }));
    if (srcBom.length) {
      const { error: e2 } = await sb.from("mrp_bom").insert(srcBom);
      if (e2) return $("#sd_err").textContent = e2.message;
    }
    STATE.skus.set(code, rec);
    STATE.bom.set(code, srcBom);
    STATE.selectedSku = code;
    d.close();
    toast("Fórmula duplicada correctamente.");
    renderView();
  };
}

function openDeleteSkuModal(sku) {
  const d = $("#dlg");
  d.innerHTML = `<h2>Eliminar Fórmula</h2>
    <p>¿Qué desea hacer con <strong>${esc(sku.name)}</strong> (<code>${esc(sku.code)}</code>)?</p>
    <div class="bar" style="margin-top:16px">
      <button type="button" id="del_bom_only">Vaciar solo ingredientes</button>
      <button type="button" id="del_sku_all" class="btn-danger">Eliminar SKU y su fórmula</button>
      <button type="button" id="del_cancel" style="margin-left:auto">Cancelar</button>
    </div>`;
  d.showModal();
  $("#del_cancel").onclick = () => d.close();
  $("#del_bom_only").onclick = async () => {
    const { error } = await sb.from("mrp_bom").delete().eq("sku_code", sku.code);
    if (error) return toast(error.message, true);
    STATE.bom.set(sku.code, []);
    d.close();
    toast("Ingredientes eliminados.");
    renderView();
  };
  $("#del_sku_all").onclick = async () => {
    const { error } = await sb.from("mrp_skus").delete().eq("code", sku.code);
    if (error) return toast(error.message, true);
    STATE.skus.delete(sku.code);
    STATE.bom.delete(sku.code);
    STATE.planItems.delete(sku.code);
    STATE.selectedSku = [...STATE.skus.keys()][0] || null;
    d.close();
    toast("SKU eliminado de Supabase.");
    renderView();
  };
}

// -------------------- HISTORIAL DE PLANIFICACIONES (VER / RENOMBRAR / ELIMINAR) --------------------
$("#btn_hist_planes").onclick = () => openPlanHistoryModal();

function openPlanHistoryModal() {
  const d = $("#dlg");
  const paintHist = () => {
    d.innerHTML = `
      <h2>Historial de Planificaciones</h2>
      <p class="hint" style="margin:0 0 12px">Cambie de período, renombre o elimine planificaciones que ya no desee ver. Al eliminar un plan se borran sus cantidades y compras asociadas, pero su catálogo de insumos, costos y fórmulas permanecen intactos.</p>
      <div class="tablebox"><table class="mrp-table">
        <thead><tr><th>Nombre del Plan</th><th>Creado</th><th>Estado</th><th>Acciones</th></tr></thead>
        <tbody>
          ${STATE.planes.map(p => {
            const isAct = p.id === STATE.activePlanId;
            return `<tr data-pid="${esc(p.id)}">
              <td><strong>${esc(p.name)}</strong></td>
              <td class="hint">${p.created_at ? new Date(p.created_at).toLocaleDateString("es-VE") : "—"}</td>
              <td>${isAct ? `<span class="badge ok">ACTIVO</span>` : `<span class="hint">Guardado</span>`}</td>
              <td style="white-space:nowrap">
                ${isAct ? "" : `<button class="btn-sm primary" data-openp="${esc(p.id)}">Abrir</button>`}
                <button class="btn-sm" data-renp="${esc(p.id)}">Renombrar</button>
                <button class="btn-sm btn-danger" data-delp="${esc(p.id)}">Eliminar</button>
              </td>
            </tr>`;
          }).join("") || `<tr><td colspan="4" class="hint" style="text-align:center;padding:16px">No hay planificaciones registradas.</td></tr>`}
        </tbody>
      </table></div>
      <div class="bar" style="margin-top:14px">
        <button type="button" class="primary" id="hp_new">+ Nueva Planificación</button>
        <button type="button" id="hp_cls" style="margin-left:auto">Cerrar</button>
      </div>`;

    $("#hp_cls").onclick = () => d.close();
    $("#hp_new").onclick = () => { d.close(); $("#btn_new_plan").click(); };

    d.querySelectorAll("[data-openp]").forEach(btn => {
      btn.onclick = async () => {
        STATE.activePlanId = btn.dataset.openp;
        renderPlanSelector();
        setSync("saving", "Cargando plan…");
        await loadPlanData(STATE.activePlanId);
        setSync("ok");
        d.close();
        toast("Planificación cargada.");
      };
    });

    d.querySelectorAll("[data-renp]").forEach(btn => {
      btn.onclick = async () => {
        const p = STATE.planes.find(x => x.id === btn.dataset.renp);
        if (!p) return;
        const nuevo = prompt("Nuevo nombre para la planificación:", p.name);
        if (!nuevo || !nuevo.trim() || nuevo.trim() === p.name) return;
        const { error } = await sb.from("mrp_planes").update({ name: nuevo.trim(), updated_at: new Date().toISOString() }).eq("id", p.id);
        if (error) return toast("Error al renombrar: " + error.message, true);
        p.name = nuevo.trim();
        renderPlanSelector();
        toast("Nombre actualizado.");
        paintHist();
      };
    });

    d.querySelectorAll("[data-delp]").forEach(btn => {
      btn.onclick = async () => {
        const p = STATE.planes.find(x => x.id === btn.dataset.delp);
        if (!p) return;
        if (!confirm(`¿Eliminar permanentemente la planificación "${p.name}"?

Sus fórmulas, catálogo de insumos y costos NO se borrarán.`)) return;
        const { error } = await sb.from("mrp_planes").delete().eq("id", p.id);
        if (error) return toast("Error al eliminar: " + error.message, true);
        STATE.planes = STATE.planes.filter(x => x.id !== p.id);
        if (!STATE.planes.length) {
          const { data: created, error: e2 } = await sb.from("mrp_planes").insert({
            name: "Planificación " + new Date().toISOString().slice(0, 7),
            is_active: true
          }).select().single();
          if (!e2 && created) STATE.planes = [created];
        }
        if (STATE.activePlanId === p.id && STATE.planes.length) {
          STATE.activePlanId = STATE.planes[0].id;
          await loadPlanData(STATE.activePlanId);
        }
        renderPlanSelector();
        toast(`Planificación "${p.name}" eliminada.`);
        paintHist();
      };
    });
  };
  paintHist();
  d.showModal();
}

// -------------------- NUEVA PLANIFICACIÓN --------------------
$("#btn_new_plan").onclick = () => {
  const d = $("#dlg");
  const nextLabel = "Planificación " + new Date().toISOString().slice(0, 7);
  d.innerHTML = `<form id="pf_new" autocomplete="off">
    <h2>Comenzar Nueva Planificación</h2>
    <p class="hint" style="margin:0 0 12px">Crea un nuevo período mensual en Supabase conservando intacto su catálogo de insumos, últimos costos y fórmulas.</p>
    <label>Nombre del Período *<input type="text" name="name" required value="${esc(nextLabel)}" placeholder="Ej. Diciembre 2026"></label>
    <div class="err" id="p_err"></div>
    <div class="bar"><button class="primary" type="submit">Crear Plan Mensual</button><button type="button" id="p_cls">Cancelar</button></div>
  </form>`;
  d.showModal();
  $("#p_cls").onclick = () => d.close();
  $("#pf_new").onsubmit = async e => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return $("#p_err").textContent = "Escriba un nombre.";
    const { data, error } = await sb.from("mrp_planes").insert({ name, is_active: true }).select().single();
    if (error) return $("#p_err").textContent = error.message;
    STATE.planes.unshift(data);
    STATE.activePlanId = data.id;
    renderPlanSelector();
    await loadPlanData(data.id);
    d.close();
    toast(`Nuevo plan "${name}" creado.`);
  };
};

// -------------------- IMPORTACIÓN EXCEL (.XLSX) HACIA SUPABASE --------------------
$("#inp_xlsx").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  setSync("saving", "Importando Excel…");
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheets = wb.SheetNames;
    const isAppExport = sheets.includes("Analisis_MRP") && sheets.includes("Formulas_BOM");
    const parsed = isAppExport ? parseAppExport(wb) : parseOriginalExcel(wb);

    if (!parsed.materials.length && !parsed.skus.length) {
      throw new Error("No se encontraron hojas reconocidas (ANALISIS / PLAN MES / F.* o exportación MRP).");
    }

    await batchUpsert("mrp_materiales", parsed.materials, "code");
    await batchUpsert("mrp_skus", parsed.skus, "code");
    if (parsed.bom.length) await batchUpsert("mrp_bom", parsed.bom, "sku_code,mat_code");
    if (parsed.planItems.length) {
      const piRows = parsed.planItems.map(x => ({ ...x, plan_id: STATE.activePlanId }));
      await batchUpsert("mrp_plan_items", piRows, "plan_id,sku_code");
    }
    if (parsed.compras.length) {
      const cRows = parsed.compras.map(x => ({ ...x, plan_id: STATE.activePlanId }));
      await batchUpsert("mrp_compras", cRows, "plan_id,mat_code");
    }

    await loadAll();
    toast(`Importación exitosa: ${parsed.materials.length} insumos, ${parsed.skus.length} SKUs y ${parsed.bom.length} líneas de receta.`);
  } catch (err) {
    console.error(err);
    setSync("err");
    toast("Error al importar Excel: " + (err.message || err), true);
  }
};

function cleanNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    if (v.startsWith("#")) return 0;
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseOriginalExcel(wb) {
  const matMap = new Map(), skuMap = new Map(), bomMap = new Map(), planMap = new Map(), compMap = new Map();

  if (wb.SheetNames.includes("ANALISIS")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["ANALISIS"], { header: 1, defval: null });
    for (let i = 3; i < rows.length; i++) {
      const r = rows[i];
      const code = r[0] != null ? String(r[0]).trim() : "";
      const name = r[1] != null ? String(r[1]).trim() : "";
      const type = r[3] != null ? String(r[3]).trim().toUpperCase() : "";
      if (!code || !name || !["MP", "ME"].includes(type)) continue;
      matMap.set(code, {
        code, name, um: String(r[2] || "Kg").trim(), type,
        lead_time: cleanNum(r[4]) || 3, moq: cleanNum(r[5]) || 1,
        rounding: cleanNum(r[6]) || 1, safety_pct: cleanNum(r[7]) || 0.2,
        stock: cleanNum(r[8]), cost: cleanNum(r[22]), prev_cost: 0
      });
      const dec = cleanNum(r[15]);
      if (dec > 0 || r[16] || r[17]) {
        compMap.set(code, { mat_code: code, decision_qty: dec, provider: String(r[16] || "").trim(), oc: String(r[17] || "").trim(), w1: 0, w2: 0, w3: 0, w4: 0, w5: 0 });
      }
    }
  }

  if (wb.SheetNames.includes("INVENTARIO")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["INVENTARIO"], { header: 1, defval: null });
    for (let i = 4; i < rows.length; i++) {
      const r = rows[i];
      const code = r[0] != null ? String(r[0]).trim() : "";
      if (code && matMap.has(code)) matMap.get(code).stock = cleanNum(r[3]);
    }
  }

  if (wb.SheetNames.includes("AGREGAR COSTOS")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["AGREGAR COSTOS"], { header: 1, defval: null });
    for (let i = 5; i < rows.length; i++) {
      const r = rows[i];
      const code = r[0] != null ? String(r[0]).trim() : "";
      if (code && matMap.has(code)) {
        const c = cleanNum(r[3]), pc = cleanNum(r[5]);
        if (c > 0) matMap.get(code).cost = c;
        if (pc > 0) matMap.get(code).prev_cost = pc;
      }
    }
  }

  for (const sName of wb.SheetNames) {
    if (!sName.startsWith("F.") || sName.includes("Despulpado") || sName.includes("Base")) continue;
    const cat = sName.replace(/^F\.\s*/i, "").trim().toUpperCase();
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sName], { header: 1, defval: null });
    let codRow = -1;
    for (let r = 0; r < Math.min(15, rows.length); r++) {
      if (String(rows[r]?.[2] || "").trim().toUpperCase().startsWith("CODIGO")) { codRow = r; break; }
    }
    if (codRow < 0) continue;
    const maxCol = (rows[codRow] || []).length;
    for (let c = 3; c < maxCol; c++) {
      const code = rows[codRow]?.[c] != null ? String(rows[codRow][c]).trim() : "";
      const name = rows[codRow + 1]?.[c] != null ? String(rows[codRow + 1][c]).trim() : "";
      if (!code || !name || name === "0" || code === "0") continue;
      const uc = cleanNum(rows[codRow + 2]?.[c]) || 12;
      const pw = cleanNum(rows[codRow + 3]?.[c]) || 1;
      const bk = cleanNum(rows[codRow + 6]?.[c]) || 1000;
      const bc = cleanNum(rows[codRow + 7]?.[c]) || (bk / pw);
      const yp = pw > 0 && bk > 0 ? Math.min(100, Math.round(((bc * pw) / bk) * 1000) / 10) : 98;
      skuMap.set(code, { code, name, category: cat, units_per_case: uc, net_weight_per_case: pw, batch_size_kg: bk, yield_pct: yp || 98, batch_size_cases: bc });

      for (let r = codRow + 10; r < rows.length - 1; r++) {
        const mCode = rows[r]?.[0] != null ? String(rows[r][0]).trim() : "";
        const qty = cleanNum(rows[r]?.[c]);
        if (mCode && qty > 0 && matMap.has(mCode)) {
          bomMap.set(`${code}__${mCode}`, { sku_code: code, mat_code: mCode, qty_per_batch: qty });
        }
      }
    }
  }

  if (wb.SheetNames.includes("PLAN MES")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["PLAN MES"], { header: 1, defval: null });
    for (let i = 6; i < rows.length; i++) {
      const r = rows[i];
      const code = r[1] != null ? String(r[1]).trim() : "";
      if (!code || !skuMap.has(code)) continue;
      const fc = cleanNum(r[8]), pq = cleanNum(r[9]);
      const w1 = cleanNum(r[12]), w2 = cleanNum(r[13]), w3 = cleanNum(r[14]), w4 = cleanNum(r[15]), w5 = cleanNum(r[16]);
      if (fc > 0 || pq > 0 || w1 + w2 + w3 + w4 + w5 > 0) {
        planMap.set(code, { sku_code: code, forecast: fc, plan_qty: pq, w1, w2, w3, w4, w5 });
      }
    }
  }

  return {
    materials: [...matMap.values()],
    skus: [...skuMap.values()],
    bom: [...bomMap.values()],
    planItems: [...planMap.values()],
    compras: [...compMap.values()]
  };
}

function parseAppExport(wb) {
  const matMap = new Map(), skuMap = new Map(), bomMap = new Map(), planMap = new Map(), compMap = new Map();
  const costRows = wb.SheetNames.includes("Costos_Compra") ? XLSX.utils.sheet_to_json(wb.Sheets["Costos_Compra"]) : [];
  const costByCode = new Map(costRows.map(r => [String(r.Codigo || "").trim(), { cost: cleanNum(r.Ultimo_Costo_USD), prev: cleanNum(r.Costo_Anterior_USD) }]));

  XLSX.utils.sheet_to_json(wb.Sheets["Analisis_MRP"]).forEach(r => {
    const code = String(r.Codigo || "").trim();
    if (!code) return;
    const ci = costByCode.get(code) || { cost: cleanNum(r.Costo_Unit_USD), prev: 0 };
    matMap.set(code, {
      code, name: String(r.Descripcion || code).trim(), um: String(r.UM || "Kg").trim(),
      type: String(r.Tipo || "MP").toUpperCase() === "ME" ? "ME" : "MP",
      lead_time: cleanNum(r.Lead_Time) || 3, moq: cleanNum(r.MOQ) || 1,
      rounding: cleanNum(r.Redondeo) || 1, safety_pct: cleanNum(r.Stock_Seguridad_Pct) / 100 || 0.2,
      stock: cleanNum(r.Stock_Disponible), cost: ci.cost, prev_cost: ci.prev
    });
    if (cleanNum(r.Decision_Compra) > 0 || r.Proveedor || r.OC) {
      compMap.set(code, { mat_code: code, decision_qty: cleanNum(r.Decision_Compra), provider: String(r.Proveedor || ""), oc: String(r.OC || ""), w1: 0, w2: 0, w3: 0, w4: 0, w5: 0 });
    }
  });

  if (wb.SheetNames.includes("Plan_Produccion")) {
    XLSX.utils.sheet_to_json(wb.Sheets["Plan_Produccion"]).forEach(r => {
      const code = String(r.Codigo || "").trim();
      if (!code) return;
      skuMap.set(code, {
        code, name: String(r.SKU || code).trim(), category: String(r.Categoria || "GENERAL").trim().toUpperCase(),
        units_per_case: cleanNum(r.Unds_Caja) || 12, net_weight_per_case: cleanNum(r.Peso_Caja_Kg) || 1,
        batch_size_kg: cleanNum(r.Lote_Kg) || 1000, yield_pct: cleanNum(r.Rendimiento_Pct) || 98,
        batch_size_cases: cleanNum(r.Lote_Cajas) || 100
      });
      planMap.set(code, {
        sku_code: code, forecast: cleanNum(r.Forecast), plan_qty: cleanNum(r.Plan_Mes),
        w1: cleanNum(r.Sem_1), w2: cleanNum(r.Sem_2), w3: cleanNum(r.Sem_3), w4: cleanNum(r.Sem_4), w5: cleanNum(r.Sem_5)
      });
    });
  }

  XLSX.utils.sheet_to_json(wb.Sheets["Formulas_BOM"]).forEach(r => {
    const s = String(r.Codigo_SKU || "").trim(), m = String(r.Codigo_Insumo || "").trim(), q = cleanNum(r.Cant_Por_Lote);
    if (s && m && q > 0 && skuMap.has(s) && matMap.has(m)) bomMap.set(`${s}__${m}`, { sku_code: s, mat_code: m, qty_per_batch: q });
  });

  return { materials: [...matMap.values()], skus: [...skuMap.values()], bom: [...bomMap.values()], planItems: [...planMap.values()], compras: [...compMap.values()] };
}

// -------------------- EXPORTACIÓN COMPLETA EXCEL (.XLSX) DE 6 HOJAS --------------------
$("#btn_export").onclick = () => {
  const mrp = computeMrp();
  const wb = XLSX.utils.book_new();
  const planName = STATE.planes.find(p => p.id === STATE.activePlanId)?.name || "MRP";

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Indicador: "Plan Activo", Valor: planName },
    { Indicador: "Inversión Total (USD)", Valor: Number(mrp.totalInvUsd.toFixed(2)) },
    { Indicador: "Inversión Materia Prima (USD)", Valor: Number(mrp.totalMpUsd.toFixed(2)) },
    { Indicador: "Inversión Material Empaque (USD)", Valor: Number(mrp.totalMeUsd.toFixed(2)) },
    { Indicador: "Total Cajas Planificadas", Valor: mrp.totalCases },
    { Indicador: "Insumos en Déficit", Valor: mrp.deficitCount },
    { Indicador: "Insumos Sin Costo ($0)", Valor: mrp.noCostCount }
  ]), "Resumen_Ejecutivo");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...STATE.skus.values()].map(s => {
    const pi = getPlanItem(s.code);
    return {
      Codigo: s.code, SKU: s.name, Categoria: s.category, Unds_Caja: s.units_per_case,
      Peso_Caja_Kg: s.net_weight_per_case, Lote_Kg: s.batch_size_kg, Rendimiento_Pct: s.yield_pct,
      Lote_Cajas: Number(num(s.batch_size_cases).toFixed(4)), Forecast: num(pi.forecast), Plan_Mes: num(pi.plan_qty),
      Sem_1: num(pi.w1), Sem_2: num(pi.w2), Sem_3: num(pi.w3), Sem_4: num(pi.w4), Sem_5: num(pi.w5)
    };
  })), "Plan_Produccion");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mrp.rows.map(r => ({
    Codigo: r.m.code, Descripcion: r.m.name, UM: r.m.um, Tipo: r.m.type,
    Lead_Time: r.m.lead_time, MOQ: r.m.moq, Redondeo: r.m.rounding, Stock_Seguridad_Pct: Math.round(num(r.m.safety_pct) * 100),
    Stock_Disponible: r.stock, Consumo_Total: Number(r.c.total.toFixed(4)), Diferencia: Number(r.diff.toFixed(4)),
    Propuesta_Sugerida: Number(r.suggested.toFixed(4)), Decision_Compra: r.decision,
    Proveedor: r.comp.provider || "", OC: r.comp.oc || "",
    Stock_Final: Number(r.stockFinal.toFixed(4)), Costo_Unit_USD: r.cost, Inversion_USD: Number(r.invUsd.toFixed(2))
  }))), "Analisis_MRP");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mrp.rows.filter(r => r.decision > 0 || r.c.total > 0).map(r => ({
    Codigo: r.m.code, Descripcion: r.m.name, UM: r.m.um, Decision_Mes: r.decision,
    Compra_S1: num(r.comp.w1), Compra_S2: num(r.comp.w2), Compra_S3: num(r.comp.w3), Compra_S4: num(r.comp.w4), Compra_S5: num(r.comp.w5),
    Inver_S1_USD: Number((num(r.comp.w1) * r.cost).toFixed(2)), Inver_S2_USD: Number((num(r.comp.w2) * r.cost).toFixed(2)),
    Inver_S3_USD: Number((num(r.comp.w3) * r.cost).toFixed(2)), Inver_S4_USD: Number((num(r.comp.w4) * r.cost).toFixed(2)),
    Inver_S5_USD: Number((num(r.comp.w5) * r.cost).toFixed(2))
  }))), "Procura_Semanal");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...STATE.materials.values()].map(m => ({
    Codigo: m.code, Descripcion: m.name, UM: m.um, Tipo: m.type,
    Costo_Anterior_USD: num(m.prev_cost), Ultimo_Costo_USD: num(m.cost),
    Actualizado: m.cost_updated_at || ""
  }))), "Costos_Compra");

  const bomFlat = [];
  for (const [skuCode, items] of STATE.bom.entries()) {
    const s = STATE.skus.get(skuCode);
    for (const it of items) {
      const m = STATE.materials.get(it.mat_code);
      if (s && m) bomFlat.push({ Codigo_SKU: s.code, SKU: s.name, Codigo_Insumo: m.code, Insumo: m.name, UM: m.um, Cant_Por_Lote: it.qty_per_batch });
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bomFlat), "Formulas_BOM");

  XLSX.writeFile(wb, `MRP-${planName.replace(/[^a-zA-Z0-9_-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.xlsx`);
};

boot();
