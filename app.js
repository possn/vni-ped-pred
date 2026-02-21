/* VNI Pediátrica — Predição Precoce
   - Regras transparentes (não-ML) baseadas em marcadores publicados.
   - Dados ficam localmente (localStorage).
*/
'use strict';

const LS_KEY = "vni_pred_v1";
const LS_PWA = "vni_pred_pwa_enabled";
const LS_BASE = "vni_pred_baseurl";
const LS_HISTORY = "vni_pred_history_v1";
const LS_ROUND = "vni_pred_round_v1";

const $ = (id) => document.getElementById(id);

const views = ["calc","result","evidence","settings"];

function setRoute(route){
  views.forEach(v=>{
    const el = $(`view-${v}`);
    if(!el) return;
    el.classList.toggle("hidden", v !== route);
  });

  document.querySelectorAll(".navitem").forEach(b=>{
    b.classList.toggle("active", b.dataset.route === route);
  });
  document.querySelectorAll(".tab").forEach(b=>{
    b.classList.toggle("active", b.dataset.route === route);
  });
}

function safeNum(x){
  if(x === null || x === undefined) return null;
  const s = String(x).trim().replace(",",".");
  if(!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}



function parseFiO2(x){
  const n = safeNum(x);
  if(n === null) return null;
  // allow input in % (e.g., 40) or fraction (0.40)
  if(n > 1.0 && n <= 100) return n / 100;
  return n;
}


function clamp(n, a, b){
  return Math.max(a, Math.min(b, n));
}

function toMonths(ageValue, unit){
  const v = safeNum(ageValue);
  if(v === null) return null;
  if(unit === "days") return v / 30.4375;
  if(unit === "years") return v * 12;
  return v;
}

function calcSF(spo2, fio2){
  const s = safeNum(spo2);
  const f = parseFiO2(fio2);
  if(s === null || f === null || f <= 0) return null;
  return s / f;
}

function pctChange(newV, oldV){
  const a = safeNum(newV), b = safeNum(oldV);
  if(a === null || b === null || b === 0) return null;
  return (a - b) / b * 100;
}

/* ---- RISK MODEL (transparent rules) ----
   Core evidence:
   - SF at 1h cutoff ~193 for early NIV failure (≤6h). Mayordomo-Colunga 2013.
   - Lower RR decrease at 1h and 6h associated with failure. Mayordomo-Colunga 2009/2013.
   - Age <6 months, SF, HR and IPAP at 2h independent predictors (Pons-Òdena 2019).
   - High initial FiO2 / low SF / lack of improvement in tachypnea (Baker 2021).
*/
function computeRisk(d){
  const out = {
    sf0: null, sf1: null,
    drrPct: null, dhrPct: null, dpco2: null,
    oxyCtx: null,
    score: 0,
    tier: "—",
    badge: "—",
    explain: "",
    actions: [],
    summary: "",
    topFactors: [],
    brief: ""
  };

  // red flags => immediate very high
  const operationalCriteria = [
    d.cfHypox, d.cfWork, d.cfHypercap, d.cfIntol
  ].some(Boolean);

  const redFlags = [
    d.rfHemodyn, d.rfGcs, d.rfSecretions, d.rfApnea, d.rfPtx
  ].some(Boolean);

  const factors = [];
  const addFactor = (w, label) => { factors.push({w, label}); };

  // derived
  out.sf0 = calcSF(d.spo2_0, d.fio2_0);
  out.sf1 = calcSF(d.spo2_1, d.fio2_1);

  out.drrPct = (safeNum(d.rr_1) !== null && safeNum(d.rr_0) !== null) ? pctChange(d.rr_1, d.rr_0) : null;
  out.dhrPct = (safeNum(d.hr_1) !== null && safeNum(d.hr_0) !== null) ? pctChange(d.hr_1, d.hr_0) : null;

  const pco2_0 = safeNum(d.pco2_0), pco2_1 = safeNum(d.pco2_1);
  if(pco2_0 !== null && pco2_1 !== null){
    out.dpco2 = pco2_1 - pco2_0; // negative is improvement
  }

  const ageM = toMonths(d.ageValue, d.ageUnit);

  // score components (0–100)
  let score = 0;

  // 1) SF at 1–2 h (heavy weight)
  if(out.sf1 !== null){
    if(out.sf1 < 150) { score += 40; addFactor(40, `SF 1–2 h < 150 (SF=${out.sf1.toFixed(0)})`); }
    else if(out.sf1 < 193) { score += 30; addFactor(30, `SF 1–2 h < 193 (SF=${out.sf1.toFixed(0)})`); }        // evidence-driven threshold
    else if(out.sf1 < 220) { score += 18; addFactor(18, `SF 1–2 h 193–219 (SF=${out.sf1.toFixed(0)})`); }
    else if(out.sf1 < 260) { score += 10; addFactor(10, `SF 1–2 h 220–259 (SF=${out.sf1.toFixed(0)})`); }
    else score += 3;
  } else {
    score += 10; // unknown => conservative
  }

  // 2) Change in RR (expect decrease)
  // note: drrPct is (new-old)/old, so negative is improvement
  if(out.drrPct !== null){
    if(out.drrPct >= 0) { score += 18; addFactor(18, "FR não melhorou / piorou"); }           // no improvement/worse
    else if(out.drrPct > -10) { score += 12; addFactor(12, "Queda de FR < 10%" ); }     // <10% drop
    else if(out.drrPct > -20) score += 7;
    else score += 2;
  } else {
    score += 6;
  }

  // 3) Change in HR (supportive)
  if(out.dhrPct !== null){
    if(out.dhrPct >= 0) score += 10;
    else if(out.dhrPct > -5) score += 7;
    else if(out.dhrPct > -10) score += 4;
    else score += 1;
  } else {
    score += 3;
  }

  // 4) Age risk
  if(ageM !== null){
    if(ageM < 6) { score += 10; addFactor(10, "Idade < 6 meses"); }        // Pons-Òdena 2019; synchrony issues etc.
    else if(ageM < 12) score += 6;
    else score += 2;
  } else {
    score += 4;
  }

  // 5) ARF type / diagnosis
  if(d.arfType === "type1") { score += 10; addFactor(10, "IRA hipoxémica (tipo 1)"); } // Mayordomo 2009: type1 higher failure odds
  if(d.diag === "ards") { score += 12; addFactor(12, "ARDS" ); }
  else if(d.diag === "pneumonia") { score += 8; addFactor(8, "Pneumonia" ); }

  // 6) FiO2 at initiation (proxy severity)
  const fio2_0 = safeNum(d.fio2_0);

  if(fio2_0 !== null){
    if(fio2_0 >= 0.8) score += 8;
    else if(fio2_0 >= 0.6) score += 5;
    else if(fio2_0 >= 0.4) score += 3;
    else score += 1;
  }

  // 7) PRISM (optional)
  const prism = safeNum(d.prism);
  if(prism !== null){
    if(prism >= 10) score += 10;
    else if(prism >= 5) score += 6;
    else if(prism >= 1) score += 3;
  }

  // 8) IPAP at 1–2 h (optional; higher IPAP early associated with failure in one study)
  const ipap = safeNum(d.ipap_1);

  if(ipap !== null){
    if(ipap >= 18) score += 6;
    else if(ipap >= 14) score += 3;
  }

  // 9) pCO2 / pH trend (supportive, not always available)
  const ph0 = safeNum(d.ph_0), ph1 = safeNum(d.ph_1);
  if(out.dpco2 !== null){
    if(out.dpco2 >= 5) score += 6;       // CO2 rising
    else if(out.dpco2 >= 0) score += 3;  // not improving
    else score += 1;
  }
  if(ph0 !== null && ph1 !== null){
    if(ph1 < ph0 - 0.02) score += 4;     // worsening acidosis
    else if(ph1 < ph0 + 0.01) score += 2;
  }

  
  // Contexto de oxigenação (não altera score; interpretação operacional)
  const fio2_1 = parseFiO2(d.fio2_1);
  let oxy = [];
  if(out.sf1 !== null){
    if(out.sf1 < 150) oxy.push("SF muito baixo");
    else if(out.sf1 < 193) oxy.push("SF baixo (<193)");
    else oxy.push("SF aceitável");
  }
  if(fio2_1 !== null){
    if(fio2_1 >= 0.7) oxy.push("FiO₂ alta (≥0.70)");
    else if(fio2_1 >= 0.5) oxy.push("FiO₂ moderada (0.50–0.69)");
    else oxy.push("FiO₂ baixa/moderada (<0.50)");
  }
  out.oxyCtx = oxy.length ? oxy.join(" • ") : null;

// red flags override
  if(redFlags){ score = Math.max(score, 85); addFactor(50, "Red flags clínicas"); }

  out.score = clamp(Math.round(score), 0, 100);

  // tiering (heuristic)
  if(out.score >= 85){
    out.tier = "Muito alto";
    out.badge = "ALTO RISCO";
  } else if(out.score >= 65){
    out.tier = "Alto";
    out.badge = "RISCO ↑";
  } else if(out.score >= 45){
    out.tier = "Intermédio";
    out.badge = "RISCO ↔";
  } else {
    out.tier = "Baixo";
    out.badge = "RISCO ↓";
  }

  // explanations + actions
  const notes = [];
  if(redFlags) notes.push("Há red flags clínicas assinaladas (isto pesa mais do que qualquer score).");
  if(operationalCriteria) notes.push("Critérios operacionais de falência assinalados (gatilhos de escalada).");

  if(out.sf1 !== null && out.sf1 < 193){
    notes.push(`SF a 1–2 h < 193 (SF=${out.sf1.toFixed(0)}): marcador de alto risco de falência precoce em coorte pediátrica.`);
  }
  if(out.drrPct !== null && out.drrPct > -10){
    notes.push("Redução de FR < 10% (ou pior): resposta precoce fraca está associada a falência em estudos prospetivos.");
  }
  if(ageM !== null && ageM < 6){
    notes.push("Idade < 6 meses: maior risco de falência (sincronia/leaks, gravidade).");
  }
  if(d.arfType === "type1") notes.push("IRA hipoxémica (tipo 1): maior risco de falência vs. tipo 2 em coorte pediátrica.");
  if(d.diag === "ards") notes.push("ARDS: associada a maiores taxas de falência.");
  if(prism !== null && prism >= 5) notes.push("PRISM elevado associa-se a falência em várias coortes.");

  out.explain = notes.length ? notes.join(" ") : "Sem sinais fortes de alto risco com os dados fornecidos."

  // action suggestions (generic, non-prescriptive)
  const actions = [];
  if(operationalCriteria) actions.push("Há gatilhos assinalados: definir janela curta de reavaliação e plano de escalada (ex: intubação/VM se deterioração).");
  if(out.score >= 65 || redFlags){
    actions.push("Monitorização contínua e reavaliação frequente (ex: 15–30 min), com plano explícito de escalada.");
    actions.push("Verificar interface/leaks, sincronização, conforto; optimizar IPAP/EPAP conforme objetivo (oxigenação vs ventilação) e tolerância.");
    actions.push("Reavaliar causa reversível e terapêutica específica (broncoespasmo, secreções, fluidos, antibiótico, etc.).");
    actions.push("Considerar precocemente equipa e logística de intubação, sobretudo se SF < 193 a 1–2 h ou deterioração clínica.");
  } else if(out.score >= 45){
    actions.push("Reavaliar resposta nas próximas 30–60 min; confirmar tendência de FR/FC e SF.");
    actions.push("Optimizar interface e parâmetros; documentar critérios de falência e gatilhos de escalada.");
  } else {
    actions.push("Manter VNI com vigilância e reavaliação seriada; confirmar melhoria sustentada de FR/FC e SF.");
  }

  // additional explicit SF suggestion from Mayordomo 2013 discussion
  if(out.sf1 !== null && out.sf1 < 193){
    actions.push("Se não atingir SF ~190 após 1 h de VNI, a necessidade de intubação deve ser ponderada no contexto clínico global.");
  }

  out.actions = actions;

  // summary
  const lines = [];
  lines.push("VNI Pediátrica — Predição precoce (apoio à decisão)");
  lines.push(`Idade: ${ageM !== null ? ageM.toFixed(1) : "?"} meses | IRA: ${d.arfType==="type1"?"Hipoxémica (tipo 1)":"Hipercápnica/hipoventilação (tipo 2)"} | Dx: ${d.diag}`);
  if(prism !== null) lines.push(`PRISM III-24: ${prism}`);
  lines.push(`SF0: ${out.sf0!==null?out.sf0.toFixed(0):"—"} | SF1-2h: ${out.sf1!==null?out.sf1.toFixed(0):"—"} | ΔFR: ${out.drrPct!==null?out.drrPct.toFixed(0)+"%":"—"} | ΔFC: ${out.dhrPct!==null?out.dhrPct.toFixed(0)+"%":"—"}`);
  if(out.dpco2 !== null) lines.push(`ΔpCO2: ${out.dpco2>0?"+":""}${out.dpco2.toFixed(0)} mmHg`);
  lines.push(`Score: ${out.score}/100 | Tier: ${out.tier}`);
  if(redFlags) lines.push("Red flags: SIM");
  out.summary = lines.join("\n");

  factors.sort((a,b)=>b.w-a.w);
  out.topFactors = factors.slice(0,3).map(x=>x.label);

  const briefParts = [];
  if(out.sf1 !== null) briefParts.push(`SF1-2h=${out.sf1.toFixed(0)}`);
  if(out.drrPct !== null) briefParts.push(`ΔFR=${out.drrPct.toFixed(0)}%`);
  if(out.dhrPct !== null) briefParts.push(`ΔFC=${out.dhrPct.toFixed(0)}%`);
  out.brief = briefParts.join(" | ");

  return out;
}

/* ---- UI + state ---- */
function gather(){
  return {
    ageValue: $("ageValue").value,
    ageUnit: $("ageUnit").value,
    arfType: $("arfType").value,
    diag: $("diag").value,
    prism: $("prism").value,

    rfHemodyn: $("rfHemodyn").checked,
    rfGcs: $("rfGcs").checked,
    rfSecretions: $("rfSecretions").checked,
    rfApnea: $("rfApnea").checked,
    rfPtx: $("rfPtx").checked,

    cfHypox: $("cfHypox") ? $("cfHypox").checked : false,
    cfWork: $("cfWork") ? $("cfWork").checked : false,
    cfHypercap: $("cfHypercap") ? $("cfHypercap").checked : false,
    cfIntol: $("cfIntol") ? $("cfIntol").checked : false,

    spo2_0: $("spo2_0").value,
    fio2_0: $("fio2_0").value,
    epap_0: $("epap_0").value,
    rr_0: $("rr_0").value,
    hr_0: $("hr_0").value,
    ph_0: $("ph_0").value,
    pco2_0: $("pco2_0").value,

    spo2_1: $("spo2_1").value,
    fio2_1: $("fio2_1").value,
    rr_1: $("rr_1").value,
    hr_1: $("hr_1").value,
    ipap_1: $("ipap_1").value,
    epap_1: $("epap_1").value,
    ph_1: $("ph_1").value,
    pco2_1: $("pco2_1").value,
  };
}

function fill(d){
  $("ageValue").value = d.ageValue ?? "";
  $("ageUnit").value = d.ageUnit ?? "months";
  $("arfType").value = d.arfType ?? "type2";
  $("diag").value = d.diag ?? "bronchiolitis";
  $("prism").value = d.prism ?? "";

  $("rfHemodyn").checked = !!d.rfHemodyn;
  $("rfGcs").checked = !!d.rfGcs;
  $("rfSecretions").checked = !!d.rfSecretions;
  $("rfApnea").checked = !!d.rfApnea;
  $("rfPtx").checked = !!d.rfPtx;

  if($("cfHypox")) $("cfHypox").checked = !!d.cfHypox;
  if($("cfWork")) $("cfWork").checked = !!d.cfWork;
  if($("cfHypercap")) $("cfHypercap").checked = !!d.cfHypercap;
  if($("cfIntol")) $("cfIntol").checked = !!d.cfIntol;

  ["spo2_0","fio2_0","epap_0","rr_0","hr_0","ph_0","pco2_0","spo2_1","fio2_1","rr_1","hr_1","ipap_1","epap_1","ph_1","pco2_1"].forEach(k=>{
    $(k).value = d[k] ?? "";
  });

  updateAgeHint();
}

function save(d){
  localStorage.setItem(LS_KEY, JSON.stringify({ ...d, savedAt: new Date().toISOString() }));
}

function load(){
  const raw = localStorage.getItem(LS_KEY);
  if(!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}


function loadHistory(){
  const raw = localStorage.getItem(LS_HISTORY);
  if(!raw) return [];
  try{
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  }catch{ return []; }
}

function pushHistory(entry){
  const hist = loadHistory();
  hist.unshift(entry);
  const trimmed = hist.slice(0, 10);
  localStorage.setItem(LS_HISTORY, JSON.stringify(trimmed));
  return trimmed;
}

function renderHistory(){
  const box = $("historyList");
  if(!box) return;
  const hist = loadHistory();
  if(hist.length === 0){
    box.innerHTML = '<div class="muted">Sem histórico ainda.</div>';
    return;
  }
  box.innerHTML = "";
  hist.forEach((h)=>{
    const wrap = document.createElement("div");
    wrap.className = "hitem";

    const meta = document.createElement("div");
    meta.className = "hmeta";
    const l1 = document.createElement("div");
    l1.className = "hline1";
    l1.textContent = `${h.tier} • ${h.score}/100 • ${h.when}`;
    const l2 = document.createElement("div");
    l2.className = "hline2";
    l2.textContent = h.brief;

    meta.appendChild(l1);
    meta.appendChild(l2);

    const btn = document.createElement("button");
    btn.className = "hbtn";
    btn.textContent = "Carregar";
    btn.addEventListener("click", ()=>{
      fill(h.data);
      save(gather());
      setRoute("calc");
      window.scrollTo({top:0, behavior:"smooth"});
    });

    wrap.appendChild(meta);
    wrap.appendChild(btn);
    box.appendChild(wrap);
  });
}


function resetForm(){
  localStorage.removeItem(LS_KEY);
  fill({});
}

function updateAgeHint(){
  const m = toMonths($("ageValue").value, $("ageUnit").value);
  $("ageMonthsHint").textContent = m===null ? "= — meses" : `= ${m.toFixed(1)} meses`;
}

function renderResult(r, d){
  $("sf0").textContent = r.sf0===null ? "—" : r.sf0.toFixed(0);
  $("sf1").textContent = r.sf1===null ? "—" : r.sf1.toFixed(0);
  $("oxyCtx").textContent = r.oxyCtx===null ? "—" : r.oxyCtx;

  $("drr").textContent = r.drrPct===null ? "—" : `${r.drrPct.toFixed(0)}%`;
  $("dhr").textContent = r.dhrPct===null ? "—" : `${r.dhrPct.toFixed(0)}%`;
  if(r.dpco2 === null) $("dpco2").textContent = "—";
  else $("dpco2").textContent = `${r.dpco2>0?"+":""}${r.dpco2.toFixed(0)} mmHg`;

  $("score").textContent = `${r.score}/100`;

  $("riskBadge").textContent = r.badge;
  $("riskLabel").textContent = r.tier;
  $("riskExplain").textContent = r.explain + (r.topFactors && r.topFactors.length ? "  Fatores principais: " + r.topFactors.join("; ") : "");

  // style badge by tier
  const badge = $("riskBadge");
  badge.style.borderColor = "rgba(255,255,255,.08)";
  badge.style.background = "rgba(255,255,255,.06)";
  if(r.tier === "Muito alto"){
    badge.style.borderColor = "rgba(239,68,68,.45)";
    badge.style.background = "rgba(239,68,68,.12)";
  } else if(r.tier === "Alto"){
    badge.style.borderColor = "rgba(245,158,11,.45)";
    badge.style.background = "rgba(245,158,11,.12)";
  } else if(r.tier === "Intermédio"){
    badge.style.borderColor = "rgba(59,130,246,.45)";
    badge.style.background = "rgba(59,130,246,.12)";
  } else if(r.tier === "Baixo"){
    badge.style.borderColor = "rgba(34,197,94,.45)";
    badge.style.background = "rgba(34,197,94,.10)";
  }

  const ul = $("actionsList");
  ul.innerHTML = "";
  r.actions.forEach(a=>{
    const li = document.createElement("li");
    li.textContent = a;
    ul.appendChild(li);
  });

  $("summary").textContent = r.summary;
}

function exportJSON(){
  const d = gather();
  const payload = { ...d, exportedAt: new Date().toISOString(), app: "vni_pred_v1" };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vni_pred_${new Date().toISOString().slice(0,19).replaceAll(":","-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importJSON(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const obj = JSON.parse(String(reader.result || "{}"));
      fill(obj);
      save(gather());
      setPill("Importado.", true);
    }catch{
      alert("JSON inválido.");
    }
  };
  reader.readAsText(file);
}

async function copySummary(){
  const txt = $("summary").textContent || "";
  try{
    await navigator.clipboard.writeText(txt);
    setPill("Resumo copiado.", true);
  }catch{
    alert("Não foi possível copiar automaticamente (permissões do browser).");
  }
}

/* ---- PWA ---- */
function setPill(text, ok){
  const pill = $("pillStatus");
  pill.textContent = text;
  pill.style.borderColor = ok ? "rgba(34,197,94,.35)" : "rgba(255,255,255,.08)";
  pill.style.background = ok ? "rgba(34,197,94,.10)" : "rgba(255,255,255,.03)";
}

async function enableSW(enable){
  if(!("serviceWorker" in navigator)){
    setPill("Service Worker não suportado.", false);
    return;
  }
  if(!enable){
    // unregister all
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r=>r.unregister()));
    localStorage.setItem(LS_PWA, "0");
    setPill("Offline desactivado.", true);
    return;
  }
  try{
    await navigator.serviceWorker.register("sw.js");
    localStorage.setItem(LS_PWA, "1");
    setPill("Offline activo.", true);
  }catch(e){
    console.error(e);
    setPill("Falha ao activar offline.", false);
  }
}

/* ---- base url support for GH Pages subpath ---- */
function applyBase(){
  const base = $("baseUrl").value.trim();
  localStorage.setItem(LS_BASE, base);
  // update manifest start_url/scope dynamically by rewriting link via query param
  // (simple approach: just inform; actual manifest file remains. In GH Pages, keep manifest start_url relative.)
  setPill("Base guardada. Confirma manifest/scope se necessário.", true);
}

/* ---- init ---- */

function setRoundMode(on){
  document.body.classList.toggle("roundMode", !!on);
  localStorage.setItem(LS_ROUND, on ? "1" : "0");
  const t = $("toggleRound");
  if(t) t.checked = !!on;

  // Hide/show selected advanced fields (simple approach)
  const advancedIds = [
    "prism","ph_0","pco2_0","ph_1","pco2_1","ipap_1","epap_0","epap_1"
  ];
  advancedIds.forEach(id=>{
    const el = $(id);
    if(!el) return;
    // hide the containing row
    const row = el.closest(".row");
    if(row) row.style.display = on ? "none" : "";
  });
}

function toggleRoundMode(){
  const on = !(localStorage.getItem(LS_ROUND) === "1");
  setRoundMode(on);
}


function applyPreset(name){
  // Non-identifying example presets to test workflow.
  const presets = {
    bronch: {
      ageValue:"3", ageUnit:"months", arfType:"type2", diag:"bronchiolitis",
      spo2_0:"90", fio2_0:"0.60", epap_0:"6", rr_0:"65", hr_0:"165", pco2_0:"65", ph_0:"7.18",
      spo2_1:"94", fio2_1:"0.45", rr_1:"50", hr_1:"145", ipap_1:"14", epap_1:"7", pco2_1:"55", ph_1:"7.26"
    },
    ards: {
      ageValue:"24", ageUnit:"months", arfType:"type1", diag:"ards",
      spo2_0:"88", fio2_0:"0.80", epap_0:"8", rr_0:"48", hr_0:"170",
      spo2_1:"90", fio2_1:"0.75", rr_1:"46", hr_1:"168", ipap_1:"18", epap_1:"10"
    }
  };
  const p = presets[name];
  if(!p) return;
  fill(p);
  save(gather());
  updateLivePreview();
  setPill("Exemplo carregado.", true);
}

function clearNonID(){
  // reset clinical fields without touching settings
  fill({});
  save(gather());
  updateLivePreview();
  setPill("Campos limpos.", true);
}

function initNav(){
  document.querySelectorAll("[data-route]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      setRoute(btn.dataset.route);
    });
  });
}

function initActions(){
  $("btnCalc").addEventListener("click", ()=>{
    const d = gather();
    save(d);
    const r = computeRisk(d);
    renderResult(r, d);

    const when = new Date().toLocaleString();
    pushHistory({ when, score: r.score, tier: r.tier, brief: r.brief, data: d });
    renderHistory();
  updateLivePreview();

    setRoute("result");
  });

  $("btnReset").addEventListener("click", ()=>{
    if(confirm("Repor formulário e apagar dados locais?")){
      resetForm();
      setPill("Dados limpos.", true);
      setRoute("calc");
    }
  });

  $("btnExport").addEventListener("click", exportJSON);
  const doPrint = ()=>{ setRoute("result"); setTimeout(()=>window.print(), 50); };
  $("btnPrint") && $("btnPrint").addEventListener("click", doPrint);
  $("btnImport").addEventListener("click", ()=> $("fileImport").click());
  $("fileImport").addEventListener("change", (e)=>{
    const f = e.target.files && e.target.files[0];
    if(f) importJSON(f);
    e.target.value = "";
  });

  $("btnCopy").addEventListener("click", copySummary);

  // Presets
  $("btnPresetBronch") && $("btnPresetBronch").addEventListener("click", ()=>applyPreset("bronch"));
  $("btnPresetARDS") && $("btnPresetARDS").addEventListener("click", ()=>applyPreset("ards"));
  $("btnClearNonID") && $("btnClearNonID").addEventListener("click", clearNonID);

  // Round mode toggle
  $("toggleRound") && $("toggleRound").addEventListener("change", (e)=>setRoundMode(e.target.checked));


  // Mobile overflow menu
  const menuBtn = $("btnMenu");
  const menu = $("menuPanel");
  const closeMenu = ()=>{ if(menu){ menu.classList.add("hidden"); menuBtn && menuBtn.setAttribute("aria-expanded","false"); } };
  const toggleMenu = ()=>{ if(!menu) return; const isHidden = menu.classList.contains("hidden"); if(isHidden){ menu.classList.remove("hidden"); menuBtn && menuBtn.setAttribute("aria-expanded","true"); } else { closeMenu(); } };
  menuBtn && menuBtn.addEventListener("click", toggleMenu);
  document.addEventListener("click", (e)=>{ if(!menu || !menuBtn) return; if(menu.contains(e.target) || menuBtn.contains(e.target)) return; closeMenu(); });

  const hook = (id, fn)=>{ const el = $(id); if(el) el.addEventListener("click", ()=>{ closeMenu(); fn(); }); };
  hook("mExport", exportJSON);
  hook("mImport", ()=>$("fileImport").click());
  hook("mPrint", doPrint);
  hook("mReset", ()=>$("btnReset").click());
  hook("mRound", toggleRoundMode);


  $("ageValue").addEventListener("input", updateAgeHint);
  $("ageUnit").addEventListener("change", updateAgeHint);

  $("btnApplyBase").addEventListener("click", applyBase);

  const btnUpdate = $("btnUpdateApp");
  btnUpdate && btnUpdate.addEventListener("click", async ()=>{
    try{
      if("caches" in window){
        const keys = await caches.keys();
        await Promise.all(keys.map(k=>caches.delete(k)));
      }
      if("serviceWorker" in navigator){
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r=>r.unregister()));
      }
      localStorage.setItem(LS_PWA, "0");
      $("togglePwa").checked = false;
      setPill("Cache limpa. Reabre a app.", true);
    }catch(e){
      console.error(e);
      setPill("Falha ao limpar cache.", false);
    }
  });

  $("togglePwa").addEventListener("change", (e)=>{
    enableSW(e.target.checked);
  });
}


let liveTimer = null;

function updateLivePreview(){
  const d = gather();
  const sf0 = calcSF(d.spo2_0, d.fio2_0);
  const sf1 = calcSF(d.spo2_1, d.fio2_1);

  const fio2_1 = parseFiO2(d.fio2_1);
  // EPAP é parâmetro contextual; não é mostrado no banner/preview (ver Evidência).

  let oxy = [];
  if(sf1 !== null){
    if(sf1 < 150) oxy.push("SF muito baixo");
    else if(sf1 < 193) oxy.push("SF baixo (<193)");
    else oxy.push("SF aceitável");
  }
  if(fio2_1 !== null){
    if(fio2_1 >= 0.7) oxy.push("FiO₂ alta");
    else if(fio2_1 >= 0.5) oxy.push("FiO₂ moderada");
    else oxy.push("FiO₂ baixa/moderada");
  }

  if($("liveSf0")) $("liveSf0").textContent = sf0===null ? "—" : sf0.toFixed(0);
  if($("liveSf1")) $("liveSf1").textContent = sf1===null ? "—" : sf1.toFixed(0);
  if($("liveOxy")) $("liveOxy").textContent = oxy.length ? oxy.join(" • ") : "—";
}

function scheduleLive(){
  if(liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(updateLivePreview, 120);
}

function init(){
  initNav();
  initActions();

  const saved = load();
  if(saved) fill(saved);
  else fill({});
  renderHistory();
  updateLivePreview();

  // round mode
  const roundOn = localStorage.getItem(LS_ROUND) === "1";
  setRoundMode(roundOn);

  // pwa toggle state
  const pwaEnabled = localStorage.getItem(LS_PWA) === "1";
  $("togglePwa").checked = pwaEnabled;
  if(pwaEnabled) enableSW(true);
  else setPill("Offline desactivado.", true);

  // base url
  const base = localStorage.getItem(LS_BASE) || "";
  $("baseUrl").value = base;

  setRoute("calc");
}

document.addEventListener("DOMContentLoaded", init);
