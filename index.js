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
      "RFT", //12
      "Definição de Estratégia de compras", //2
      "Conexão do Fornecedor", //2
      "Solicitação de propostas técnicas revisadas", //3
      "Análise Comercial / Negociação", //3
      "Emissão do Contrato SAP", //1
      "Overall", //2
      "Analysis and Data Collection and Strategy Definition", //2
      "Finalize Sourcing Project  no Ariba - Mudar o Status do Projeto para Concluído", //1
      "Contrato em Assinatura (Docusign)", //1
      "Evaluate Scenario for Awards", //3
      "Preencher na Capa do Projeto  o campo valor final da negociação", //2
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
    if (!t.BeginDate || t.EndDateTime) continue;
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

// ================= BUSINESS RC (INALTERADO) =================
async function buildResult(req) {
  const filtroEmail = req.query.user;
  const filtroEtapa = req.query.etapa;
  const rcsResp = await httpGetJson(`${BASE_URL}/requisicao`);
  let rcs = asArray(rcsResp);

  if (filtroEmail) {
    const emailNorm = normalize(filtroEmail);
    rcs = rcs.filter(r => normalize(r.EmialOwner) === emailNorm);
  }

  const levelC = rcs.filter(
    r => r.Level === "C" && r._RequestInternalId
  );

  const xml = await httpGetText(TASKS_URL);
  const tasks = parseTasksXml(xml);
  const map = new Map();
  for (const t of tasks) {
    if (!map.has(t.ParentWorkspace_InternalId)) {
      map.set(t.ParentWorkspace_InternalId, []);
    }
    map.get(t.ParentWorkspace_InternalId).push(t);
  }

  const slaGlobal = novoResumo();

  for (const rc of levelC) {
    const ws =
      rc.ParentWorkspace_InternalId ||
      rc._RequestInternalId ||
      rc.Workspace_InternalId;

    const rcTasks = map.get(ws) || [];

    acumular(slaGlobal, calcularSlaTasks(rcTasks, filtroEtapa));
  }

  const slaResumo = {
    juridico: slaGlobal.Juridico,
    suprimentos: slaGlobal.Suprimentos,
    tecnico: slaGlobal.Tecnico,
  };

  return { slaResumo };
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


// ==========================================================
// =============== 🔥 ENDPOINT NOVO 🔥 ======================
// ==========================================================

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


// Função NOVA – não reutiliza lógica do RC
function calcularSlaProcessoPorWs(tasks) {
  const now = new Date();

  const resultado = {
    juridico: { dias: 0, previsto: categorias.Juridico.slaRef },
    suprimentos: { dias: 0, previsto: categorias.Suprimentos.slaRef },
    tecnico: { dias: 0, previsto: categorias.Tecnico.slaRef },
  };

  for (const t of tasks) {
    if (!t.BeginDate) continue;

    const tituloNorm = normalize(t.Title);
    const grupo = matchCategoriaStrict(tituloNorm);
    if (!grupo) continue;

    const grupoKey = grupo.toLowerCase(); // 🔥 AQUI

    const inicio = new Date(t.BeginDate);
    const fim = t.EndDateTime ? new Date(t.EndDateTime) : now;

    let dias = diffBusinessDays(inicio, fim);
    if (dias < 1) dias = 1;

    resultado[grupoKey].dias += dias;
  }

  return resultado;
}

// Endpoint NOVO
app.get("/mendix/sla-processo", async (req, res) => {
  try {
    const ws = req.query.ws;
    if (!ws) throw new Error("Parâmetro ?ws é obrigatório");

    const xml = await httpGetText(TASKS_URL);
    const tasks = parseTasksXml(xml).filter(
      t => t.ParentWorkspace_InternalId === ws
    );
    const slaPorGrupo = calcularSlaProcessoPorWs(tasks);

    const slaTotalProcesso = {
      dias:
        slaPorGrupo.juridico.dias +
        slaPorGrupo.suprimentos.dias +
        slaPorGrupo.tecnico.dias,
      previsto:
        categorias.Juridico.slaRef +
        categorias.Suprimentos.slaRef +
        categorias.Tecnico.slaRef,
    };


    res.json({ slaPorGrupo, slaTotalProcesso });
  } catch (e) {
    res.status(400).json({
      error: "Erro ao calcular SLA do processo",
      message: e.message,
    });
  }
});

// ==========================================================
// ============ 🔥 ENDPOINT KEYWORDS (NOVO) 🔥 ==============
// ==========================================================

// ================= KEYWORDS =================

const keywordToGroup = new Map();

for (const [GrupoEtapa, cfg] of Object.entries(categorias)) {
  for (const kw of cfg.keywords) {
    keywordToGroup.set(normalize(kw), GrupoEtapa);
  }
}

// ================= CONTADOR =================

async function contarKeywordsTasks(req) {
  const filtroEmail = req.query.user;
  const filtroEtapa = req.query.etapa
    ? normalize(req.query.etapa)
    : null;

  const rcsResp = await httpGetJson(`${BASE_URL}/requisicao`);
  let rcs = asArray(rcsResp);

  if (filtroEmail) {
    const emailNorm = normalize(filtroEmail);
    rcs = rcs.filter(r => normalize(r.EmialOwner) === emailNorm);
  }

  const levelC = rcs.filter(
    r => r.Level === "C" && r._RequestInternalId
  );

  // ================= TASKS =================

  const xml = await httpGetText(TASKS_URL);
  const tasks = parseTasksXml(xml);

  const map = new Map();
  for (const t of tasks) {
    if (!map.has(t.ParentWorkspace_InternalId)) {
      map.set(t.ParentWorkspace_InternalId, []);
    }
    map.get(t.ParentWorkspace_InternalId).push(t);
  }

  // ================= CONTADOR =================

  const contador = {};

  for (const rc of levelC) {
    const ws =
      rc.ParentWorkspace_InternalId ||
      rc._RequestInternalId ||
      rc.Workspace_InternalId;

    const rcTasks = map.get(ws) || [];

    for (const t of rcTasks) {
      if (!t?.Title) continue;

      if (!t.BeginDate) continue;
      if (t.EndDateTime !== null) continue;

      const titleNorm = normalize(t.Title);

      // filtro opcional por etapa
      if (filtroEtapa && titleNorm !== filtroEtapa) continue;

      const GrupoEtapa = keywordToGroup.get(titleNorm);
      if (!GrupoEtapa) continue;

      const key = `${GrupoEtapa}|${titleNorm}`;

      if (!contador[key]) {
        contador[key] = {
          NomeEtapa: t.Title, // mantém texto original
          GrupoEtapa,
          Quantidade: 0,
        };
      }

      contador[key].Quantidade++;
    }
  }

  return Object.values(contador);
}

// ================= ENDPOINT =================

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
  // ================= RC =================
  const rcsResp = await httpGetJson(`${BASE_URL}/requisicao`);
  let rcs = asArray(rcsResp);

  if (filtroEmail) {
    const emailNorm = normalize(filtroEmail);
    rcs = rcs.filter(r => normalize(r.EmialOwner) === emailNorm);
  }

  const levelC = rcs.filter(
    r => r.Level === "C" && r._RequestInternalId
  );

  // ================= TASKS =================
  const xml = await httpGetText(TASKS_URL);
  const tasks = parseTasksXml(xml);
  const map = new Map();
  for (const t of tasks) {
    if (!map.has(t.ParentWorkspace_InternalId)) {
      map.set(t.ParentWorkspace_InternalId, []);
    }
    map.get(t.ParentWorkspace_InternalId).push(t);
  }

  // ================= KEYWORDS =================
  const keywords = Object.values(categorias)
    .flatMap(c => c.keywords); // já normalizadas

  const acumulador = {};

  // ================= PROCESSAMENTO =================
  for (const rc of levelC) {
    const ws =
      rc.ParentWorkspace_InternalId ||
      rc._RequestInternalId ||
      rc.Workspace_InternalId;

    const rcTasks = map.get(ws) || [];

    for (const task of rcTasks) {
      if (!task.BeginDate) continue;
      if (task.EndDateTime) continue;

      const titulo = normalize(task.Title);

      for (const kw of keywords) {
        if (titulo !== kw) continue;

        const dias = diffBusinessDays(
          new Date(task.BeginDate),
          now
        );

        if (!acumulador[kw]) {
          acumulador[kw] = { somaDias: 0, total: 0 };
        }

        acumulador[kw].somaDias += dias;
        acumulador[kw].total += 1;
      }
    }
  }

  // ================= RESULTADO =================
  return Object.entries(acumulador).map(([etapa, v]) => ({
    etapa: etapa === 'discussao de minuta'
      ? 'Discussão de Minuta'
      : etapa,
    mediaDias: Number((v.somaDias / v.total).toFixed(2)),
    totalTasks: v.total,
  }));

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

// ================= START =================
app.listen(PORT, () => {
  console.log(`[${ts()}] API rodando na porta ${PORT}`);
});
