#!/usr/bin/env node
"use strict";

const fetch = require("node-fetch");
const express = require("express");
const https = require("https");

// ================= TLS AGENT =================
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// ================= CONFIG =================
const BASE_URL = "https://api-dev.spicbrasil.com.br/mendix";
const TASKS_URL =
  "https://spicpurchaseservice-dev.apps.sa-1a.mendixcloud.com/rest/slataskapi/v1/taskslist_json/WS2855531894";

const TIMEOUT_MS = 30000;
const PORT = 3000;

// ================= NORMALIZE =================
function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// ================= MAPA DE EQUIVALÊNCIA DE ETAPAS (OFICIAL) =================
const etapaAliasMap = new Map([
  // ================= TÉCNICO =================
  ['analise tecnica', 'avaliacao tecnica'],

  // ================= SUPRIMENTOS =================
  ['analysis and data collection and strategy definition', 'definicao de estrategia de compras'],
  ['analysis, data collection and strategy definition', 'definicao de estrategia de compras'],
  ['update project team', 'definicao de estrategia de compras'],
  ['atualizar equipe do projeto', 'definicao de estrategia de compras'],

  ['detail the supply models that will go to the quotation process (rfq)', 'rft'],

  ['award supplier', 'overall'],

  ['fechamento do processo (atualizar o contrato operacional e comunicar as partes)', 'emissao do contrato sap'],
  ['operating contract', 'emissao do contrato sap'],

  // ================= JURÍDICO =================
  ['contract drafting (elaw)', 'elaboracao de minuta'],
  ['elaboracao de contrato (elaw)', 'elaboracao de minuta'],

  ['contrato em aprovacao (elaw)', 'discussao de minuta'],
  ['contrato em discussao juridica (elaw)', 'discussao de minuta'],
  ['discussao de minuta', 'discussao de minuta'],

  ['contrato em assinatura (docusign)', 'assinatura'],
  ['signature agreement (docusign)', 'assinatura'],
  ['contrato em chancela (elaw)', 'assinatura'],
  ['top signed contract', 'assinatura'],
]);

function normalizeEtapa(titulo) {
  const norm = normalize(titulo);

  return etapaAliasMap.get(norm) ?? norm;
}


// ================= CATEGORIAS (INALTERADAS) =================
const categorias = {
  Juridico: {
    slaRef: 3,
    keywords: [
      "Elaboração de Minuta",//1
      "Discussão de Minuta",//1
      "Assinatura",//1
      "Elaboração de Contrato (ELAW)", //1
      "Contrato em Chancela (ELAW)",//1
      "Contrato em discussão Jurídica (ELAW)",//1
      "Contrato em Aprovação (ELAW)",//1
      "Carry out Legal steps (If it is a Contract)"//1
    ].map(normalize),
  },
  Suprimentos: {
    slaRef: 25,
    keywords: [
      "Definição de Estratégia de compras", //2
      "RFT", //12
      "Solicitação de propostas técnicas revisadas", //3
      "Análise Comercial / Negociação", //3
      "Overall", //2
      "Emissão do Contrato SAP", //1
      "Conexão do Fornecedor", //2
      "Analysis and Data Collection and Strategy Definition", //2
      "Finalize Sourcing Project  no Ariba - Mudar o Status do Projeto para Concluído", //1
      "Contrato em Assinatura (Docusign)", //1
      "Evaluate Scenario for Awards", //3
      "Preencher na Capa do Projeto  o campo valor final da negociação",
      "Preencher na Capa do Projeto o campo valor final da negociação", //2
      "Award supplier", //1
      "Top Signed contract", //1
      "Operating Contract", //1
      "Gerar Pedido no Buying - Enviar Cotações ao Sistema Externo", //2
      "Finalização do Projeto", //1
      "Elaborar Plano de Ação", //2
      "Discussão do Plano de Ação", //2
      "Atualizar Equipe do Projeto", //2
      "Preparar Solicitação de Sourcing e Verificar Documentos Adicionais", //2
      "Alternative Procurement Method" //3
    ].map(normalize),
  },
  Tecnico: {
    slaRef: 7,
    keywords: [
      "Avaliação Técnica",
      "Avaliação das propostas técnicas revisadas",
    ].map(normalize),
  },
};

// ================= APP =================
const app = express();
app.use(express.json());

// ================= UTIL =================
function ts() {
  return new Date().toISOString();
}

function makeAbort(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, cancel: () => clearTimeout(t) };
}

function asArray(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;

  if (resp.RequisicaoCompras?.RequisicaoCompra)
    return resp.RequisicaoCompras.RequisicaoCompra;

  for (const v of Object.values(resp)) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      for (const vv of Object.values(v)) {
        if (Array.isArray(vv)) return vv;
      }
    }
  }
  return [];
}

// ================= HTTP =================
async function httpGetJson(url) {
  const { controller, cancel } = makeAbort(TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      agent: httpsAgent,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    cancel();
  }
}

async function httpGetText(url) {
  const { controller, cancel } = makeAbort(TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      agent: httpsAgent,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    cancel();
  }
}

// ================= XML PARSE =================
function getXmlValue(xml, tag) {
  const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(r);
  return m ? m[1].trim() : null;
}

function isXmlNil(xml, tag) {
  return new RegExp(`<${tag}[^>]*xsi:nil="true"`).test(xml);
}

function parseTasksXml(xmlText) {
  const blocks =
    xmlText.match(/<TasksList_Json>[\s\S]*?<\/TasksList_Json>/g) || [];

  return blocks.map(xml => ({
    Title: getXmlValue(xml, "Title"),
    ParentWorkspace_InternalId: getXmlValue(xml, "ParentWorkspace_InternalId"),
    BeginDate: isXmlNil(xml, "BeginDate") ? null : getXmlValue(xml, "BeginDate"),
    EndDateTime: isXmlNil(xml, "EndDateTime")
      ? null
      : getXmlValue(xml, "EndDateTime"),
  }));
}

// ================= SLA BASE (RC – INALTERADO) =================
function isWeekend(d) {
  return d.getDay() === 0 || d.getDay() === 6;
}

function diffBusinessDays(start, end) {
  let count = 0;
  const cur = new Date(start);
  while (cur < end) {
    if (!isWeekend(cur)) count++;
    cur.setDate(cur.getDate() + 1);
  }

  return count;
}

// ================= SLA RC (INALTERADO) =================
function novoResumo() {
  return {
    Juridico: { noPrazo: 0, proximoVencer: 0, vencido: 0 },
    Suprimentos: { noPrazo: 0, proximoVencer: 0, vencido: 0 },
    Tecnico: { noPrazo: 0, proximoVencer: 0, vencido: 0 },
  };
}

function acumular(dest, src) {
  for (const g of Object.keys(dest)) {
    dest[g].noPrazo += src[g].noPrazo;
    dest[g].proximoVencer += src[g].proximoVencer;
    dest[g].vencido += src[g].vencido;
  }
}

function calcularSlaTasks(tasks, filtroEtapa) {
  const resumo = novoResumo();
  const now = new Date();
  const etapaNorm = filtroEtapa ? normalize(filtroEtapa) : null;

  for (const t of tasks) {
    if (!t.BeginDate || t.EndDateTime !== null) continue;
    if (etapaNorm && normalize(t.Title) !== etapaNorm) continue;

    const titulo = normalize(t.Title);

    for (const [grupo, cfg] of Object.entries(categorias)) {
      if (!cfg.keywords.includes(titulo)) continue;

      const dias = diffBusinessDays(new Date(t.BeginDate), now);
      const limite = Math.ceil(cfg.slaRef * 0.8);

      if (dias > cfg.slaRef) resumo[grupo].vencido++;
      else if (dias >= limite) resumo[grupo].proximoVencer++;
      else resumo[grupo].noPrazo++;
    }
  }

  return resumo;
}

async function buildResult(req) {
  const filtroEmail = req.query.user;
  const filtroEtapa = req.query.etapa ? normalize(req.query.etapa) : null;

  // status: em_execucao | em_espera | nao_iniciado | concluido
  function toStatusKey(input) {
    if (input == null) return null;

    let s = normalize(String(input)).trim().toLowerCase();
    s = s.replace(/[\s-]+/g, "_").replace(/_+/g, "_");

    if (s === "em_execucao" || s.includes("execucao")) return "em_execucao";
    if (s === "em_espera" || s.includes("espera")) return "em_espera";
    if (s === "nao_iniciado" || s.replace(/_/g, "") === "naoiniciado") return "nao_iniciado";
    if (s === "concluido" || s.includes("conclu")) return "concluido";
    return null;
  }
  const filtroStatusKey = toStatusKey(req.query.status);

  function asArraySafe(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return [v];
  }

  // ================= WORKFLOW DETECTOR (pra status não errar) =================
  const baseKeywords = Object.values(categorias).flatMap(c => c.keywords);

  const extrasWorkflow = [
    "Preencher na Capa do Projeto o campo valor final da negociação",
    "Preencher na Capa do Projeto  o campo valor final da negociação",
    "Na hora de enviar o e-mail comunicando o início do Contrato, que o Comprador já envia para o Requisitante e Fornecedor deverá ser incluído o e-mail a seguir da Tapfin: spic@tapfin.com.br",
    "Gerar Pedido no Buying - Enviar Cotações ao Sistema Externo",
    "Finalize Sourcing Project  no Ariba - Mudar o Status do Projeto para Concluído",
  ];

  const workflowTitles = new Set([
    ...baseKeywords,
    ...extrasWorkflow.map(t => normalizeEtapa(t)),
  ]);

  // fallback para títulos fora do dicionário (ex.: inglês)
  function isWorkflowTask(title) {
    const n = normalizeEtapa(title || "");
    if (!n) return false;

    if (workflowTitles.has(n)) return true;

    // Se você tiver keywordToGroup disponível aqui, isso ajuda MUITO:
    // (se não tiver, pode remover essa linha)
    if (typeof keywordToGroup !== "undefined" && keywordToGroup?.get?.(n)) return true;

    // fallback por padrões típicos do fluxo
    // (pega Operating Contract, Award supplier, Signed contract, etc.)
    return (
      n.includes("contrato") ||
      n.includes("contract") ||
      n.includes("docusign") ||
      n.includes("elaw") ||
      n.includes("minuta") ||
      n.includes("ariba") ||
      n.includes("sourcing") ||
      n.includes("award") ||
      n.includes("signed")
    );
  }

  function calcularStatusKey(rcTasksAll) {
    const rcTasksWorkflow = (rcTasksAll || []).filter(t => t?.Title && isWorkflowTask(t.Title));

    const naoIniciadas = rcTasksWorkflow.filter(t => !t.BeginDate && !t.EndDateTime);
    const emExecucao = rcTasksWorkflow.filter(t => !!t.BeginDate && !t.EndDateTime);
    const concluidas = rcTasksWorkflow.filter(t => !!t.BeginDate && !!t.EndDateTime);

    // mesma regra do index
    if (rcTasksWorkflow.length === 0 || naoIniciadas.length === rcTasksWorkflow.length) return "nao_iniciado";
    if (emExecucao.length > 0) return "em_execucao";
    if (concluidas.length === rcTasksWorkflow.length) return "concluido";
    return "em_espera";
  }

  // ================= RC =================
  const rcsResp = await httpGetJson(`${BASE_URL}/requisicao`);
  let rcs = asArray(rcsResp);

  if (filtroEmail) {
    const emailNorm = normalize(filtroEmail);
    rcs = rcs.filter(r => normalize(r.EmialOwner) === emailNorm);
  }

  const levelC = rcs.filter(r => r.Level === "C" && r._RequestInternalId);

  // ================= TASKS =================
  const xml = await httpGetText(TASKS_URL);
  const parsed = parseTasksXml(xml);
  const tasks = asArraySafe(parsed?.tasks ?? parsed);

  const map = new Map();
  for (const t of tasks) {
    if (!t?.ParentWorkspace_InternalId) continue;
    if (!map.has(t.ParentWorkspace_InternalId)) map.set(t.ParentWorkspace_InternalId, []);
    map.get(t.ParentWorkspace_InternalId).push(t);
  }

  const slaGlobal = novoResumo();

  for (const rc of levelC) {
    const ws =
      rc.ParentWorkspace_InternalId ||
      rc._RequestInternalId ||
      rc.Workspace_InternalId;

    const rcTasksAll = map.get(ws) || [];

    const statusKey = calcularStatusKey(rcTasksAll);

    // filtro por status (se vier)
    if (filtroStatusKey && statusKey !== filtroStatusKey) continue;

    // regra que você pediu:
    // nao_iniciado => 0 tudo
    // concluido => 0 tudo
    if (statusKey === "nao_iniciado" || statusKey === "concluido" || statusKey === "em_espera") {
      continue;
    }

    // em_execucao => mantém lógica atual
    if (statusKey === "em_execucao") {
      acumular(slaGlobal, calcularSlaTasks(rcTasksAll, filtroEtapa));
      continue;
    }
  }

  const slaResumo = {
    juridico: slaGlobal.Juridico,
    suprimentos: slaGlobal.Suprimentos,
    tecnico: slaGlobal.Tecnico,
  };

  return {
    status: req.query.status,
    data: slaResumo
  };
}

// ================= ENDPOINT RC (INALTERADO) =================
app.get("/mendix/rc", async (req, res) => {
  try {
    res.json(await buildResult(req));
  } catch (e) {
    res.status(500).json({
      error: "Erro ao calcular SLA",
      message: e.message,
    });
  }
});


function matchCategoriaStrict(tituloOriginal) {
  const tituloNorm = normalize(tituloOriginal);

  for (const [grupo, cfg] of Object.entries(categorias)) {
    for (const keywordNorm of cfg.keywords) {
      if (tituloNorm === keywordNorm) {
        return grupo;
      }
    }
  }

  return null;
}

function calcularSlaProcessoPorWs(tasks) {
  const now = new Date();

  const resultado = {
    juridico: { dias: 0, previsto: categorias.Juridico.slaRef },
    suprimentos: { dias: 0, previsto: categorias.Suprimentos.slaRef },
    tecnico: { dias: 0, previsto: categorias.Tecnico.slaRef },
  };

  for (const t of tasks) {
    if (!t.BeginDate) continue;

    const tituloNorm = normalizeEtapa(t.Title);
    const grupo = matchCategoriaStrict(tituloNorm);

    if (!grupo) continue;
    const grupoKey = grupo.toLowerCase();

    const inicio = new Date(t.BeginDate);
    const fim = t.EndDateTime ? new Date(t.EndDateTime) : now;

    let dias = diffBusinessDays(inicio, fim);
    if (dias < 1) dias = 1;

    resultado[grupoKey].dias += dias;
  }

  return resultado;
}

function calcularSlaTotalTodasEtapas(tasksWs) {
  const now = new Date();
  const tasksAll = (tasksWs || []).filter(t => t?.Title);

  // Se existir task sem Begin e sem End, regra: Begin mais antigo -> now
  const hasNullNull = tasksAll.some(t => !t?.BeginDate && !t?.EndDateTime);

  // Achar o BeginDate mais antigo preenchido
  let oldestBegin = null;
  for (const t of tasksAll) {
    if (!t?.BeginDate) continue;

    const d = new Date(t.BeginDate);
    if (isNaN(d)) continue;

    if (!oldestBegin || d < oldestBegin) oldestBegin = d;
  }

  // Se não tem nenhum begin preenchido, não dá pra calcular
  if (!oldestBegin) return 0;

  // ✅ Prioridade máxima: se tiver null/null, calcula do mais antigo até hoje
  if (hasNullNull) {
    return Number(businessDaysClosedInclusive(oldestBegin, now) ?? 0);
  }

  // Caso normal: soma por tarefa
  let total = 0;

  for (const t of tasksAll) {
    if (!t?.BeginDate) continue;

    const begin = new Date(t.BeginDate);
    if (isNaN(begin)) continue;

    if (t?.EndDateTime) {
      const end = new Date(t.EndDateTime);
      if (isNaN(end)) continue;
      total += Number(businessDaysClosedInclusive(begin, end) ?? 0);
    } else {
      total += Number(businessDaysOpenExcludeStart(begin, now) ?? 0);
    }
  }

  return total;
}

function businessDaysClosedInclusive(a, b) {
  if (!a || !b) return 0;

  let start = startOfDay(a);
  let end = startOfDay(b);
  if (end < start) [start, end] = [end, start];

  let days = 0;
  const cur = new Date(start);

  while (cur <= end) {
    if (isBusinessDay(cur)) days++;
    cur.setDate(cur.getDate() + 1);
  }

  return days;
}


function businessDaysOpenExcludeStart(a, b) {
  if (!a || !b) return 0;

  let start = startOfDay(a);
  let end = startOfDay(b);
  if (end < start) [start, end] = [end, start];

  let days = 0;
  const cur = new Date(start);
  cur.setDate(cur.getDate() + 1); // pula o dia do begin

  while (cur <= end) {
    if (isBusinessDay(cur)) days++;
    cur.setDate(cur.getDate() + 1);
  }

  return days;
}

app.get("/mendix/sla-processo", async (req, res) => {
  try {
    const ws = String(req.query.ws || "").trim();
    if (!ws) throw new Error("Parâmetro ?ws é obrigatório");

    // ================= helpers =================
    function asArraySafe(v) {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      return [v];
    }

    function startOfDayUTC(d) {
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }

    // Dias úteis (Seg–Sex) inclusivo
    function businessDaysWeekdaysInclusive(beginDate, endDate) {
      let s = startOfDayUTC(beginDate);
      let e = startOfDayUTC(endDate);
      if (e < s) return 0;

      let count = 0;
      for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
        const dow = d.getUTCDay(); // 0 dom, 6 sáb
        if (dow !== 0 && dow !== 6) count++;
      }
      return count;
    }

    // ✅ MESMO CÁLCULO DO INDEX (SLA total do processo)
    function calcularSlaProcessoAging(tasksWs) {
      const now = new Date();
      const tasksAll = (tasksWs || []).filter(t => t?.Title);

      let oldestBegin = null;
      let latestEnd = null;

      let hasOpen = false;    // begin preenchido, end null
      let hasPending = false; // begin null, end null

      for (const t of tasksAll) {
        const beginNull = !t?.BeginDate;
        const endNull = !t?.EndDateTime;

        if (beginNull && endNull) hasPending = true;
        if (!beginNull && endNull) hasOpen = true;

        if (t?.BeginDate) {
          const b = new Date(t.BeginDate);
          if (!Number.isNaN(b.getTime())) {
            if (!oldestBegin || b < oldestBegin) oldestBegin = b;
          }
        }

        if (t?.EndDateTime) {
          const e = new Date(t.EndDateTime);
          if (!Number.isNaN(e.getTime())) {
            if (!latestEnd || e > latestEnd) latestEnd = e;
          }
        }
      }

      if (!oldestBegin) return 0;

      const end = (hasOpen || hasPending || !latestEnd) ? now : latestEnd;
      return businessDaysWeekdaysInclusive(oldestBegin, end);
    }

    // ================= TASKS =================
    const xml = await httpGetText(TASKS_URL);
    const parsed = parseTasksXml(xml);
    const allTasks = asArraySafe(parsed?.tasks ?? parsed);

    // "procurar a WS": aceita ParentWorkspace_InternalId ou Workspace_InternalId
    const tasksWs = allTasks.filter(t => {
      const p = String(t?.ParentWorkspace_InternalId || "").trim();
      const w = String(t?.Workspace_InternalId || "").trim();
      return p === ws || w === ws;
    });

    // ================= POR GRUPO (mantém sua lógica atual) =================
    const slaPorGrupoCalc = calcularSlaProcessoPorWs(tasksWs);

    // ================= TOTAL (NOVO - MESMO DO INDEX) =================
    const slaTotalProcesso = Number(calcularSlaProcessoAging(tasksWs) ?? 0);

    const slaPorGrupo = [
      {
        Nome: "SLA total do processo",
        dias: slaTotalProcesso,
        previsto:
          categorias.Juridico.slaRef +
          categorias.Suprimentos.slaRef +
          categorias.Tecnico.slaRef,
      },
      {
        Nome: "Suprimentos",
        dias: slaPorGrupoCalc.suprimentos.dias,
        previsto: slaPorGrupoCalc.suprimentos.previsto,
      },
      {
        Nome: "Técnico",
        dias: slaPorGrupoCalc.tecnico.dias,
        previsto: slaPorGrupoCalc.tecnico.previsto,
      },
      {
        Nome: "Jurídico",
        dias: slaPorGrupoCalc.juridico.dias,
        previsto: slaPorGrupoCalc.juridico.previsto,
      },
      {
        Nome: "Governança",
        dias: 0,
        previsto: 0,
      },
    ];

    res.json({ slaPorGrupo });
  } catch (e) {
    res.status(400).json({
      error: "Erro ao calcular SLA do processo",
      message: e.message,
    });
  }
});

const keywordToGroup = new Map();

for (const [GrupoEtapa, cfg] of Object.entries(categorias)) {
  for (const kw of cfg.keywords) {
    keywordToGroup.set(kw, GrupoEtapa); // kw já normalizada
  }
}

async function contarKeywordsTasks(req) {
  const filtroEmail = req.query.user;
  const filtroEtapa = req.query.etapa ? normalize(req.query.etapa) : null;

  // status: em_execucao | em_espera | concluido | nao_iniciado
  function toStatusKey(input) {
    if (input == null) return null;

    let s = normalize(String(input)).trim().toLowerCase();
    s = s.replace(/[\s-]+/g, "_").replace(/_+/g, "_");

    if (s === "em_execucao" || s.includes("execucao")) return "em_execucao";
    if (s === "em_espera" || s.includes("espera")) return "em_espera";
    if (s === "nao_iniciado" || s.replace(/_/g, "") === "naoiniciado") return "nao_iniciado";
    if (s === "concluido" || s.includes("conclu")) return "concluido";

    return null;
  }
  const filtroStatusKey = toStatusKey(req.query.status);

  // ================= helpers =================
  function asArraySafe(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return [v];
  }

  const rcsResp = await httpGetJson(`${BASE_URL}/requisicao`);
  let rcs = asArray(rcsResp);

  if (filtroEmail) {
    const emailNorm = normalize(filtroEmail);
    rcs = rcs.filter(r => normalize(r.EmialOwner) === emailNorm);
  }

  const levelC = rcs.filter(r => r.Level === "C" && r._RequestInternalId);

  const xml = await httpGetText(TASKS_URL);
  const parsed = parseTasksXml(xml);
  const tasks = asArraySafe(parsed?.tasks ?? parsed);

  const map = new Map();
  for (const t of tasks) {
    if (!t?.ParentWorkspace_InternalId) continue;
    if (!map.has(t.ParentWorkspace_InternalId)) map.set(t.ParentWorkspace_InternalId, []);
    map.get(t.ParentWorkspace_InternalId).push(t);
  }

  // ================= WORKFLOW SET (igual no index) =================
  const baseKeywords = Object.values(categorias).flatMap(c => c.keywords);

  const extrasWorkflow = [
    "Preencher na Capa do Projeto o campo valor final da negociação",
    "Preencher na Capa do Projeto  o campo valor final da negociação", // variação com 2 espaços (já vi no seu input)
    "Na hora de enviar o e-mail comunicando o início do Contrato, que o Comprador já envia para o Requisitante e Fornecedor deverá ser incluído o e-mail a seguir da Tapfin: spic@tapfin.com.br",
    "Gerar Pedido no Buying - Enviar Cotações ao Sistema Externo",
    "Finalize Sourcing Project  no Ariba - Mudar o Status do Projeto para Concluído",
  ];

  const workflowTitles = new Set([
    ...baseKeywords,
    ...extrasWorkflow.map(t => normalize(t)),
  ]);

  // contador final
  const contador = {};

  for (const rc of levelC) {
    const ws =
      rc.ParentWorkspace_InternalId ||
      rc._RequestInternalId ||
      rc.Workspace_InternalId;

    const rcTasksAll = map.get(ws) || [];

    // ✅ usa o MESMO universo do index para status/etapa (workflowTitles)
    const rcTasks = rcTasksAll.filter(t => {
      if (!t?.Title) return false;
      return workflowTitles.has(normalize(t.Title));
    });

    // ================= STATUS (igual ao index) =================
    const naoIniciadas = rcTasks.filter(t => !t.BeginDate && !t.EndDateTime);
    const emExecucao = rcTasks.filter(t => !!t.BeginDate && !t.EndDateTime);
    const concluidas = rcTasks.filter(t => !!t.BeginDate && !!t.EndDateTime);

    let statusKey = "nao_iniciado";

    if (rcTasks.length === 0 || naoIniciadas.length === rcTasks.length) {
      statusKey = "nao_iniciado";
    } else if (emExecucao.length > 0) {
      statusKey = "em_execucao";
    } else if (concluidas.length === rcTasks.length) {
      statusKey = "concluido";
    } else {
      statusKey = "em_espera";
    }

    // ================= FILTRO STATUS (igual ao index) =================
    if (!filtroStatusKey) {
      // default: não traz concluído
      if (statusKey === "concluido") continue;
    } else {
      // traz somente o status solicitado
      if (statusKey !== filtroStatusKey) continue;
    }

    // nao iniciado: não conta nada
    if (statusKey === "nao_iniciado") continue;

    // ================= REGRA DE "ETAPA" (igual sua regra do index) =================
    // 1) se existir begin preenchido e end null => etapa atual é essa (se várias, begin mais recente)
    const abertas = rcTasks
      .filter(t => !!t.BeginDate && !t.EndDateTime)
      .slice()
      .sort((a, b) => new Date(b.BeginDate).getTime() - new Date(a.BeginDate).getTime());

    let etapaEscolhida = null;

    if (abertas.length > 0) {
      etapaEscolhida = abertas[0];
    } else {
      // 2) senão, última concluída = EndDateTime mais recente
      const ultConcluida = rcTasks
        .filter(t => !!t.EndDateTime)
        .slice()
        .sort((a, b) => new Date(b.EndDateTime).getTime() - new Date(a.EndDateTime).getTime())[0];

      if (ultConcluida) etapaEscolhida = ultConcluida;
    }

    if (!etapaEscolhida?.Title) continue;

    const etapaNorm = normalize(etapaEscolhida.Title);

    // filtro etapa
    if (filtroEtapa && etapaNorm !== filtroEtapa) continue;

    const GrupoEtapa = keywordToGroup.get(etapaNorm);
    if (!GrupoEtapa) continue;

    const key = `${GrupoEtapa}|${etapaNorm}`;
    if (!contador[key]) {
      contador[key] = {
        NomeEtapa: etapaLabel(etapaEscolhida.Title),
        GrupoEtapa,
        Quantidade: 0,
      };
    }
    contador[key].Quantidade++;
  }

  const resultadoContador = Object.values(contador);

  return {
    status: req.query.status,
    data: resultadoContador
  };
}


app.get("/mendix/tasks/keywords", async (req, res) => {
  try {
    const data = await contarKeywordsTasks(req);
    res.json(data);
  } catch (e) {
    res.status(500).json({
      error: "Erro ao contar keywords das tasks",
      message: e.message,
    });
  }
});

async function buildResultPorEtapa(req) {
  const filtroEmail = req.query.user;
  const now = new Date();

  const rcsResp = await httpGetJson(`${BASE_URL}/requisicao`);
  let rcs = asArray(rcsResp);

  if (filtroEmail) {
    const emailNorm = normalize(filtroEmail);
    rcs = rcs.filter(r => normalize(r.EmialOwner) === emailNorm);
  }

  const levelC = rcs.filter(r => r.Level === "C" && r._RequestInternalId);

  const xml = await httpGetText(TASKS_URL);
  const tasks = parseTasksXml(xml);

  const map = new Map();
  for (const t of tasks) {
    if (!map.has(t.ParentWorkspace_InternalId)) map.set(t.ParentWorkspace_InternalId, []);
    map.get(t.ParentWorkspace_InternalId).push(t);
  }

  const keywords = Object.values(categorias).flatMap(c => c.keywords); // já normalizadas
  const acumulador = {};

  // ✅ NOVO: acumuladores gerais
  let somaDiasTotal = 0;
  let totalTasks = 0;

  for (const rc of levelC) {
    const ws =
      rc.ParentWorkspace_InternalId ||
      rc._RequestInternalId ||
      rc.Workspace_InternalId;

    const rcTasks = map.get(ws) || [];

    for (const task of rcTasks) {
      if (!task.BeginDate) continue;
      if (task.EndDateTime) continue;

      const titulo = normalizeEtapa(task.Title);

      for (const kw of keywords) {
        if (titulo !== kw) continue;

        const dias = diffBusinessDays(new Date(task.BeginDate), now);

        if (!acumulador[kw]) {
          acumulador[kw] = { somaDias: 0, total: 0 };
        }

        acumulador[kw].somaDias += dias;
        acumulador[kw].total += 1;

        // ✅ NOVO: soma geral e total geral
        somaDiasTotal += dias;
        totalTasks += 1;
      }
    }
  }

  const mediaGeral = totalTasks ? Math.trunc(somaDiasTotal / totalTasks) : 0;

  const porEtapa = Object.entries(acumulador).map(([etapa, v]) => ({
    etapa,
    mediaDias: Math.trunc(v.somaDias / v.total),
    totalTasks: v.total,
  }));

  return {
    itens: porEtapa,
    mediaGeral: { mediaDias: mediaGeral, totalTasks, somaDiasTotal }
  };
}

app.get("/mendix/etapas/media", async (req, res) => {
  try {
    const data = await buildResultPorEtapa(req);
    res.json(data);
  } catch (e) {
    res.status(500).json({
      error: "Erro ao calcular média por etapa",
      message: e.message,
    });
  }
});

const etapaLabelMap = {
  'rft': 'RFT',
  'definicao de estrategia de compras': 'Definição de Estratégia de compras',
  'overall': 'Overall',
  'emissao do contrato sap': 'Emissão do Contrato SAP',

  'elaboracao de minuta': 'Elaboração de Minuta',
  'discussao de minuta': 'Discussão de Minuta',
  'assinatura': 'Assinatura',

  'avaliacao tecnica': 'Avaliação Técnica',
  'avaliacao das propostas tecnicas revisadas':
    'Avaliação das propostas técnicas revisadas'
};

function etapaLabel(etapaNorm) {
  return etapaLabelMap[etapaNorm] ?? etapaNorm;
}


// ================= helpers =================
function asArraySafe(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isBusinessDay(d) {
  const day = d.getDay(); // 0 dom, 6 sab
  return day !== 0 && day !== 6;
}

async function index(req) {
  const filtroEmail = req.query.user;
  const filtroEtapa = req.query.etapa ? normalize(req.query.etapa) : null;

  // ================= HELPERS =================
  function statusKeyToLabel(statusKey) {
    if (statusKey === "em_execucao") return "Em Execução";
    if (statusKey === "em_espera") return "Em Espera";
    if (statusKey === "nao_iniciado") return "Não Iniciado";
    if (statusKey === "concluido") return "Concluido";
    return statusKey;
  }

  function toStatusKey(input) {
    if (input == null) return null;

    let s = normalize(String(input)).trim().toLowerCase();
    s = s.replace(/[\s-]+/g, "_").replace(/_+/g, "_");

    if (s === "em_execucao" || s.includes("execucao")) return "em_execucao";
    if (s === "em_espera" || s.includes("espera")) return "em_espera";
    if (s === "nao_iniciado" || s.replace(/_/g, "") === "naoiniciado") return "nao_iniciado";
    if (s === "concluido" || s.includes("conclu")) return "concluido";
    return null;
  }

  const filtroStatusKey = toStatusKey(req.query.status);

  // ================= SLA (process aging) =================
  function startOfDayUTC(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  // Dias úteis (Seg–Sex) inclusivo: conta dia inicial e final se forem úteis
  function businessDaysWeekdaysInclusive(beginDate, endDate) {
    let s = startOfDayUTC(beginDate);
    let e = startOfDayUTC(endDate);
    if (e < s) return 0;

    let count = 0;
    for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay(); // 0 dom, 6 sáb
      if (dow !== 0 && dow !== 6) count++;
    }
    return count;
  }

  // Regra final do SLA do processo:
  // begin mais antigo -> end mais recente; se existir aberto (begin ok & end null) OU pendente (null/null) => fim = hoje.
  function calcularSlaProcessoAging(tasksWs) {
    const now = new Date();
    const tasksAll = (tasksWs || []).filter(t => t?.Title);

    let oldestBegin = null;
    let latestEnd = null;

    let hasOpen = false;    // begin preenchido, end null
    let hasPending = false; // begin null, end null

    for (const t of tasksAll) {
      const beginNull = !t?.BeginDate;
      const endNull = !t?.EndDateTime;

      if (beginNull && endNull) hasPending = true;
      if (!beginNull && endNull) hasOpen = true;

      if (t?.BeginDate) {
        const b = new Date(t.BeginDate);
        if (!Number.isNaN(b.getTime())) {
          if (!oldestBegin || b < oldestBegin) oldestBegin = b;
        }
      }

      if (t?.EndDateTime) {
        const e = new Date(t.EndDateTime);
        if (!Number.isNaN(e.getTime())) {
          if (!latestEnd || e > latestEnd) latestEnd = e;
        }
      }
    }

    if (!oldestBegin) return 0;

    const end = (hasOpen || hasPending || !latestEnd) ? now : latestEnd;
    return businessDaysWeekdaysInclusive(oldestBegin, end);
  }

  // ================= ETAPA ATUAL (SUA REGRA) =================
  function getEtapaAtual(tasksWorkflow) {
    const list = (tasksWorkflow || []).filter(t => t?.Title);

    // 1) Se tiver begin preenchido e end null => está nessa etapa
    const emExecucao = list
      .filter(t => !!t.BeginDate && !t.EndDateTime)
      .sort((a, b) => new Date(b.BeginDate).getTime() - new Date(a.BeginDate).getTime());

    if (emExecucao.length > 0) {
      const t = emExecucao[0];
      return {
        etapa: t.Title,
        etapaKey: normalizeEtapa(t.Title),
      };
    }

    // 2) Senão, pega a que tem EndDateTime mais recente (última concluída)
    const concluidas = list
      .filter(t => !!t.EndDateTime)
      .sort((a, b) => new Date(b.EndDateTime).getTime() - new Date(a.EndDateTime).getTime());

    if (concluidas.length > 0) {
      const t = concluidas[0];
      return {
        etapa: t.Title,
        etapaKey: normalizeEtapa(t.Title),
      };
    }

    // 3) Senão, não iniciou (ou não tem tasks do workflow)
    return {
      etapa: null,
      etapaKey: null,
    };
  }

  // ================= RC =================
  const rcsResp = await httpGetJson(`${BASE_URL}/requisicao`);
  let rcs = asArray(rcsResp);

  if (filtroEmail) {
    const emailNorm = normalize(filtroEmail);
    rcs = rcs.filter(r => normalize(r.EmialOwner) === emailNorm);
  }

  const levelC = rcs.filter(r => r.Level === "C" && r._RequestInternalId);

  // ================= TASKS =================
  const xml = await httpGetText(TASKS_URL);
  const parsed = parseTasksXml(xml);
  const tasks = asArraySafe(parsed?.tasks ?? parsed);

  const map = new Map();
  for (const t of tasks) {
    if (!t || !t.ParentWorkspace_InternalId) continue;
    if (!map.has(t.ParentWorkspace_InternalId)) map.set(t.ParentWorkspace_InternalId, []);
    map.get(t.ParentWorkspace_InternalId).push(t);
  }

  // ================= WORKFLOW TITLES (STATUS/FILTRO ETAPA/ETAPA ATUAL) =================
  const baseKeywords = Object.values(categorias).flatMap(c => c.keywords);

  const extrasWorkflow = [
    "Preencher na Capa do Projeto o campo valor final da negociação",
    "Na hora de enviar o e-mail comunicando o início do Contrato, que o Comprador já envia para o Requisitante e Fornecedor deverá ser incluído o e-mail a seguir da Tapfin: spic@tapfin.com.br",
    "Gerar Pedido no Buying - Enviar Cotações ao Sistema Externo",
    "Finalize Sourcing Project  no Ariba - Mudar o Status do Projeto para Concluído",
  ];

  const workflowTitles = new Set([
    ...baseKeywords, // já normalizados/canônicos
    ...extrasWorkflow.map(t => normalizeEtapa(t)),
  ]);

  const resultado = [];

  // ================= PROCESSAMENTO =================
  for (const rc of levelC) {
    const ws =
      rc.ParentWorkspace_InternalId ||
      rc._RequestInternalId ||
      rc.Workspace_InternalId;

    const rcTasks = map.get(ws) || [];

    // Status/filtro etapa/etapa atual: somente workflow
    const rcFiltered = rcTasks.filter(t => {
      if (!t?.Title) return false;
      return workflowTitles.has(normalizeEtapa(t.Title));
    });
    const filtroEtapaKey = filtroEtapa ? normalize(filtroEtapa) : null;

    // rcFiltered: lista das tasks do workflow (já filtradas por workflowTitles)
    let tasksWorkflow = rcFiltered;

    // se pediu etapa, valida que existe; mas MANTÉM todas as tasks do workflow
    if (filtroEtapaKey) {
      const hit = rcFiltered.find(t => normalize(t?.Title) === filtroEtapaKey);
      if (!hit) {
        // não tem a etapa nessa RC -> descarta RC
        // console.log("DESCARTOU por etapa", rc._RequestInternalId, filtroEtapaKey);
        continue;
      }
    }

    // ================= STATUS =================
    const naoIniciadas = tasksWorkflow.filter(t => !t.BeginDate && !t.EndDateTime);
    const emExecucao = tasksWorkflow.filter(t => !!t.BeginDate && !t.EndDateTime);
    const concluidas = tasksWorkflow.filter(t => !!t.BeginDate && !!t.EndDateTime);

    let statusKey = "nao_iniciado";

    if (tasksWorkflow.length === 0 || naoIniciadas.length === tasksWorkflow.length) {
      statusKey = "nao_iniciado";
    } else if (emExecucao.length > 0) {
      statusKey = "em_execucao";
    } else if (concluidas.length === tasksWorkflow.length) {
      statusKey = "concluido";
    } else {
      statusKey = "em_espera";
    }

    // ================= SLA =================
    const tasksForSla = (rcTasks || []).filter(t => t?.Title);

    const slaUtilizado =
      statusKey === "nao_iniciado" ? 0 : calcularSlaProcessoAging(tasksForSla);

    // ================= ETAPA ATUAL =================
    let etapaInfo = getEtapaAtual(tasksWorkflow);

    // ================= FILTRO STATUS =================
    if (!filtroStatusKey) {
      if (statusKey === "concluido") continue; // default
    } else {
      if (statusKey !== filtroStatusKey) continue;
    }

    if (statusKey === "nao_iniciado") etapaInfo.etapa = ''

    resultado.push({
      ws: rc._RequestInternalId,
      titulo: rc.Titulo,
      responsavel: rc.Responsavel ?? null,
      level: rc.Level,
      // status: statusKeyToLabel(statusKey),
      etapa: etapaInfo.etapa,
      slaUtilizado: Number(slaUtilizado),
      saldo: Number(rc.Saldo),
    });
  }

  // ================= ORDENAÇÃO (SLA desc) =================
  resultado.sort((a, b) => {
    const diff = Number(b.slaUtilizado) - Number(a.slaUtilizado);
    if (diff !== 0) return diff;
    return String(a.titulo ?? "").localeCompare(String(b.titulo ?? ""), "pt-BR");
  });

  let resultArray = []

  for (const element of resultado) {
    if (normalize(element.etapa) === filtroEtapa) resultArray.push(element)

  }

  let finalResult = resultado
  if (resultArray.length > 0) finalResult = resultArray
  return finalResult;
}

app.get("/mendix/index", async (req, res) => {
  try {
    const data = await index(req);
    res.json(data);
  } catch (e) {
    res.status(500).json({
      error: "Erro ao contar keywords das tasks",
      message: e.message,
    });
  }
});

async function timelinev2(ws) {
  const etapasMap = {
    'RFT': ['RFT'],
    'Definição de Estratégia de compras': ['Definição de Estratégia de compras'],
    'Conexão do Fornecedor': ['Conexão do Fornecedor'],
    'Solicitação de propostas técnicas revisadas': ['Solicitação de propostas técnicas revisadas'],
    'Análise Comercial / Negociação': [
      'Preencher na Capa do Projeto  o campo valor final da negociação'
    ],
    'Emissão do Contrato SAP': ['Operating Contract'],
    'Overall': ['Overall'],

    'Elaboração de Minuta': ['Elaboração de Minuta'],
    'Discussão de Minuta': ['Discussão de Minuta'],
    'Assinatura': [
      'Contrato em Assinatura (Docusign)',
      'Top Signed contract'
    ],

    'Avaliação Técnica': ['Avaliação Técnica'],
    'Avaliação das propostas técnicas revisadas': [
      'Avaliação das propostas técnicas revisadas'
    ]
  };

  const etapaToGrupo = {
    'RFT': 'suprimentos',
    'Definição de Estratégia de compras': 'suprimentos',
    'Conexão do Fornecedor': 'suprimentos',
    'Solicitação de propostas técnicas revisadas': 'suprimentos',
    'Análise Comercial / Negociação': 'suprimentos',
    'Emissão do Contrato SAP': 'suprimentos',
    'Overall': 'suprimentos',

    'Elaboração de Minuta': 'juridico',
    'Discussão de Minuta': 'juridico',
    'Assinatura': 'juridico',

    'Avaliação Técnica': 'tecnico',
    'Avaliação das propostas técnicas revisadas': 'tecnico'
  };

  // 🔥 etapas canônicas conhecidas
  const etapasCanonicas = new Set(
    Object.keys(etapaToGrupo).map(e => normalize(e))
  );

  const xml = await httpGetText(TASKS_URL);
  const tasks = parseTasksXml(xml)
    .filter(t => t.ParentWorkspace_InternalId === ws);

  const resultado = [];

  // ================= ETAPAS DEFINIDAS NO CÓDIGO =================
  for (const etapa of Object.keys(etapasMap)) {
    const etapaNorm = normalize(etapa);

    const tasksDaEtapa = tasks.filter(t =>
      t.Title && normalizeEtapa(t.Title) === etapaNorm
    );

    const task = tasksDaEtapa.sort((a, b) => {
      if (!a.BeginDate) return 1;
      if (!b.BeginDate) return -1;
      return new Date(a.BeginDate) - new Date(b.BeginDate);
    })[0];

    let start = task?.BeginDate ?? null;
    let end = task?.EndDateTime ?? null;

    let status = null;
    if (start && end) status = 'Finalizada';
    else if (start) status = 'Em andamento';

    resultado.push({
      nomeEtapa: etapa,
      grupoEtapa: etapaToGrupo[etapa],
      start,
      end,
      status
    });
  }

  // ================= ETAPAS DESAGRUPADAS =================
  const etapasJaUsadas = new Set(
    resultado.map(r => normalize(r.nomeEtapa))
  );

  for (const t of tasks) {
    if (!t.Title) continue;

    const etapaNorm = normalizeEtapa(t.Title);

    if (etapasCanonicas.has(etapaNorm)) continue;
    if (etapasJaUsadas.has(etapaNorm)) continue;

    let status = null;
    if (t.BeginDate && t.EndDateTime) status = 'Finalizada';
    else if (t.BeginDate) status = 'Em andamento';

    resultado.push({
      nomeEtapa: t.Title,
      grupoEtapa: 'desagrupado',
      start: t.BeginDate ?? null,
      end: t.EndDateTime ?? null,
      status
    });

    etapasJaUsadas.add(etapaNorm);
  }

  // ================= ORDENAÇÃO FINAL =================
  resultado.sort((a, b) => {
    if (a.start && b.start) {
      const diff = new Date(a.start) - new Date(b.start);
      if (diff !== 0) return diff;
    }
    if (a.start && !b.start) return -1;
    if (!a.start && b.start) return 1;
    return a.nomeEtapa.localeCompare(b.nomeEtapa, 'pt-BR');
  });

  return resultado;
}

app.get("/mendix/v2/timeLine", async (req, res) => {
  try {
    const ws = req.query.ws;
    if (!ws) throw new Error("Parâmetro ?ws é obrigatório");

    const data = await timelinev2(ws);
    res.json(data);
  } catch (e) {
    res.status(500).json({
      error: "Erro ao contar keywords das tasks",
      message: e.message,
    });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`[${ts()}] API rodando na porta ${PORT}`);
});