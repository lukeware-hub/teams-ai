// Takes a refinement draft to `ready` the way an owner would, so two model setups can be compared on how many cycles and how
// much money convergence takes (R11.13 slice 10). Every pending question gets the same answer whatever model asked it (a
// topic bank below, written for the `agenda` docs), every pending patch is accepted, then the draft is evaluated again.
// Each evaluation costs Claude quota: run it only with the human's ok.
//   node scripts/live-check/converge.mjs <projectId> [maxCycles=8]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const BASE = process.env.TEAMS_AI_URL ?? 'http://localhost:8787/api';
const token = readFileSync(`${REPO}.env`, 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEAMS_AI_UI_TOKEN='))?.slice('TEAMS_AI_UI_TOKEN='.length).replace(/^"|"$/g, '').trim();
if (!token) throw new Error('no TEAMS_AI_UI_TOKEN in .env');
const projectId = process.argv[2];
const maxCycles = Number(process.argv[3] ?? 8);
if (!projectId) throw new Error('usage: converge.mjs <projectId> [maxCycles]');

const S = `/refine/${projectId}/${projectId}-001`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: null }; }
};

// The owner's decisions for the `agenda` docs (a clinic's appointment API), by topic. First match wins.
const BANK = [
  [/profission/i, 'Os profissionais (até 5) vêm de uma lista fixa carregada na instalação por configuração; esta versão não tem cadastro de profissionais pela API.'],
  [/feriado|dia útil|dias úteis/i, 'Só dias úteis (segunda a sexta). Os feriados nacionais ficam numa lista de datas na configuração e não contam como dia útil; feriados estaduais e municipais ficam fora desta versão.'],
  [/hor[aá]rios? (cheios|da agenda)|meia hora|meias horas|17h30|grade|intervalo de|30 minutos/i, 'Os horários começam a cada 30 minutos a partir das 8h00; o último início aceito é 17h30 e toda consulta dura 30 minutos.'],
  [/menos de 2 horas|2 horas do in[ií]cio|c[oó]digo HTTP|resposta HTTP/i, 'Responda HTTP 409 com o motivo "too_late"; o paciente deve ligar para a clínica.'],
  [/mesmo hor[aá]rio|duas consultas|conflito|dupla|libera o hor/i, 'O mesmo paciente não pode ter duas consultas no mesmo horário, nem com profissionais diferentes: responda HTTP 409. Uma consulta cancelada libera o horário do profissional.'],
  [/sa[uú]de|health/i, 'Sim: GET /health devolve 200 com o estado da API e da conexão com o banco, e 503 se o banco estiver fora.'],
  [/lembrete|e-?mail|SMTP|reenvi|tentad/i, 'O lembrete sai cerca de 24 horas antes, na rodada que roda a cada 15 minutos. Consulta marcada com menos de 24 horas de antecedência recebe o lembrete na próxima rodada. Se o envio falhar, tenta de novo nas rodadas seguintes até 3 vezes. Se a consulta for remarcada depois do envio, o paciente recebe um novo lembrete para o novo horário.'],
  [/excluir|exclus[aã]o|LGPD|remo[cç][aã]o/i, 'Nesta versão não há exclusão de paciente pela API; pedidos de remoção de dados são tratados direto no banco, fora do escopo.'],
  [/listar|buscar|pesquis|detalh|atualiz|corrigir|paciente.*(nome|e-?mail)/i, 'A API de pacientes tem: criar, consultar por id, listar com busca por nome ou e-mail e atualizar os dados. Não há exclusão nesta versão.'],
  [/valida|tamanho|formato|telefone|campo/i, 'Nome de 2 a 120 caracteres, telefone brasileiro só com dígitos (10 ou 11), e-mail com formato válido e único. Erros de validação respondem HTTP 422 listando os campos.'],
  [/passad|retroativ|j[aá] passou/i, 'Recuse agendamento em horário que já passou com HTTP 422.'],
  [/404|n[aã]o existe|inexistente/i, 'Consulta ou paciente inexistente responde HTTP 404.'],
  [/consultas.*(dia|profissional|paciente)|agenda/i, 'A recepção lista as consultas filtrando por dia, profissional ou paciente.'],
];
const FALLBACK = 'Adote a opção mais simples que atenda aos documentos e registre a decisão como premissa.';
const answerFor = (text) => (BANK.find(([re]) => re.test(text)) ?? [null, FALLBACK])[1];

const snapshot = async () => (await api('GET', S)).json;
const waitDone = async () => {
  const started = Date.now();
  for (;;) {
    await sleep(10_000);
    const st = (await snapshot())?.state;
    if (st?.status !== 'evaluating') return st;
    if (Date.now() - started > 45 * 60_000) throw new Error('timeout waiting for an evaluation');
  }
};

let cycles = 0;
let st = (await snapshot()).state;
const line = (s) => `status ${s.status}, cycle ${s.cycle}, failing ${s.checklist.filter((i) => !i.passed).length}, questions pending ${s.questions.filter((q) => q.status === 'pending').length} (blocking ${s.questions.filter((q) => q.status === 'pending' && q.blocking).length}), patches pending ${s.patches.filter((p) => p.status === 'pending').length}`;
console.log(`start: ${line(st)}`);
while (st.status !== 'ready' && cycles < maxCycles) {
  cycles += 1;
  for (const q of st.questions.filter((x) => x.status === 'pending')) await api('POST', `${S}/answers`, { questionId: q.questionId, text: answerFor(q.text) });
  for (const p of st.patches.filter((x) => x.status === 'pending')) await api('POST', `${S}/patches/${p.patchId}/accept`);
  const r = await api('POST', `${S}/evaluate`);
  if (r.status !== 202) { console.log(`evaluate answered ${r.status}`); break; }
  st = await waitDone();
  console.log(`after answering ${cycles}: ${line(st)}`);
}
const tokens = (await snapshot()).tokens;
console.log(`${st.status === 'ready' ? 'READY' : `NOT READY (${st.status})`} after ${cycles} rounds of answers; cost US$ ${Number(tokens?.costUsd ?? 0).toFixed(2)}, ${tokens?.steps} steps`);
