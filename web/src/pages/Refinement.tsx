import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, refineApi, type AcceptanceCriterion, type ChecklistItem, type Snapshot, type StoredEvent } from '../api.js';
import { docToJson } from '../refine/docJson.js';
import { applyBatch, type LiveSnapshot } from '../refine/reducer.js';
import { useJournal } from '../useSse.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip, Tipped } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { buildSpecsIndex } from '@server/refine/specs-index';
import { allGreen, isApproval } from '@server/refine/state';
import type { Divergence, DivergenceSide } from '@server/refine/checklist';
import { BacklogPanel } from '../refine/BacklogPanel.js';
import { MoveNotice } from '../refine/MoveNotice.js';
import { released } from '@server/refine/state';
import { canStartRun, ProgramStatus, useProgram } from '../refine/ProgramPanel.js';
import { ProcessingBanner } from '../refine/ProcessingBanner.js';
import { runningSteps, type RunningStep } from '../refine/running-steps.js';
import { StageBar } from '../refine/StageBar.js';
import { stageAction, stageOf, stageTitle } from '../refine/stages.js';
import { SpecTree } from '../refine/SpecTree.js';
import { Workspace } from '../components/Workspace.js';

type DocFile = 'project.md' | 'brief.md' | 'stack.md' | 'flow.md' | 'design.md';
const docLabel: Record<DocFile, string> = { 'project.md': 'project.md', 'brief.md': 'briefing.md', 'stack.md': 'stack.md', 'flow.md': 'flow.md', 'design.md': 'design.md' };
const questionText = (text: string) => text.startsWith('What counts as valid client data?')
  ? 'Quais dados um cliente precisa ter? Nome, e-mail, telefone e observações são obrigatórios? Quais formatos e limites devemos aceitar? O e-mail pode se repetir? Se algum dado for inválido, devemos mostrar o erro de cada campo e retornar HTTP 400?'
  : text;
const jevCheckLabel: Record<string, string> = {
  documents_consistent: 'documentos com contradições',
  flow_covers_scope: 'fluxo não cobre todo o escopo',
  validation_aligned: 'regras de validação divergentes',
  persistence_aligned: 'persistência divergente',
  responses_aligned: 'respostas ou rotas divergentes',
  health_aligned: 'health check divergente',
};
const errorText = (text: string | null) => text
  ?.replace(/^Jev bloqueou a derivação:/, 'O Jev encontrou pontos para revisão:')
  ?.replace(/\binterrupted\b/gi, 'A avaliação foi interrompida. Clique em Reavaliar para tentar novamente.')
  .replaceAll('failed', 'falhou')
  .replaceAll('timeout', 'tempo limite excedido')
  .replaceAll('internal error', 'erro interno')
  .replace(/\b(documents_consistent|flow_covers_scope|validation_aligned|persistence_aligned|responses_aligned|health_aligned)\b/g, (id) => jevCheckLabel[id] ?? id) ?? null;
const typeLabel: Record<string, string> = { feature: 'Feature', bug: 'Bug', maintenance: 'Manutenção', refactor: 'Refatoração' };
const docImpact: Record<DocFile, string> = {
  'project.md': 'Visão, público, princípios e restrições que valem para todas as demandas do projeto. Gera o project.json.',
  'brief.md': 'O que esta demanda entrega: objetivos, escopo e critérios de aceite. Gera o spec.json.',
  'stack.md': 'Tecnologias, dependências e restrições técnicas. Orienta o plano técnico e a implementação.',
  'flow.md': 'Fluxos de uso e regras de negócio, passo a passo. Base dos critérios de aceite e dos testes.',
  'design.md': 'Contrato visual: cores, tipografia, componentes e acessibilidade. Seguido pelo agente Front, que cuida da interface.',
};
/** Short text for the info icon on each document tab. */
const docTip: Record<DocFile, string> = {
  'project.md': 'Explica o que é o projeto, para quem ele serve e as regras que valem para todas as demandas.',
  'brief.md': 'Diz o que esta demanda deve entregar: objetivos, o que entra, o que fica de fora e como saber que ficou pronto.',
  'stack.md': 'Lista as tecnologias, as dependências e os limites técnicos que os agentes precisam seguir.',
  'flow.md': 'Mostra, passo a passo, como o usuário usa o sistema e as regras do negócio. Serve de base para os critérios de aceite e os testes.',
  'design.md': 'Define o visual do projeto: cores, letras, componentes e acessibilidade. O agente Front segue este documento na interface.',
};
/** Backlog mode: the briefing is the target project's docs/briefing.md, one file for the whole backlog. */
const briefingImpact = 'Briefing do projeto (docs/briefing.md): objetivos, prioridades, cortes e decisões que valem para todo o backlog. Os agentes seguem o que estiver escrito aqui.';
const docName = (file: string) => docLabel[file.split('/').pop() as DocFile] ?? file;
/** Journal events that change a document or a decision: after one of them a new evaluation is not a repeat. */
const CHANGE_EVENTS = new Set(['DOC_EDITED', 'PATCH_ACCEPTED', 'PATCH_REJECTED', 'QUESTION_ANSWERED', 'QUESTION_SKIPPED', 'BACKLOG_DETAIL_ENABLED']);
const roleInfo: Record<'po' | 'sm', string> = {
  po: 'Pergunta do PO (Product Owner), o agente que revisa objetivos, critérios de aceite e o fluxo de negócio.',
  sm: 'Pergunta do SM (Scrum Master), o agente que revisa stack, tarefas, validação e viabilidade técnica.',
};
const checkLabel: Record<string, string> = {
  'po.objectives-verifiable': 'Objetivos verificáveis',
  'po.personas': 'Público e personas definidos',
  'po.scope-explicit': 'Escopo explícito',
  'po.no-contradictions': 'Documentos sem contradições',
  'sm.constraints-clear': 'Restrições técnicas claras',
  'sm.tasks-feasible': 'Tarefas viáveis',
  'sm.no-open-questions': 'Sem perguntas obrigatórias em aberto',
  'sm.flow-is-mermaid': 'flow.md é um diagrama mermaid',
};
/** The server writes these details itself; details written by the agents pass through unchanged. */
const checkDetail = (detail: string) => {
  if (detail === 'not reported') return 'O agente não avaliou este item.';
  if (detail === 'no blocking question open') return 'Nenhuma pergunta obrigatória em aberto.';
  if (detail === 'flow.md has a mermaid diagram') return 'flow.md tem um diagrama mermaid.';
  if (detail === 'flow.md has no ```mermaid block; it must be a diagram, not markdown headings') return 'flow.md precisa ser um diagrama mermaid, não títulos em markdown.';
  const open = /^(\d+) blocking question\(s\) open$/.exec(detail);
  if (open) return open[1] === '1' ? '1 pergunta obrigatória em aberto.' : `${open[1]} perguntas obrigatórias em aberto.`;
  return detail;
};
const criterionText = (c: AcceptanceCriterion) => `${c.id}: dado ${c.given}, quando ${c.when}, então ${c.then}`;
const jevInfo = 'O Jev é obrigatório no refinamento. Ele confere se os cinco documentos estão consistentes entre si e classifica e decide pontos da avaliação: critérios de aceite ainda não prontos, perguntas repetidas e contradições com o histórico do projeto. Sem ele, a avaliação não inicia. Ajuste o que fizer sentido e reavalie.';
const patchInfo = 'Mudança proposta por um agente: linhas com - saem e linhas com + entram. Aceitar aplica a mudança no documento; Rejeitar a descarta, e o motivo opcional fica no histórico.';
const jsonDownload = (value: unknown) => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value, null, 2))}`;

// Skip re-rendering the 59-spec backlog on each tab click: its props stay the same.
const MemoBacklogPanel = memo(BacklogPanel);
const MemoSpecTree = memo(SpecTree);

// Builds the body only after the file is opened: a closed details still mounts its children.
function LazyDetails({ className, summary, body }: { className: string; summary: ReactNode; body: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={className} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && body()}
    </details>
  );
}

const panelCard = 'edge-lit min-w-0 rounded-xl border border-line bg-surface p-5 shadow-card';
// The checklist panel styles the headings and lists inside it; disclosures bring their own box.
const qualityCard = `${panelCard} [&_details_pre]:max-h-48 [&_details_pre]:overflow-auto [&_details_pre]:text-[0.7rem] [&_details_pre]:text-ink-soft [&_details_summary]:flex [&_details_summary]:cursor-pointer [&_details_summary]:items-center [&_details_summary]:justify-between [&_details_summary_svg]:text-accent-text [&_h4]:mx-0 [&_h4]:mt-5 [&_h4]:mb-[0.7rem] [&_h4]:flex [&_h4]:items-center [&_h4]:gap-[0.55rem] [&_h4]:text-[0.8rem] [&_h4]:tracking-[0.06em] [&_h4]:text-ink [&_h4]:uppercase [&_h4>svg]:text-ink-soft [&_h5]:mx-0 [&_h5]:mt-4 [&_h5]:mb-[0.45rem] [&_h5]:text-[0.72rem] [&_h5]:tracking-[0.08em] [&_h5]:text-ink-soft [&_h5]:uppercase [&_ul]:pl-[1.1rem] [&_ul]:text-[0.8rem] [&_ul]:leading-[1.45]`;
const fileBox = 'my-2 rounded-lg border border-line bg-surface p-[0.85rem] text-[0.8rem]';
// The status chip drops under the title when the panel is too narrow for both.
const panelHeading = 'mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2';
const headingTile = 'grid size-12 flex-[0_0_3rem] place-items-center rounded-tile shadow-tile';
const eyebrow = 'text-[0.8125rem] font-semibold text-ink-soft';
const panelTitle = 'm-0 mt-[0.15rem] text-[1.0625rem] tracking-[-0.01em] text-ink';
const tabGroupLabel = 'mr-1 text-[0.75rem] text-ink-soft';
const muted = 'text-[0.8125rem] text-ink-soft';
// Inside a toned callout the tip takes the callout's ink: the faint default fails contrast on a tinted ground.
const notice = 'rounded-md bg-warn-soft px-3 py-[0.65rem] text-[0.8rem] text-warn [&_.info-tip]:text-current';
const fileStatus = 'text-[0.75rem] font-semibold text-ink-soft';
const fileEmpty = 'mx-0 mt-[0.65rem] mb-0 text-[0.78rem] text-ink-soft';
const secretRow = 'grid gap-[0.45rem] rounded-lg border p-3';
/** What a secret is for, which dependency needs it, and which document sections name it. */
const secretTip = (s: Snapshot['secrets'][number]): string => {
  const uses = s.uses.map((u) => `Usado por ${u.dependency}: ${u.purpose}.`);
  const mentions = s.mentions.length > 0 ? [`Citado em: ${s.mentions.map((m) => `${m.doc} › ${m.heading}`).join('; ')}.`] : [];
  return [...uses, ...mentions].join(' ') || 'Nenhuma spec declara este segredo ainda.';
};
const secretEntry = 'grid items-center gap-2';
const secretInput = 'm-0 w-full min-w-0';
const secretSave = 'm-0 min-w-[5.4rem] max-[720px]:w-full';
const badge = (role: string) => `badge px-2 py-[0.15rem] text-[0.6875rem] font-bold tracking-[0.04em] ${role === 'po' ? 'bg-info-soft text-ink' : role === 'sm' ? 'bg-warn-soft text-warn' : ''}`;

/** Re-checks the OpenRouter connection and links to the onboarding step where a new key is entered. */
export function JevActions() {
  const [check, setCheck] = useState<{ checking: boolean; ok?: boolean; detail?: string }>({ checking: false });
  const validate = () => {
    setCheck({ checking: true });
    api.status()
      .then((s) => setCheck({ checking: false, ok: s.items.openrouterKey.ok, detail: s.items.openrouterKey.detail }))
      .catch(() => setCheck({ checking: false, ok: false, detail: 'Não foi possível validar a conexão agora.' }));
  };
  return (
    <span className="mt-2 flex flex-wrap items-center gap-x-[0.8rem] gap-y-[0.3rem]">
      <ActionButton className="rounded-md border-current bg-transparent px-[0.6rem] py-[0.2rem] text-[0.75rem] font-semibold text-current disabled:cursor-default disabled:opacity-60" data-testid="jev-validate" busy={check.checking} onClick={validate} icon={<Icon name="check" size={14} />}>{check.checking ? 'Validando…' : 'Validar conexão'}</ActionButton>
      <Link className="font-semibold text-current underline" to="/settings">Informar nova chave</Link>
      {check.ok !== undefined && <span data-testid="jev-validate-result">{check.ok ? 'Conexão com o OpenRouter funcionando. Clique em Reavaliar.' : `Falha na conexão: ${check.detail ?? 'chave inválida.'}`}</span>}
    </span>
  );
}

/** The stage the evaluation is in now, and whether Jev is down, from the journal of the current round. */
export function stageNow(events: StoredEvent[], cycle: number): { stage: string; jevDown: boolean; running: RunningStep[] } {
  const derived = events.some((e) => e.type === 'DERIVED' && Number(e.data.cycle) === cycle);
  const jevEvent = events.find((e) => e.type === 'REFINE_DOCS_VALIDATED' && Number(e.data.cycle) === cycle);
  return { stage: currentClaudeStage(events, cycle, jevEvent, derived), jevDown: jevEvent?.data.available === false, running: runningSteps(events, cycle) };
}

function currentClaudeStage(events: StoredEvent[], cycle: number, jevEvent: StoredEvent | undefined, derived: boolean): string {
  if (!jevEvent) return 'Jev está validando os cinco documentos do projeto.';
  if (jevEvent.data.available === false) return 'Jev indisponível: confira a chave do OpenRouter. A avaliação não continua sem ele.';
  if (jevEvent.data.decision === 'blocked') return 'Jev encontrou pontos importantes para revisão; PO e SM vão avaliá-los.';
  if (jevEvent.data.decision === 'review') return 'Jev encontrou pontos para revisão; Claude está analisando os documentos.';

  const active = runningSteps(events, cycle);
  if (active.some((step) => step.kind === 'backlog')) return 'PO está quebrando os documentos em backlog, com épicos e prioridades.';
  if (active.some((step) => step.kind === 'spec')) return 'PO está detalhando a spec de cada item do backlog.';
  if (active.some((step) => step.kind === 'preplan')) return 'SM está fazendo o pré-plano de cada spec.';
  if (active.some((step) => step.kind === 'derive')) return 'Claude está derivando project.json e spec.json a partir dos cinco documentos.';
  if (active.some((step) => step.kind === 'answer')) return 'PO e SM estão respondendo, a partir dos documentos, as perguntas que eles já resolvem.';
  const roles = active.filter((step) => step.kind === 'refine').map((step) => step.role);
  if (roles.includes('front')) return 'Front está revisando o contrato visual, responsividade e acessibilidade.';
  if (roles.includes('po') && roles.includes('sm')) return 'PO e SM estão revisando objetivos, critérios e fluxos em paralelo.';
  if (roles.includes('po')) return 'PO está revisando objetivos, critérios e o fluxo de negócio.';
  if (roles.includes('sm')) return 'SM está revisando stack, tarefas, validação e viabilidade.';
  if (!derived) return 'Jev validou os documentos; Claude está iniciando a derivação dos arquivos.';
  return 'Derivação concluída; Claude está preparando a revisão do PO e do SM.';
}
export interface ViewProps {
  snap: Snapshot;
  busy: boolean;
  onSaveDoc(file: DocFile, text: string): void;
  /** "Sugerir": the agent's version of a document written from flow.md, or null when it failed. */
  onSuggestDoc?(file: Exclude<DocFile, 'flow.md'>): Promise<string | null>;
  /** "Anexar imagem": the agent's design.md adjusted from template images (base64), or null when it failed. */
  onDesignFromImages?(images: { data: string }[]): Promise<string | null>;
  onEvaluate(): void | Promise<unknown>;
  onEnableBacklog?(): void | Promise<unknown>;
  /** Stage 2 of a new project: the whole backlog in one run, stopped by a question or an error and resumed by the next call. */
  onAnswer(id: string, text: string, docsAnswered: boolean): void | Promise<unknown>;
  onSkip(id: string): void | Promise<unknown>;
  onAccept(id: string): void | Promise<unknown>;
  onReject(id: string, reason: string | null): void | Promise<unknown>;
  onSecret(name: string, value: string): void | Promise<unknown>;
  onStart(): void | Promise<unknown>;
  startState?: { label: string; busy: boolean };
  events?: StoredEvent[];
}

/** Each verified divergence: the fact, both places with their quotes, and how to correct it. */
function Divergences({ items }: { items: Divergence[] }) {
  const place = (s: DivergenceSide) => `${docName(s.file)}${s.heading ? ` › ${s.heading}` : ''}`;
  return (
    <ul className="m-0 mt-[0.35rem] list-none space-y-[0.45rem] p-0 text-ink-soft">
      {items.map((d, n) => (
        <li key={n}>
          <span className="block text-ink">{d.fact}</span>
          <span className="block">{`Onde: ${place(d.a)} — “${d.a.quote}” × ${place(d.b)} — “${d.b.quote}”`}</span>
          <span className="block">{`Como corrigir: ${d.fix || 'corrija o trecho divergente nos documentos e reavalie.'}`}</span>
        </li>
      ))}
    </ul>
  );
}

function Checklist({ items, role }: { items: ChecklistItem[]; role: 'po' | 'sm' }) {
  const own = items.filter((i) => i.role === role);
  if (own.length === 0) return <p className={fileEmpty}>Preenchida na primeira avaliação.</p>;
  return (
    <ul className="m-0 list-none rounded-lg border border-line bg-surface py-[0.55rem] pr-3 pl-[1.1rem] text-[0.8rem] leading-[1.45] text-justify">
      {own.map((i) => (
        <li key={i.id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 py-[0.4rem] text-[0.8125rem] text-ink">
          <span className={`grid h-5 place-items-center ${i.passed ? 'text-good' : 'text-bad'}`} role="img" aria-label={i.passed ? 'Atendido' : 'Não atendido'}><Icon name={i.passed ? 'check' : 'close'} size={16} /></span>
          <div>{checkLabel[i.id] ?? i.id.slice(3)}<small className="mx-0 mt-[0.15rem] mb-0 block leading-[1.35] text-ink-soft">{checkDetail(i.detail)}</small>{i.divergences?.length ? <Divergences items={i.divergences} /> : null}</div>
        </li>
      ))}
    </ul>
  );
}

export function RefinementView(p: ViewProps) {
  const { snap, busy } = p;
  const st = snap.state;
  const [tab, setTab] = useState<DocFile>('flow.md');
  const [docs, setDocs] = useState(snap.docs);
  const [suggesting, setSuggesting] = useState(false);
  const [askRe, setAskRe] = useState(false);
  // Nothing changed since the last evaluation: a new one would spend the same calls on the same documents.
  const changedSince = useMemo(() => {
    const events = p.events ?? [];
    const lastEvaluated = events.filter((e) => e.type === 'REFINE_EVALUATED').at(-1)?.seq ?? 0;
    return events.some((e) => e.seq > lastEvaluated && CHANGE_EVENTS.has(e.type));
  }, [p.events]);
  const unchanged = st.cycle > 0 && !st.stale && !changedSince;
  const attachInput = useRef<HTMLInputElement>(null);
  const [answer, setAnswer] = useState('');
  const [docsAnswered, setDocsAnswered] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // The patch being accepted or rejected: both of its buttons stay locked until the action ends.
  const [deciding, setDeciding] = useState<string | null>(null);
  const decide = (patchId: string, action: () => unknown) => {
    setDeciding(patchId);
    return Promise.resolve(action()).finally(() => setDeciding(null));
  };
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [newSecrets, setNewSecrets] = useState<Array<{ id: number; name: string; value: string }>>([]);
  const saved = useRef(snap.docs);
  useEffect(() => {
    // A reload keeps a tab's unsaved text unless that same file also changed on the server.
    const before = saved.current;
    setDocs((local) => Object.fromEntries(Object.entries(snap.docs).map(([f, text]) => {
      const file = f as DocFile;
      return [file, local[file] !== before[file] && text === before[file] ? local[file] : text];
    })) as typeof snap.docs);
    saved.current = snap.docs;
  }, [snap.docs]);
  const copyDoc = (text: string) => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  };
  const evaluating = busy || st.status === 'evaluating';
  const locked = evaluating || st.status === 'started';
  const jevAdvisory = st.error?.startsWith('Jev bloqueou') ?? false;
  const pending = [...st.questions.filter((q) => q.status === 'pending')].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const current = pending[0];
  // A new question on screen starts with an empty answer and no mark, so neither reaches the wrong question.
  useEffect(() => {
    setAnswer('');
    setDocsAnswered(false);
  }, [current?.questionId]);
  const canStart = canStartRun(st, busy, snap.limits);
  // Past the lock round, another evaluation is refused by the server: the button says so instead of failing.
  const atMax = snap.limits !== undefined && st.cycle >= snap.limits.max;
  const backlogOn = st.backlog?.enabled === true;
  // A new project's refinement has two mandatory stages: the documents, then the backlog the program runs from.
  const newProject = st.mode === 'new-project';
  const stageStep = newProject ? stageAction({ ...st, released: snap.limits !== undefined && released(st, snap.limits) }) : null;
  // In stage 2 the backlog is what the person checks, so it leads the quality column.
  const backlogFirst = newProject && backlogOn;
  const backlogBlock = (
    <>
      <MemoBacklogPanel backlog={st.backlog} evaluating={evaluating} locked={locked} onEnable={newProject ? undefined : p.onEnableBacklog} mandatory={newProject} />
      {st.backlog?.detail && <MemoSpecTree backlog={st.backlog} evaluating={evaluating} />}
    </>
  );
  // Backlog mode lists specs, not one spec: the generated index replaces spec.json and the tasks of a single spec.
  const specsIndex = useMemo(() => (backlogOn && (st.backlog?.items.length ?? 0) > 0 ? buildSpecsIndex(snap.specId, st.backlog as never) : null), [backlogOn, snap.specId, st.backlog]);
  const projectJson = backlogOn ? st.backlog?.project ?? null : st.derived?.project ?? null;
  // The base docs as JSON, by the names the generated files use; briefing.md is the brief in backlog mode.
  const docFiles = [
    { doc: 'flow.md', name: 'flow.json', text: snap.docs['flow.md'] },
    { doc: 'briefing.md', name: 'briefing.json', text: snap.docs['brief.md'] },
    { doc: 'stack.md', name: 'stack.json', text: snap.docs['stack.md'] },
    { doc: 'design.md', name: 'design.json', text: snap.docs['design.md'] },
  ];
  // A detailed backlog numbers criteria across its item specs, so a question may cite any of them; a single-spec
  // derivation left in the journal from before backlog mode no longer counts.
  const criteria = backlogOn ? Object.values(st.backlog?.specs ?? {}).flatMap((row) => row.spec?.acceptanceCriteria ?? []) : st.derived?.spec.acceptanceCriteria ?? [];
  const listState = st.status === 'evaluating'
    ? { label: 'Avaliando', tone: 'tone-neutral' }
    : st.cycle === 0
      ? { label: 'Não avaliada', tone: '' }
      : st.stale
        ? { label: 'Desatualizada', tone: 'warn' }
        : { label: 'Atual', tone: 'ok' };
  const green = allGreen(st.checklist);
  const pendingSuggestion = st.patches.some((x) => x.status === 'pending');
  const openCount = pending.length + st.patches.filter((x) => x.status === 'pending').length;
  const backlogDetailed = st.backlog?.items.every((i) => st.backlog?.specs?.[i.key]?.spec && st.backlog.preplans?.[i.key]?.preplan) ?? false;
  const nextStep = st.status === 'started' && st.backlog?.enabled
    ? 'Os agentes estão executando o backlog, até duas specs ao mesmo tempo quando não mexem no mesmo código. Acompanhe cada uma na tela de execução do backlog.'
    : st.status === 'evaluating'
    ? null
    : atMax
    ? `Limite de ${snap.limits?.max} rodadas atingido. Revise os documentos e inicie a análise, ou ajuste TEAMS_AI_REFINE_MAX_ROUNDS no .env.`
    : jevAdvisory
    ? 'O Jev apontou pontos nos documentos. Ajuste o que fizer sentido e clique em Reavaliar.'
    : stageStep === 'answer'
    ? 'O backlog depende desta resposta: responda para a avaliação continuar.'
    : pending.length > 0
    ? 'Responda às perguntas em aberto para continuar.'
    : st.stale
      ? 'Clique em Reavaliar para atualizar a lista de verificação com as últimas mudanças.'
      : st.status === 'answering' && green && st.patches.some((x) => x.status === 'pending' && isApproval(x))
        ? 'Aprove ou rejeite o ajuste proposto abaixo; as outras sugestões são opcionais.'
      : st.status === 'answering' && st.patches.some((x) => x.status === 'pending')
        ? 'Revise as sugestões de alteração abaixo e aceite ou rejeite cada uma.'
        : st.backlog?.enabled && st.status === 'ready'
          ? st.backlog.detail
            ? pendingSuggestion
              ? 'O backlog detalhado está pronto. Aceite ou rejeite cada sugestão pendente, ou clique em Iniciar análise para começar sem elas, que vão para o histórico.'
              : 'O backlog detalhado está pronto: cada item tem spec e pré-plano. Clique em Iniciar análise para os agentes executarem o backlog. Para mudar algo antes, escreva nos documentos e reavalie.'
            : 'O backlog está pronto para revisão. Para mudar prioridades ou cortes, escreva no briefing.md e reavalie.'
        : st.backlog?.detail && !backlogDetailed
          ? 'O detalhamento ainda não cobre todos os itens: clique em Reavaliar para gerar a spec e o pré-plano do que falta; o que faltar aparece em vermelho na cobertura.'
        : canStart && !green
          ? `Executar liberado após ${snap.limits?.release} rodadas, com critérios ainda reprovados: ${st.checklist.filter((c) => !c.passed).map((c) => c.id).join(', ')}. Você decide: inicie agora ou corrija os documentos e reavalie.`
        : canStart
          ? 'Tudo pronto. Clique em Iniciar análise para os agentes desenvolverem o projeto.'
          : st.cycle === 0
            ? 'Revise os documentos e clique em Avaliar. Os agentes vão revisar a demanda e preencher a lista de verificação.'
            : 'Corrija nos documentos os itens não atendidos da lista de verificação e clique em Reavaliar.';
  // R11.10: once ready, a pending patch is a suggestion the owner may still take.
  // A detailed backlog that is ready says it in its own next step.
  const optional = (st.status === 'ready' || st.status === 'drafting') && green && pendingSuggestion && !st.stale && !(st.backlog?.detail && st.status === 'ready' && pending.length === 0) ? ' As sugestões abaixo são opcionais; aceitar uma pede nova avaliação.' : '';
  const existing = st.mode === 'new-spec' || st.mode === 'continue';
  const suggest = (file: Exclude<DocFile, 'flow.md'>) => {
    setSuggesting(true);
    return p.onSuggestDoc!(file)
      .then((text) => { if (text !== null) setDocs((d) => ({ ...d, [file]: text })); })
      .finally(() => setSuggesting(false));
  };
  const toBase64 = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });
  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setSuggesting(true);
    try {
      const images = await Promise.all([...files].map((f) => toBase64(f).then((data) => ({ data }))));
      const text = await p.onDesignFromImages!(images);
      if (text !== null) setDocs((d) => ({ ...d, 'design.md': text }));
    } finally {
      setSuggesting(false);
    }
  };
  const tabButton = (f: DocFile) => (
    <span key={f} className="inline-flex items-center">
      <button
        className={`min-w-[auto] h-auto min-h-11 rounded-none border-0 border-b-2 bg-transparent px-3 py-[0.55rem] whitespace-nowrap transition-none hover:enabled:bg-surface-sunken hover:enabled:text-ink ${tab === f ? 'border-accent text-accent-text' : 'border-transparent text-ink-soft'}`}
        onClick={() => setTab(f)}
      >
        {docLabel[f]}
      </button>
      {/* The icon sits beside the tab: a button cannot hold another button. */}
      <InfoTip text={backlogOn && f === 'brief.md' ? briefingImpact : docTip[f]} label={docLabel[f]} />
    </span>
  );
  const docsTitle = existing ? (st.mode === 'continue' ? 'Continuação da spec' : 'Spec nova') : 'Documentos do projeto';
  const docsPanel = (
    <section className={panelCard}>
      <div className={panelHeading}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={`${headingTile} text-[color:var(--tile-accent-ink)] [background:var(--tile-accent)]`}><Icon name="file" size={26} /></span>
          <div><span className={eyebrow}>Área de trabalho</span>
          <h2 className={panelTitle}>{docsTitle}</h2>
          </div>
        </div>
      </div>
      {existing ? (
        <div className="mb-4 flex flex-wrap gap-x-6 border-b border-line" role="tablist" aria-label="Documentos">
          <div className="flex flex-wrap items-center" data-testid="docs-group-spec">
            <span className={tabGroupLabel}>Spec</span>
            {tabButton('brief.md')}
          </div>
          <div className="flex flex-wrap items-center" data-testid="docs-group-project">
            <span className={tabGroupLabel}>Contexto do projeto · muda só com sua aprovação</span>
            {(['flow.md', 'project.md', 'stack.md', 'design.md'] as DocFile[]).map(tabButton)}
          </div>
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap border-b border-line" role="tablist" aria-label="Documentos do projeto">
          {(['flow.md', 'project.md', 'brief.md', 'stack.md', 'design.md'] as DocFile[]).map(tabButton)}
        </div>
      )}
      <p data-testid="doc-impact" className="hint">{backlogOn && tab === 'brief.md' ? briefingImpact : docImpact[tab]}</p>
      <div className="grid gap-2">
        {/* The editor's actions sit above it, so they never cover the document's first lines. */}
        <div className="flex flex-col gap-2">
          {tab !== 'flow.md' && p.onSuggestDoc && (
            <ActionButton data-testid="suggest" className="h-10 px-[0.8rem]" busy={suggesting} disabled={locked} title="Gera este documento a partir do flow.md" onClick={() => suggest(tab)} icon={<Icon name="lightbulb" size={16} />}>
              {suggesting ? 'Sugerindo…' : 'Sugerir'}
            </ActionButton>
          )}
          {tab === 'design.md' && p.onDesignFromImages && (
            <>
            <button type="button" className="h-10 px-[0.8rem]" disabled={locked || suggesting} title="Ajusta o design.md pelas cores, fontes e alinhamentos de imagens de exemplo; as imagens são apagadas depois" onClick={() => attachInput.current?.click()}>
              Anexar imagem
              <Icon name="file" size={16} />
            </button>
            <input ref={attachInput} data-testid="attach-images" type="file" accept="image/png,image/jpeg" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
            </>
          )}
          <button type="button" className="h-10 px-[0.8rem]" aria-label="Copiar documento" onClick={() => copyDoc(docs[tab] ?? '')}>
            Copiar
            <Icon name="copy" size={16} />
          </button>
        </div>
        <textarea
        className="min-h-[58vh] w-full resize-y bg-surface-sunken p-4 font-mono text-[0.8125rem] leading-[1.6]"
        aria-label={`${docLabel[tab]} editor`}
        data-testid={`doc-${tab}`}
        value={docs[tab] ?? ''}
        readOnly={locked}
        onChange={(e) => setDocs({ ...docs, [tab]: e.target.value })}
        onBlur={() => {
          if (!locked && docs[tab] !== snap.docs[tab]) p.onSaveDoc(tab, docs[tab] ?? '');
        }}
      />
      </div>
      {st.stale && (
        <p data-testid="stale" className={notice}>
          A lista de verificação está desatualizada: houve mudanças depois da última avaliação.
        </p>
      )}
      {jevAdvisory && <p className={notice}>O Jev é obrigatório no refinamento: ele valida os documentos e decide pontos da avaliação, e seus apontamentos são considerados por Claude, PO e SM. <InfoTip text={jevInfo} /></p>}
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3">
        <span className="inline-flex items-start gap-[0.45rem] text-[0.8125rem] leading-[1.35] text-ink-soft"><Icon name="info" size={18} />As alterações são salvas automaticamente ao sair do editor.</span>
      </div>
    </section>
  );
  // A new project offers one step at a time: the start, or the evaluation, never two primary actions.
  const showEvaluate = !newProject || stageStep === 'evaluate' || (stageStep === 'start' && !evaluating);
  const startButton = (
    <ActionButton data-testid="start" className={newProject ? 'primary min-w-40 flex-auto' : 'primary mb-4 w-full'} busy={p.startState?.busy ?? false} disabled={!canStart} onClick={p.onStart} icon={<Icon name="play" size={16} />}>
      {p.startState?.label ?? 'Iniciar análise'}
    </ActionButton>
  );
  const reviewPanel = (
    <section className={panelCard}>
      <div className={panelHeading}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={`${headingTile} text-[color:var(--tile-violet-ink)] [background:var(--tile-violet)]`}><Icon name="clipboard" size={26} /></span>
          <div><span className={eyebrow}>Refinamento</span>
          <h2 className={panelTitle}>Área de revisão</h2>
          </div>
        </div>
        <Tipped text="Quantas perguntas dos agentes e sugestões de documento ainda esperam a sua decisão.">
          <span className={`count-pill ${openCount > 0 ? 'tone-warn' : 'tone-good'}`}>{openCount === 1 ? '1 pendência em aberto' : `${openCount} pendências em aberto`}</span>
        </Tipped>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {newProject && (stageStep === 'start' || stageStep === 'started') && startButton}
        {showEvaluate && (
        <ActionButton data-testid="evaluate" className={`${newProject && stageStep !== 'evaluate' ? 'secondary' : 'primary'} min-w-40 flex-auto`} busy={evaluating} disabled={locked || atMax} onClick={unchanged ? () => setAskRe(true) : p.onEvaluate} icon={<Icon name="check" size={16} />}>
          {st.cycle === 0 ? 'Avaliar' : 'Reavaliar'}
        </ActionButton>
        )}
        {askRe && (
          <ConfirmDialog title="Reavaliar sem mudanças" confirmLabel="Reavaliar mesmo assim" onConfirm={() => { setAskRe(false); void p.onEvaluate(); }} onCancel={() => setAskRe(false)}>
            <p>Nada mudou desde a última avaliação. Reavaliar gasta de novo as chamadas dos agentes (cerca de US$ 0,7) e pode dar um veredito diferente sobre os mesmos documentos.</p>
          </ConfirmDialog>
        )}
      </div>
      {!newProject && startButton}
      {nextStep !== null && <p className="m-0 mb-4 flex items-start gap-[0.6rem] rounded-lg border border-accent-line bg-accent-soft p-[0.85rem] text-[0.8125rem] leading-[1.45] text-ink [&_svg]:flex-none [&_svg]:text-accent-text"><Icon name="lightbulb" size={20} /><span><b>Próximo passo:</b> {nextStep}{optional}</span></p>}
      {evaluating ? null : current ? (
        <div className="rounded-lg border border-line bg-surface-sunken p-4">
          <div className="flex flex-wrap items-center gap-[0.35rem]">
            <span className={badge(current.role)}>{current.role.toUpperCase()}</span>
            <InfoTip text={roleInfo[current.role]} />
            {current.blocking && <Tipped text="Pergunta que bloqueia o avanço: precisa de resposta antes de seguir."><span className="tag ml-0">Obrigatória</span></Tipped>}
          </div>
          <p className="text-justify">{questionText(current.text)}</p>
          {current.relatedAcIds.length > 0 && (
            <small className="question-criteria block leading-[1.6] text-ink-soft [&_.info-tip]:ml-[0.15rem]">
              Critérios de aceite:{' '}
              {current.relatedAcIds.map((id, i) => {
                const criterion = criteria.find((c) => c.id === id);
                return <Fragment key={id}>{i > 0 ? ', ' : ''}{id}{criterion ? <InfoTip text={criterionText(criterion)} /> : null}</Fragment>;
              })}
            </small>
          )}
          {current.options && current.options.length > 0 && (
            <div role="radiogroup" aria-label="Opções de resposta" className="mt-4 grid gap-2">
              <p className="m-0 text-[0.8125rem] text-ink-soft">Escolha uma opção ou escreva a sua resposta abaixo.</p>
              {current.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  role="radio"
                  aria-checked={answer === o.label}
                  disabled={locked}
                  onClick={() => setAnswer(o.label)}
                  className={`h-auto grid gap-[0.15rem] rounded-lg border px-3 py-2 text-left ${answer === o.label ? 'border-accent-line bg-accent-soft' : 'border-line bg-surface'}`}
                >
                  <b className="text-[0.875rem]">
                    {o.label}
                    {o.recommended && <span className="ml-2 text-[0.75rem] font-semibold text-accent-text">Recomendada</span>}
                  </b>
                  <span className="text-[0.8125rem] text-ink-soft">{o.detail}</span>
                </button>
              ))}
            </div>
          )}
          <label className="mt-4 mb-[0.4rem] block text-[0.8125rem] font-semibold text-ink-soft" htmlFor="refinement-answer">Sua resposta</label>
          <textarea id="refinement-answer" data-testid="answer" className="min-h-28 w-full resize-y p-4 text-[0.9rem] leading-normal" value={answer} onChange={(e) => setAnswer(e.target.value)} />
          {/* A long label wraps under its text, so the checkbox and the tip sit on the first line. */}
          <div className="mt-3 mb-4 flex items-start gap-[0.35rem] text-[0.8125rem] leading-5 text-ink-soft [&_.info-tip]:mt-[0.1rem]">
            <label className="inline-flex cursor-pointer items-start gap-2">
              <input type="checkbox" className="m-0 mt-0.5 size-4 flex-none cursor-pointer" data-testid="docs-answered" checked={docsAnswered} onChange={(e) => setDocsAnswered(e.target.checked)} />
              Os documentos já respondiam esta pergunta
            </label>
            <InfoTip text="Marque quando a resposta já estava nos documentos: essas marcas medem quando o Jev pode responder sozinho." />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <ActionButton
              className="primary"
              data-testid={`answer-${current.questionId}`}
              disabled={locked || answer.trim() === ''}
              onClick={() => {
                const sent = p.onAnswer(current.questionId, answer, docsAnswered);
                setAnswer('');
                setDocsAnswered(false);
                return sent;
              }}
              icon={<Icon name="send" size={16} />}
            >
              Responder
            </ActionButton>
            {!current.blocking && (
              <ActionButton data-testid={`skip-${current.questionId}`} disabled={locked} onClick={() => p.onSkip(current.questionId)} icon={<Icon name="chevron-right" size={16} />}>
                Ignorar
              </ActionButton>
            )}
          </div>
          <small className="mt-2 block text-ink-soft">{pending.length === 1 ? 'Esta é a última pergunta em aberto.' : pending.length === 2 ? 'Mais 1 pergunta depois desta.' : `Mais ${pending.length - 1} perguntas depois desta.`}</small>
        </div>
      ) : (
        <p className={muted}>Nenhuma pergunta em aberto.</p>
      )}
      {(evaluating ? [] : st.patches)
        .filter((x) => x.status === 'pending')
        .map((x, i) => (
          <div key={x.patchId} className="mt-4 rounded-lg border border-line bg-surface p-[0.85rem]">
            <div className="flex flex-wrap items-center gap-[0.45rem] text-[0.82rem] text-ink">
              <span className={badge(x.role)}>{x.role === 'front' ? 'FRONT' : x.role.toUpperCase()}</span>
              <b>{isApproval(x) ? 'Aprovação de ajuste' : `Sugestão para ${docName(x.file)}`}</b>
              {i === 0 ? <InfoTip text={patchInfo} /> : null}
              <span className="flex-[1_1_100%] leading-[1.4] text-ink-soft">{x.reason}</span>
            </div>
            <pre className="mx-0 my-3 overflow-auto rounded-md bg-term-bg p-[0.8rem] text-[0.75rem] leading-normal text-term-ink">{x.diff}</pre>
            <div className="grid grid-cols-2 items-center gap-2">
            <ActionButton className="min-w-[5.5rem] border-good-line bg-good-soft text-good hover:enabled:border-good" data-testid={`accept-${x.patchId}`} disabled={locked || deciding !== null} onClick={() => decide(x.patchId, () => p.onAccept(x.patchId))} icon={<Icon name="check" size={16} />}>
              Aceitar
            </ActionButton>
            <input
              className="col-span-full row-start-1 m-0 w-full min-w-0"
              data-testid={`reject-reason-${x.patchId}`}
              aria-label="Motivo da rejeição (opcional)"
              placeholder="Motivo (opcional)"
              value={reasons[x.patchId] ?? ''}
              onChange={(e) => setReasons({ ...reasons, [x.patchId]: e.target.value })}
            />
            <ActionButton className="min-w-[5.5rem] border-bad-line bg-bad-soft text-bad hover:enabled:border-bad" data-testid={`reject-${x.patchId}`} disabled={locked || deciding !== null} onClick={() => decide(x.patchId, () => p.onReject(x.patchId, reasons[x.patchId] || null))} icon={<Icon name="close" size={16} />}>
              Rejeitar
            </ActionButton>
            </div>
          </div>
        ))}
      {st.discarded.map((d, i) => (
        <p key={i} className={notice}>
          Uma sugestão do {d.role.toUpperCase()} para {docName(d.file)} não pôde ser aplicada e foi descartada ({d.reason}).
        </p>
      ))}
      <details className="group mt-5" open>
      <summary className="mx-0 mb-[0.7rem] flex cursor-pointer list-none items-center gap-[0.55rem] text-[0.8rem] tracking-[0.06em] text-ink uppercase [&>svg]:text-ink-soft [&::-webkit-details-marker]:hidden"><Icon name="clock" size={20} /><span className="flex-1">Histórico · {st.questions.filter((q) => q.status !== 'pending').length + st.patches.filter((x) => x.status !== 'pending').length}</span><span className="text-ink-soft transition-transform group-open:rotate-90"><Icon name="chevron-right" size={18} /></span></summary>
      <ul className="m-0 list-none rounded-lg border border-line bg-surface px-4 py-[0.8rem] text-[0.8rem] leading-normal text-justify text-ink-soft empty:grid empty:min-h-[3.3rem] empty:place-items-center empty:before:text-ink-soft empty:before:content-['Nenhum_registro_no_momento.'] [&>li+li]:mt-[0.6rem] [&>li+li]:border-t [&>li+li]:border-line [&>li+li]:pt-[0.6rem]">
        {[...st.questions]
          .filter((q) => q.status !== 'pending')
          .reverse()
          .map((q) => (
            <li key={q.questionId}>
              <span className={badge(q.role)}>{q.role.toUpperCase()}</span> {questionText(q.text)} → {q.status === 'skipped' ? <i>ignorada</i> : q.answer}{q.answeredBy ? <i> (suposição do {q.answeredBy.toUpperCase()}, tirada dos documentos)</i> : null}
            </li>
          ))}
        {[...st.patches]
          .filter((x) => x.status !== 'pending')
          .reverse()
          .map((x) => (
            <li key={x.patchId}>
              {isApproval(x) ? 'Aprovação de ajuste' : `Sugestão para ${docName(x.file)}`} ({x.reason}) → {x.status === 'accepted' ? 'aceita' : x.status === 'rejected' ? 'rejeitada' : 'descartada'}
              {x.decision ? `: ${x.decision}` : ''}
            </li>
          ))}
      </ul>
      </details>
    </section>
  );
  const qualityPanel = (
    <section className={qualityCard}>
      <div className={panelHeading}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={`${headingTile} text-[color:var(--tile-good-ink)] [background:var(--tile-good)]`}><Icon name="shield" size={26} /></span>
          <div><span className={eyebrow}>Controle de qualidade</span>
          <h2 className={panelTitle}>Lista de verificação</h2>
          </div>
        </div>
        <span className={`status-dot ${listState.tone}`}>{listState.label}</span>
      </div>
      <div className="mb-4 rounded-lg border border-line bg-surface px-[0.9rem] py-3">
        <p className="m-0 mb-[0.45rem] text-[0.8125rem] font-semibold text-ink">Consumo de IA no refinamento</p>
        <dl className="m-0 grid gap-[0.3rem] [&_dd]:m-0 [&_dd]:text-[0.875rem] [&_dd]:font-semibold [&_dd]:text-ink [&_dd]:tabular-nums [&_dt]:inline-flex [&_dt]:items-center [&_dt]:gap-[0.3rem] [&_dt]:text-[0.8125rem] [&_dt]:text-ink-soft [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-4">
          <div>
            <dt>Chamadas<InfoTip text="Quantas vezes um agente de IA foi acionado neste refinamento, somando todas as rodadas de avaliação." /></dt>
            <dd>{snap.tokens.steps}</dd>
          </div>
          <div>
            <dt>Tokens<InfoTip text={`Volume de texto processado pelos modelos de IA: ${snap.tokens.inputTokens} tokens lidos e ${snap.tokens.outputTokens} escritos. O custo cresce com o número de tokens.`} /></dt>
            <dd>{snap.tokens.inputTokens + snap.tokens.outputTokens}</dd>
          </div>
          <div>
            <dt>Custo estimado<InfoTip text="Estimativa em dólares das chamadas aos modelos de IA neste refinamento, calculada pelos preços de API." /></dt>
            <dd>US$ {snap.tokens.costUsd.toFixed(2)}</dd>
          </div>
        </dl>
      </div>
      {backlogFirst && backlogBlock}
      <div className={`grid gap-[0.3rem] ${evaluating ? 'opacity-60' : ''}`} aria-busy={evaluating || undefined}>
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[0.8125rem] font-semibold text-ink-soft [&::-webkit-details-marker]:hidden"><span className="flex-none transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span><span className="flex-1">Produto (PO)</span></summary>
          <Checklist items={st.checklist} role="po" />
        </details>
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[0.8125rem] font-semibold text-ink-soft [&::-webkit-details-marker]:hidden"><span className="flex-none transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span><span className="flex-1">Técnico (SM)</span></summary>
          <Checklist items={st.checklist} role="sm" />
        </details>
      </div>
      {!backlogFirst && backlogBlock}
      <h4><Icon name="file" size={20} />Arquivos gerados<InfoTip text="Versão estruturada dos documentos, gerada pelo Claude a cada avaliação. O project.json descreve o projeto; o spec.json, esta demanda, com tarefas e critérios de aceite." /></h4>
      {!backlogOn && (
        <>
      {st.derived?.spec && <p data-testid="spec-type">Tipo da demanda: <strong>{typeLabel[st.derived.spec.type] ?? st.derived.spec.type}</strong></p>}
      {st.derived?.spec.type === 'bug' && st.derived.spec.bug && (
        <div data-testid="bug-details" className={`grid gap-[0.2rem] ${notice}`}>
          <strong>Detalhes do bug</strong>
          <span>Comportamento atual: {st.derived.spec.bug.actual}</span>
          <span>Comportamento esperado: {st.derived.spec.bug.expected}</span>
          <span>Como reproduzir: {st.derived.spec.bug.reproduction}</span>
        </div>
      )}
      <LazyDetails className={fileBox} summary={<><span>spec.json</span>{st.derived ? <a data-testid="download-spec-json" href={jsonDownload(st.derived.spec)} download="spec.json" aria-label="Baixar spec.json" onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a> : <span className={fileStatus}>Aguardando avaliação</span>}</>} body={() => st.derived ? <pre className="whitespace-pre-wrap break-words">{JSON.stringify(st.derived.spec, null, 2)}</pre> : <p className={fileEmpty}>Será gerado após a avaliação.</p>} />
        </>
      )}
      {backlogOn && (
        <LazyDetails key="specs" className={fileBox} summary={<><span>specs.json</span>{specsIndex ? <a data-testid="download-specs-json" href={jsonDownload(specsIndex)} download="specs.json" aria-label="Baixar specs.json" onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a> : <span className={fileStatus}>Aguardando avaliação</span>}</>} body={() => specsIndex ? <pre className="whitespace-pre-wrap break-words">{JSON.stringify(specsIndex, null, 2)}</pre> : <p className={fileEmpty}>Será gerado após a avaliação.</p>} />
      )}
      <LazyDetails className={fileBox} summary={<><span>project.json</span>{projectJson ? <a data-testid="download-project-json" href={jsonDownload(projectJson)} download="project.json" aria-label="Baixar project.json" onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a> : <span className={fileStatus}>Aguardando avaliação</span>}</>} body={() => projectJson ? <pre className="whitespace-pre-wrap break-words">{JSON.stringify(projectJson, null, 2)}</pre> : <p className={fileEmpty}>Será gerado após a avaliação.</p>} />
      {docFiles.map(({ doc, name, text }) => (
        <LazyDetails key={name} className={fileBox} summary={<><span>{name}</span><a data-testid={`download-${name.replace('.', '-')}`} href={jsonDownload(docToJson(doc, text))} download={name} aria-label={`Baixar ${name}`} onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a></>} body={() => <pre className="whitespace-pre-wrap break-words">{JSON.stringify(docToJson(doc, text), null, 2)}</pre>} />
      ))}
      {!backlogOn && (
        <>
      <h4><Icon name="list" size={20} />Tarefas<InfoTip text="Tarefas descritas no briefing, extraídas a cada avaliação. Na execução, o SM as usa para montar o plano de trabalho." /></h4>
      <ul className="m-0">
        {(st.derived?.spec.tasks ?? []).map((t, i) => (
          <li key={i}>
            <b>{t.title}</b>: {t.description}
          </li>
        ))}
      </ul>
      {(st.derived?.spec.tasks ?? []).length === 0 && <div className="grid place-items-center gap-[0.35rem] rounded-lg border border-line bg-surface-sunken px-[0.8rem] py-[1.4rem] text-center text-ink-soft [&_svg]:text-ink-faint"><Icon name="clipboard" size={26} /><strong className="text-[0.85rem] text-ink">Nenhuma tarefa gerada ainda.</strong><span className="text-[0.78rem]">As tarefas aparecerão aqui após a avaliação.</span></div>}
        </>
      )}
      <div className="mt-5 flex items-center justify-between gap-3"><h4 className="m-0!"><Icon name="lock" size={20} />Segredos<InfoTip text="Chaves e senhas de serviços externos que o projeto usa, como a URL de um banco de dados. Ficam salvas neste computador e o valor nunca volta a ser exibido." /></h4><button type="button" className="secondary h-10 px-[0.7rem] text-[0.78rem]" onClick={() => setNewSecrets((rows) => [...rows, { id: Date.now(), name: '', value: '' }])}>Adicionar segredo<Icon name="plus" size={16} /></button></div>
      <ul className="m-0 grid list-none gap-3 p-0">
        {snap.secrets.map((s) => (
          <li key={s.name} className={`${secretRow} border-line bg-surface-sunken`}>
            {/* A hint made only of asterisks is a mask, not a hint: it tells the user nothing. */}
            <div className="flex min-w-0 items-center gap-[0.45rem]"><code className="mr-auto text-[0.78rem] font-bold text-ink wrap-anywhere">{s.name}</code><InfoTip label={s.name} text={secretTip(s)} />{s.hint && /[^*]/.test(s.hint) && <small className="text-[0.7rem] text-ink-soft">termina em {s.hint}</small>}<span className={`status-dot ${s.present ? 'ok' : 'warn'}`}>{s.present ? 'Salvo' : 'Não salvo'}</span></div>
            <div className={`${secretEntry} grid-cols-[minmax(0,1fr)_7rem]`}><input type="password" autoComplete="new-password" className={secretInput} data-testid={`secret-${s.name}`} aria-label={`Novo valor de ${s.name}`} placeholder={s.present ? 'Digite um novo valor para substituir' : 'Cole o valor da chave'} value={secretValues[s.name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [s.name]: e.target.value })} /><ActionButton className={secretSave} data-testid={`save-secret-${s.name}`} disabled={!(secretValues[s.name] ?? '')} onClick={() => { const value = secretValues[s.name]!; setSecretValues({ ...secretValues, [s.name]: '' }); return p.onSecret(s.name, value); }} icon={<Icon name="check" size={14} />}>Salvar</ActionButton></div>
          </li>
        ))}
        {newSecrets.map((s) => <li key={s.id} className={`${secretRow} border-accent-line bg-accent-soft`}><div className="flex items-center gap-[0.45rem] text-[0.78rem] font-bold text-ink">Nova variável<InfoTip text="Valor sigiloso que o projeto lê para acessar um serviço externo, como NATS_URL com o endereço do servidor de mensagens. Fica salvo neste computador e o valor nunca volta a ser exibido." /></div><div className={`${secretEntry} grid-cols-[minmax(8rem,0.7fr)_minmax(0,1fr)_auto] max-[720px]:grid-cols-1`}><input className={secretInput} aria-label="Nome da chave" placeholder="NOME_DA_CHAVE" value={s.name} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === s.id ? { ...row, name: e.target.value.toUpperCase() } : row))} /><input type="password" autoComplete="new-password" className={secretInput} aria-label="Valor da chave" placeholder="Cole o valor da chave" value={s.value} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === s.id ? { ...row, value: e.target.value } : row))} /><button className={secretSave} disabled={!/^[A-Z][A-Z0-9_]*$/.test(s.name) || !s.value} onClick={() => { p.onSecret(s.name, s.value); setNewSecrets((rows) => rows.filter((row) => row.id !== s.id)); }}>Salvar<Icon name="check" size={16} /></button></div></li>)}
      </ul>
    </section>
  );
  return (
    <Workspace
      columns="lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)_minmax(0,1fr)]"
      // Below lg, review and quality share one column with one scroll; from lg each panel gets its own column.
      groupClass="grid min-h-0 min-w-0 content-start gap-6 lg:-m-1 lg:overflow-y-auto lg:p-1 max-lg:[&>section]:min-h-auto max-lg:[&>section]:overflow-visible lg:contents"
      panels={[
        { id: 'docs', label: 'Documentos', content: docsPanel },
        { id: 'review', label: 'Revisão', content: reviewPanel, group: 'side' },
        { id: 'quality', label: 'Verificação', content: qualityPanel, group: 'side' },
      ]}
    />
  );
}

export function RefinementPage() {
  const { projectId = '', specId = '' } = useParams();
  // Another session remounts the page, so no state or replayed event of the previous one carries over.
  return <RefinementSession key={`${projectId}/${specId}`} projectId={projectId} specId={specId} />;
}

function RefinementSession({ projectId, specId }: { projectId: string; specId: string }) {
  const navigate = useNavigate();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const applied = useRef(0);
  const { events } = useJournal(snap ? refineApi.events(projectId, specId) : null);
  const load = () =>
    refineApi
      .snapshot(projectId, specId)
      .then((s) => {
        // The snapshot already holds every event up to its seq: the replay applies only the ones after it.
        applied.current = s.seq ?? 0;
        setSnap({ ...s, docsDirty: false });
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [projectId, specId]);
  // The program ledger moves with the runs, not with the refinement journal: poll it while a started backlog is on screen.
  const following = snap?.state.status === 'started' && snap.state.backlog?.enabled === true;
  const { program, phases } = useProgram(projectId, specId, following);
  const programPath = `/refine/${projectId}/${specId}/program`;
  useEffect(() => {
    if (!snap) return;
    const fresh = events.filter((e) => e.seq > applied.current);
    if (fresh.length === 0) return;
    applied.current = fresh[fresh.length - 1].seq;
    const next = applyBatch(snap, fresh);
    // A started backlog opens its execution screen, which follows every spec with its own run link.
    const started = fresh.filter((e) => e.type === 'REFINE_STARTED_RUN').pop();
    if (started) navigate(next.state.backlog?.enabled ? programPath : `/runs/${String(started.data.runId)}`);
    if (next.docsDirty) void load();
    else setSnap(next);
  }, [events, snap]);
  const now = useMemo(() => stageNow(events, snap?.state.cycle ?? 0), [events, snap?.state.cycle]);
  if (!snap) return (
    <main>
      {error ? <p className="error">{error}</p> : <Loading />}
    </main>
  );
  const act = (f: () => Promise<unknown>) => () => {
    setError(null);
    return f().catch((e: Error) => setError(e.message));
  };
  const startRun = act(() => {
    setStarting(true);
    return refineApi.start(projectId, specId).then(({ runId, program: started }) => navigate(started ? programPath : `/runs/${runId}`)).finally(() => setStarting(false));
  });
  const executing = starting || (following && program?.status !== 'finished');
  return (
    <main className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <header className="refine-breadcrumb"><Link to="/projects" aria-label="Voltar para projetos"><Icon name="home" size={18} /><span>Projetos</span></Link><span>›</span><strong>{projectId}</strong><span>›</span><span>{specId} {snap?.state.mode === 'new-spec' ? 'spec nova' : 'rascunho'}</span></header>
      <MoveNotice moves={snap.state.moves ?? []} onUndo={(moveId) => act(() => refineApi.undoMove(projectId, specId, moveId))()} docName={docName} />
      {snap.state.mode === 'new-project' && <StageBar stages={stageOf({ ...snap.state, released: snap.limits !== undefined && released(snap.state, snap.limits) })} />}
      {snap.state.status === 'evaluating' && <ProcessingBanner backlog={snap.state.backlog} cycle={snap.state.cycle} stage={now.stage} jevDown={now.jevDown} running={now.running} title={snap.state.mode === 'new-project' ? stageTitle(snap.state) : undefined} />}
      {following && <ProgramStatus program={program} titles={Object.fromEntries(snap.state.backlog!.items.map((i) => [i.key, i.title]))} phases={phases} link={programPath} />}
      {(error || snap.state.status === 'error') && (
        <div className="error mx-auto w-[min(100%,48rem)] text-center" role="alert">
          <p>{errorText(error ?? snap.state.error)}</p>
          {(error ?? snap.state.error)?.startsWith('Jev indisponível') && <JevActions />}
        </div>
      )}
      <RefinementView
        snap={snap}
        busy={snap.state.status === 'evaluating'}
        onSaveDoc={(f, t) => act(() => refineApi.saveDoc(projectId, specId, f, t))()}
        onSuggestDoc={(f) => {
          setError(null);
          return refineApi.suggestDoc(projectId, specId, f).then((r) => r.text, (e: Error) => (setError(e.message), null));
        }}
        onDesignFromImages={(images) => {
          setError(null);
          return refineApi.suggestDesignFromImages(projectId, specId, images).then((r) => r.text, (e: Error) => (setError(e.message), null));
        }}
        onEvaluate={act(() => refineApi.evaluate(projectId, specId))}
        onEnableBacklog={act(() => refineApi.enableBacklog(projectId, specId))}
        onAnswer={(id, t, d) => act(() => refineApi.answer(projectId, specId, id, t, d))()}
        onSkip={(id) => act(() => refineApi.skip(projectId, specId, id))()}
        onAccept={(id) => act(() => refineApi.accept(projectId, specId, id))()}
        onReject={(id, r) => act(() => refineApi.reject(projectId, specId, id, r))()}
        onSecret={(n, v) => act(() => refineApi.secret(projectId, specId, n, v).then(load))()}
        onStart={startRun}
        startState={{ label: starting ? 'Iniciando…' : executing ? 'Em execução' : 'Iniciar análise', busy: executing }}
        events={events}
      />
    </main>
  );
}
