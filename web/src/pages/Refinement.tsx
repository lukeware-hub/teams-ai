import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, refineApi, type AcceptanceCriterion, type ChecklistItem, type Snapshot, type StoredEvent } from '../api.js';
import { applyToSnapshot, type LiveSnapshot } from '../refine/reducer.js';
import { useJournal } from '../useSse.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { buildSpecsIndex } from '@server/refine/specs-index';
import { BacklogPanel } from '../refine/BacklogPanel.js';
import { canStartRun, ProgramStatus, useProgram } from '../refine/ProgramPanel.js';
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
/** Backlog mode: the briefing is the target project's docs/briefing.md, one file for the whole backlog. */
const briefingImpact = 'Briefing do projeto (docs/briefing.md): objetivos, prioridades, cortes e decisões que valem para todo o backlog. Os agentes seguem o que estiver escrito aqui.';
const docName = (file: string) => docLabel[file.split('/').pop() as DocFile] ?? file;
const roleInfo: Record<'po' | 'sm', string> = {
  po: 'Pergunta do PO (Product Owner), o agente que revisa objetivos, critérios de aceite e o fluxo de negócio.',
  sm: 'Pergunta do SM (Scrum Master), o agente que revisa stack, tarefas, validação e viabilidade técnica.',
};
const checkLabel: Record<string, string> = {
  'po.objectives-verifiable': 'Objetivos verificáveis',
  'po.personas': 'Público e personas definidos',
  'po.scope-explicit': 'Escopo explícito',
  'po.no-contradictions': 'Documentos sem contradições',
  'sm.dependencies-and-secrets': 'Dependências e segredos informados',
  'sm.constraints-clear': 'Restrições técnicas claras',
  'sm.tasks-feasible': 'Tarefas viáveis',
  'sm.no-open-questions': 'Sem perguntas obrigatórias em aberto',
  'sm.flow-is-mermaid': 'flow.md é um diagrama mermaid',
};
/** The server writes these details itself; details written by the agents pass through unchanged. */
const checkDetail = (detail: string) => {
  if (detail === 'not reported') return 'O agente não avaliou este item.';
  if (detail === 'every listed secret is present') return 'Todos os segredos necessários estão salvos.';
  if (detail === 'no blocking question open') return 'Nenhuma pergunta obrigatória em aberto.';
  if (detail === 'flow.md has a mermaid diagram') return 'flow.md tem um diagrama mermaid.';
  if (detail === 'flow.md has no ```mermaid block; it must be a diagram, not markdown headings') return 'flow.md precisa ser um diagrama mermaid, não títulos em markdown.';
  const missing = /^missing secrets: (.+)$/.exec(detail);
  if (missing) return `Faltam segredos: ${missing[1]}.`;
  const open = /^(\d+) blocking question\(s\) open$/.exec(detail);
  if (open) return open[1] === '1' ? '1 pergunta obrigatória em aberto.' : `${open[1]} perguntas obrigatórias em aberto.`;
  return detail;
};
const criterionText = (c: AcceptanceCriterion) => `${c.id}: dado ${c.given}, quando ${c.when}, então ${c.then}`;
const startInfo = 'Os agentes passam a planejar, implementar, testar e publicar o projeto com base nestes documentos. Fica disponível com a lista atualizada e atendida, sem perguntas obrigatórias ou sugestões pendentes.';
const jevInfo = 'O Jev é obrigatório no refinamento. Ele confere se os cinco documentos estão consistentes entre si e classifica e decide pontos da avaliação: critérios de aceite ainda não prontos, perguntas repetidas e contradições com o histórico do projeto. Sem ele, a avaliação não inicia. Ajuste o que fizer sentido e reavalie.';
const evaluationInfo = 'Cada clique em Avaliar abre uma rodada: o Jev confere a consistência dos documentos, o Claude gera o spec.json e o project.json, os agentes PO, SM e Front revisam e sugerem ajustes, e o Jev também aponta critérios ainda não prontos, descarta perguntas repetidas e sinaliza contradições com o histórico.';
const patchInfo = 'Mudança proposta por um agente: linhas com - saem e linhas com + entram. Aceitar aplica a mudança no documento; Rejeitar a descarta, e o motivo opcional fica no histórico.';
const jsonDownload = (value: unknown) => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value, null, 2))}`;

const panelCard = 'edge-lit min-w-0 rounded-xl border border-line bg-surface p-5 shadow-card';
// The checklist panel styles the headings, lists and file disclosures inside it, the backlog and coverage tree included.
const qualityCard = `${panelCard} [&_details]:my-2 [&_details]:rounded-lg [&_details]:border [&_details]:border-line [&_details]:bg-surface [&_details]:p-[0.85rem] [&_details]:text-[0.8rem] [&_details_pre]:max-h-48 [&_details_pre]:overflow-auto [&_details_pre]:text-[0.7rem] [&_details_pre]:text-ink-soft [&_details_summary]:flex [&_details_summary]:cursor-pointer [&_details_summary]:items-center [&_details_summary]:justify-between [&_details_summary_svg]:text-accent-text [&_h4]:mx-0 [&_h4]:mt-5 [&_h4]:mb-[0.7rem] [&_h4]:flex [&_h4]:items-center [&_h4]:gap-[0.55rem] [&_h4]:text-[0.8rem] [&_h4]:tracking-[0.06em] [&_h4]:text-ink [&_h4]:uppercase [&_h4>svg]:text-ink-soft [&_h5]:mx-0 [&_h5]:mt-4 [&_h5]:mb-[0.45rem] [&_h5]:text-[0.72rem] [&_h5]:tracking-[0.08em] [&_h5]:text-ink-soft [&_h5]:uppercase [&_ul]:pl-[1.1rem] [&_ul]:text-[0.8rem] [&_ul]:leading-[1.45]`;
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
const startGroup = 'ml-auto flex items-center gap-2 max-[720px]:ml-0 max-[720px]:w-full';
const secretRow = 'grid gap-[0.45rem] rounded-lg border p-3';
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
      <button type="button" className="rounded-md border-current bg-transparent px-[0.6rem] py-[0.2rem] text-[0.75rem] font-semibold text-current disabled:cursor-default disabled:opacity-60" data-testid="jev-validate" disabled={check.checking} onClick={validate}>{check.checking ? 'Validando…' : 'Validar conexão'}<Icon name="check" size={14} /></button>
      <Link className="font-semibold text-current underline" to="/onboarding?item=openrouter">Informar nova chave</Link>
      {check.ok !== undefined && <span data-testid="jev-validate-result">{check.ok ? 'Conexão com o OpenRouter funcionando. Clique em Reavaliar.' : `Falha na conexão: ${check.detail ?? 'chave inválida.'}`}</span>}
    </span>
  );
}

function currentClaudeStage(events: StoredEvent[], cycle: number, jevEvent: StoredEvent | undefined, derived: boolean): string {
  if (!jevEvent) return 'Jev está validando os cinco documentos do projeto.';
  if (jevEvent.data.available === false) return 'Jev indisponível: confira a chave do OpenRouter. A avaliação não continua sem ele.';
  if (jevEvent.data.decision === 'blocked') return 'Jev encontrou pontos importantes para revisão; PO e SM vão avaliá-los.';
  if (jevEvent.data.decision === 'review') return 'Jev encontrou pontos para revisão; Claude está analisando os documentos.';

  const cycleEvents = events.filter((e) => Number(e.data.attempt) === cycle || Number(e.data.cycle) === cycle);
  const started = new Map<string, { kind: string; role: string }>();
  for (const event of cycleEvents) {
    if (event.type === 'STEP_STARTED') started.set(String(event.data.stepId), { kind: String(event.data.kind), role: String(event.data.role) });
    if (event.type === 'STEP_FINISHED') started.delete(String(event.data.stepId));
  }
  const active = [...started.values()];
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
  onEvaluate(): void;
  onEnableBacklog?(): void;
  onEnableDetail?(): void;
  onAnswer(id: string, text: string, docsAnswered: boolean): void;
  onSkip(id: string): void;
  onAccept(id: string): void;
  onReject(id: string, reason: string | null): void;
  onSecret(name: string, value: string): void;
  onStart(): void;
  startInHeader?: boolean;
  events?: StoredEvent[];
}

function Checklist({ items, role }: { items: ChecklistItem[]; role: 'po' | 'sm' }) {
  const own = items.filter((i) => i.role === role);
  if (own.length === 0) return <p className={fileEmpty}>Preenchida na primeira avaliação.</p>;
  return (
    <ul className="m-0 list-none rounded-lg border border-line bg-surface py-[0.55rem] pr-3 pl-[1.1rem] text-[0.8rem] leading-[1.45]">
      {own.map((i) => (
        <li key={i.id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 py-[0.4rem] text-[0.8125rem] text-ink">
          <span className={`grid h-5 place-items-center ${i.passed ? 'text-good' : 'text-bad'}`} role="img" aria-label={i.passed ? 'Atendido' : 'Não atendido'}><Icon name={i.passed ? 'check' : 'close'} size={16} /></span>
          <span>{checkLabel[i.id] ?? i.id.slice(3)}<small className="mx-0 mt-[0.15rem] mb-0 block leading-[1.35] text-ink-soft">{checkDetail(i.detail)}</small></span>
        </li>
      ))}
    </ul>
  );
}

export function RefinementView(p: ViewProps) {
  const { snap, busy } = p;
  const st = snap.state;
  const [tab, setTab] = useState<DocFile>('brief.md');
  const [docs, setDocs] = useState(snap.docs);
  const [suggesting, setSuggesting] = useState(false);
  const [answer, setAnswer] = useState('');
  const [docsAnswered, setDocsAnswered] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
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
  const canStart = canStartRun(st, busy);
  const backlogOn = st.backlog?.enabled === true;
  // Backlog mode lists specs, not one spec: the generated index replaces spec.json and the tasks of a single spec.
  const specsIndex = backlogOn && (st.backlog?.items.length ?? 0) > 0 ? buildSpecsIndex(snap.specId, st.backlog as never) : null;
  const projectJson = backlogOn ? st.backlog?.project ?? null : st.derived?.project ?? null;
  const derivedThisCycle = (p.events ?? []).some((e) => e.type === 'DERIVED' && Number(e.data.cycle) === st.cycle);
  const jevEvent = (p.events ?? []).find((e) => e.type === 'REFINE_DOCS_VALIDATED' && Number(e.data.cycle) === st.cycle);
  const jevDown = jevEvent?.data.available === false;
  const claudeStage = currentClaudeStage(p.events ?? [], st.cycle, jevEvent, derivedThisCycle);
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
  const nextStep = st.status === 'started' && st.backlog?.enabled
    ? 'Os agentes estão executando o backlog, até duas specs ao mesmo tempo quando não mexem no mesmo código. Acompanhe cada uma na tela de execução do backlog.'
    : st.status === 'evaluating'
    ? 'Aguarde o fim da avaliação; o andamento aparece logo abaixo.'
    : jevAdvisory
    ? 'O Jev apontou pontos nos documentos. Ajuste o que fizer sentido e clique em Reavaliar.'
    : pending.length > 0
    ? 'Responda às perguntas em aberto para continuar.'
    : st.stale
      ? 'Clique em Reavaliar para atualizar a lista de verificação com as últimas mudanças.'
      : st.status !== 'ready' && st.patches.some((x) => x.status === 'pending')
        ? 'Revise as sugestões de alteração abaixo e aceite ou rejeite cada uma.'
        : st.backlog?.enabled && st.status === 'ready'
          ? st.backlog.detail
            ? st.autoStartFailure?.cycle === st.cycle
              ? `O programa não começou sozinho: ${st.autoStartFailure.reason}. Corrija o motivo e clique em Iniciar análise, ou reavalie para ele tentar de novo.`
              : 'O backlog detalhado está pronto: cada item tem spec e pré-plano, e o programa começa sozinho em instantes. Para mudar algo antes, escreva nos documentos e reavalie.'
            : 'O backlog está pronto para revisão. Para mudar prioridades ou cortes, escreva no briefing.md e reavalie; quando o esboço estiver certo, clique em Detalhar specs para gerar a spec e o pré-plano de cada item.'
        : st.backlog?.detail
          ? 'Detalhamento pedido: clique em Reavaliar para gerar a spec e o pré-plano de cada item; o que faltar aparece em vermelho na cobertura.'
        : canStart
          ? 'Tudo pronto. Clique em Iniciar análise para os agentes desenvolverem o projeto.'
          : st.cycle === 0
            ? 'Revise os documentos e clique em Avaliar. Os agentes vão revisar a demanda e preencher a lista de verificação.'
            : 'Corrija nos documentos os itens não atendidos da lista de verificação e clique em Reavaliar.';
  // R11.10: once ready, a pending patch is a suggestion the owner may still take.
  const optional = st.status === 'ready' && !st.stale && st.patches.some((x) => x.status === 'pending') ? ' As sugestões abaixo são opcionais; aceitar uma pede nova avaliação.' : '';
  const existing = st.mode === 'new-spec' || st.mode === 'continue';
  const suggest = (file: Exclude<DocFile, 'flow.md'>) => {
    setSuggesting(true);
    void p.onSuggestDoc!(file)
      .then((text) => { if (text !== null) setDocs((d) => ({ ...d, [file]: text })); })
      .finally(() => setSuggesting(false));
  };
  const tabButton = (f: DocFile) => (
    <button
      key={f}
      className={`h-auto min-h-11 rounded-none border-0 border-b-2 bg-transparent px-3 py-[0.55rem] whitespace-nowrap transition-none hover:enabled:bg-surface-sunken hover:enabled:text-ink ${tab === f ? 'border-accent text-accent-text' : 'border-transparent text-ink-soft'}`}
      onClick={() => setTab(f)}
    >
      {docLabel[f]}
    </button>
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
        <div className="flex justify-end gap-2">
          {tab !== 'flow.md' && p.onSuggestDoc && (
            <button type="button" data-testid="suggest" className="h-9 px-[0.8rem]" disabled={locked || suggesting} title="Gera este documento a partir do flow.md" onClick={() => suggest(tab)}>
              {suggesting ? 'Sugerindo…' : 'Sugerir'}
              <Icon name="lightbulb" size={16} />
            </button>
          )}
          <button type="button" className="h-9 px-[0.8rem]" aria-label="Copiar documento" onClick={() => copyDoc(docs[tab] ?? '')}>
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
        <button data-testid="evaluate" className="primary min-w-40 justify-self-center" disabled={locked} onClick={p.onEvaluate}>
        {st.cycle === 0 ? 'Avaliar' : 'Reavaliar'}
        <Icon name="check" size={16} />
        </button>
        {st.status === 'evaluating' && <span className="justify-self-center text-[0.8125rem] text-ink-soft">Avaliando…</span>}
      </div>
    </section>
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
        <span className={`count-pill ${pending.length > 0 ? 'tone-warn' : 'tone-good'}`}>{pending.length === 1 ? '1 pergunta em aberto' : `${pending.length} perguntas em aberto`}</span>
      </div>
      <p className="m-0 mb-4 flex items-start gap-[0.6rem] rounded-lg border border-accent-line bg-accent-soft p-[0.85rem] text-[0.8125rem] leading-[1.45] text-ink [&_svg]:flex-none [&_svg]:text-accent-text"><Icon name="lightbulb" size={20} /><span><b>Próximo passo:</b> {nextStep}{optional}</span></p>
      {busy && (
        <div className={`mb-4 flex items-center gap-[0.7rem] rounded-lg border px-[0.8rem] py-[0.7rem] [&_.info-tip]:text-current ${jevDown ? 'border-bad-line bg-bad-soft text-bad' : 'border-good-line bg-good-soft text-good'}`} role="status" aria-live="polite">
          <span className={`size-[0.55rem] rounded-full motion-safe:animate-pulse ${jevDown ? 'bg-bad shadow-[0_0_0_4px_var(--bad-line)]' : 'bg-good-live shadow-[0_0_0_4px_var(--good-line)]'}`} aria-hidden="true" />
          <div className="grid flex-1 gap-[0.15rem]">
            <b className="text-[0.8125rem]">Avaliação em andamento <InfoTip text={evaluationInfo} /></b>
            <span className="text-[0.75rem] leading-[1.35]">Rodada {st.cycle} · {claudeStage}</span>
          </div>
          <span className="tracking-[0.15em] motion-safe:animate-pulse" aria-hidden="true">•••</span>
        </div>
      )}
      {evaluating ? (
        <p className={muted}>Avaliando… As perguntas e as sugestões aparecem aqui quando a avaliação terminar.</p>
      ) : current ? (
        <div className="rounded-lg border border-line bg-surface-sunken p-4">
          <div className="flex flex-wrap items-center gap-[0.35rem]">
            <span className={badge(current.role)}>{current.role.toUpperCase()}</span>
            <InfoTip text={roleInfo[current.role]} />
            {current.blocking && <span className="tag ml-0">Obrigatória</span>}
          </div>
          <p>{questionText(current.text)}</p>
          {current.relatedAcIds.length > 0 && (
            <small className="question-criteria block leading-[1.6] text-ink-soft [&_.info-tip]:ml-[0.15rem]">
              Critérios de aceite:{' '}
              {current.relatedAcIds.map((id, i) => {
                const criterion = criteria.find((c) => c.id === id);
                return <Fragment key={id}>{i > 0 ? ', ' : ''}{id}{criterion ? <InfoTip text={criterionText(criterion)} /> : null}</Fragment>;
              })}
            </small>
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
            <div className="flex items-center gap-2">
              <button
                className="primary"
                data-testid={`answer-${current.questionId}`}
                disabled={locked || answer.trim() === ''}
                onClick={() => {
                  p.onAnswer(current.questionId, answer, docsAnswered);
                  setAnswer('');
                  setDocsAnswered(false);
                }}
              >
                Responder
                <Icon name="send" size={16} />
              </button>
              {!current.blocking && (
                <button data-testid={`skip-${current.questionId}`} disabled={locked} onClick={() => p.onSkip(current.questionId)}>
                  Ignorar
                  <Icon name="chevron-right" size={16} />
                </button>
              )}
            </div>
            <small className="text-ink-soft">{pending.length === 1 ? 'Esta é a última pergunta em aberto.' : pending.length === 2 ? 'Mais 1 pergunta depois desta.' : `Mais ${pending.length - 1} perguntas depois desta.`}</small>
          </div>
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
              <b>Sugestão para {docName(x.file)}</b>
              {i === 0 ? <InfoTip text={patchInfo} /> : null}
              <span className="flex-[1_1_100%] leading-[1.4] text-ink-soft">{x.reason}</span>
            </div>
            <pre className="mx-0 my-3 overflow-auto rounded-md bg-term-bg p-[0.8rem] text-[0.75rem] leading-normal text-term-ink">{x.diff}</pre>
            <div className="grid grid-cols-2 items-center gap-2">
            <button type="button" className="min-w-[5.5rem] border-good-line bg-good-soft text-good hover:enabled:border-good" data-testid={`accept-${x.patchId}`} disabled={locked} onClick={() => p.onAccept(x.patchId)}>
              Aceitar
              <Icon name="check" size={16} />
            </button>
            <input
              className="col-span-full row-start-1 m-0 w-full min-w-0"
              data-testid={`reject-reason-${x.patchId}`}
              aria-label="Motivo da rejeição (opcional)"
              placeholder="Motivo (opcional)"
              value={reasons[x.patchId] ?? ''}
              onChange={(e) => setReasons({ ...reasons, [x.patchId]: e.target.value })}
            />
            <button type="button" className="min-w-[5.5rem] border-bad-line bg-bad-soft text-bad hover:enabled:border-bad" data-testid={`reject-${x.patchId}`} disabled={locked} onClick={() => p.onReject(x.patchId, reasons[x.patchId] || null)}>
              Rejeitar
              <Icon name="close" size={16} />
            </button>
            </div>
          </div>
        ))}
      {st.discarded.map((d, i) => (
        <p key={i} className={notice}>
          Uma sugestão do {d.role.toUpperCase()} para {docName(d.file)} não pôde ser aplicada e foi descartada ({d.reason}).
        </p>
      ))}
      <h4 className="mx-0 mt-5 mb-[0.7rem] flex items-center gap-[0.55rem] text-[0.8rem] tracking-[0.06em] text-ink uppercase [&>svg]:text-ink-soft"><Icon name="clock" size={20} />Histórico</h4>
      <ul className="m-0 list-none rounded-lg border border-line bg-surface px-4 py-[0.8rem] text-[0.8rem] leading-normal text-ink-soft empty:grid empty:min-h-[3.3rem] empty:place-items-center empty:before:text-ink-soft empty:before:content-['Nenhum_registro_no_momento.'] [&>li+li]:mt-[0.6rem] [&>li+li]:border-t [&>li+li]:border-line [&>li+li]:pt-[0.6rem]">
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
              Sugestão para {docName(x.file)} ({x.reason}) → {x.status === 'accepted' ? 'aceita' : x.status === 'rejected' ? 'rejeitada' : 'descartada'}
              {x.decision ? `: ${x.decision}` : ''}
            </li>
          ))}
      </ul>
      {!p.startInHeader && <div className={`mt-5 ${startGroup}`}>
        <button data-testid="start" className="primary w-full flex-auto px-4" disabled={!canStart} onClick={p.onStart}>
          Iniciar análise
          <Icon name="play" size={16} />
        </button>
        <InfoTip text={startInfo} />
      </div>}
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
            <dt>Etapas<InfoTip text="Quantas vezes um agente de IA foi acionado neste refinamento, somando todas as rodadas de avaliação." /></dt>
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
      <div className="grid gap-[0.3rem]"><h5>Produto (PO)</h5><Checklist items={st.checklist} role="po" /><h5>Técnico (SM)</h5><Checklist items={st.checklist} role="sm" /></div>
      <BacklogPanel backlog={st.backlog} evaluating={evaluating} locked={locked} ready={st.status === 'ready' && !st.stale} onEnable={p.onEnableBacklog} onDetail={p.onEnableDetail} />
      {st.backlog?.detail && <SpecTree backlog={st.backlog} evaluating={evaluating} />}
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
      <details>
        <summary><span>spec.json</span>{st.derived ? <a data-testid="download-spec-json" href={jsonDownload(st.derived.spec)} download="spec.json" aria-label="Baixar spec.json" onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a> : <span className={fileStatus}>Aguardando avaliação</span>}</summary>
        {st.derived ? <pre>{JSON.stringify(st.derived.spec, null, 2)}</pre> : <p className={fileEmpty}>Será gerado após a avaliação.</p>}
      </details>
        </>
      )}
      {backlogOn && (
        <details>
          <summary><span>specs.json</span>{specsIndex ? <a data-testid="download-specs-json" href={jsonDownload(specsIndex)} download="specs.json" aria-label="Baixar specs.json" onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a> : <span className={fileStatus}>Aguardando avaliação</span>}</summary>
          {specsIndex ? <pre>{JSON.stringify(specsIndex, null, 2)}</pre> : <p className={fileEmpty}>Será gerado após a avaliação.</p>}
        </details>
      )}
      <details>
        <summary><span>project.json</span>{projectJson ? <a data-testid="download-project-json" href={jsonDownload(projectJson)} download="project.json" aria-label="Baixar project.json" onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a> : <span className={fileStatus}>Aguardando avaliação</span>}</summary>
        {projectJson ? <pre>{JSON.stringify(projectJson, null, 2)}</pre> : <p className={fileEmpty}>Será gerado após a avaliação.</p>}
      </details>
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
      <div className="mt-5 flex items-center justify-between gap-3"><h4 className="m-0!"><Icon name="lock" size={20} />Segredos<InfoTip text="Chaves e senhas de serviços externos que o projeto usa, como a URL de um banco de dados. Ficam salvas neste computador e o valor nunca volta a ser exibido." /></h4><button type="button" className="secondary h-9 px-[0.7rem] text-[0.78rem]" onClick={() => setNewSecrets((rows) => [...rows, { id: Date.now(), name: '', value: '' }])}>Adicionar segredo<Icon name="plus" size={16} /></button></div>
      <ul className="m-0 grid list-none gap-3 p-0">
        {snap.secrets.map((s) => (
          <li key={s.name} className={`${secretRow} border-line bg-surface-sunken`}>
            {/* A hint made only of asterisks is a mask, not a hint: it tells the user nothing. */}
            <div className="flex min-w-0 items-center gap-[0.45rem]"><code className="mr-auto text-[0.78rem] font-bold text-ink wrap-anywhere">{s.name}</code>{s.hint && /[^*]/.test(s.hint) && <small className="text-[0.7rem] text-ink-soft">termina em {s.hint}</small>}<span className={`status-dot ${s.present ? 'ok' : 'warn'}`}>{s.present ? 'Salvo' : 'Não salvo'}</span></div>
            <div className={`${secretEntry} grid-cols-[minmax(0,1fr)_7rem]`}><input type="password" className={secretInput} data-testid={`secret-${s.name}`} aria-label={`Novo valor de ${s.name}`} placeholder={s.present ? 'Digite um novo valor para substituir' : 'Cole o valor da chave'} value={secretValues[s.name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [s.name]: e.target.value })} /><button className={secretSave} data-testid={`save-secret-${s.name}`} disabled={locked || !(secretValues[s.name] ?? '')} onClick={() => { p.onSecret(s.name, secretValues[s.name]!); setSecretValues({ ...secretValues, [s.name]: '' }); }}>Salvar<Icon name="check" size={14} /></button></div>
          </li>
        ))}
        {newSecrets.map((s) => <li key={s.id} className={`${secretRow} border-accent-line bg-accent-soft`}><div className={`${secretEntry} grid-cols-[minmax(8rem,0.7fr)_minmax(0,1fr)_auto] max-[720px]:grid-cols-1`}><input className={secretInput} aria-label="Nome da chave" placeholder="NOME_DA_CHAVE" value={s.name} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === s.id ? { ...row, name: e.target.value.toUpperCase() } : row))} /><input type="password" className={secretInput} aria-label="Valor da chave" placeholder="Cole o valor da chave" value={s.value} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === s.id ? { ...row, value: e.target.value } : row))} /><button className={secretSave} disabled={locked || !/^[A-Z][A-Z0-9_]*$/.test(s.name) || !s.value} onClick={() => { p.onSecret(s.name, s.value); setNewSecrets((rows) => rows.filter((row) => row.id !== s.id)); }}>Salvar<Icon name="check" size={16} /></button></div></li>)}
      </ul>
    </section>
  );
  return (
    <Workspace
      columns="lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)_minmax(0,1fr)]"
      // Below xl, review and quality share the right column at full height with one scroll; from xl each gets its own column.
      groupClass="grid min-h-0 min-w-0 content-start gap-6 lg:-m-1 lg:overflow-y-auto lg:p-1 max-xl:[&>section]:min-h-auto max-xl:[&>section]:overflow-visible xl:contents"
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
  const navigate = useNavigate();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const applied = useRef(0);
  const { events } = useJournal(snap ? refineApi.events(projectId, specId) : null);
  const load = () =>
    refineApi
      .snapshot(projectId, specId)
      .then((s) => setSnap({ ...s, docsDirty: false }))
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
    let next: LiveSnapshot = snap;
    for (const e of events) {
      if (e.seq <= applied.current) continue;
      applied.current = e.seq;
      next = applyToSnapshot(next, e);
      // A started backlog stays here: its program panel follows every spec, each with its own run link.
      if (e.type === 'REFINE_STARTED_RUN' && !next.state.backlog?.enabled) navigate(`/runs/${String(e.data.runId)}`);
    }
    if (next !== snap) {
      if (next.docsDirty) void load();
      else setSnap(next);
    }
  }, [events]);
  if (!snap) return (
    <main>
      {error ? <p className="error">{error}</p> : <Loading />}
    </main>
  );
  const act = (f: () => Promise<unknown>) => () => {
    setError(null);
    f().catch((e: Error) => setError(e.message));
  };
  const startRun = act(() => {
    setStarting(true);
    return refineApi.start(projectId, specId).then(({ runId, program: started }) => navigate(started ? programPath : `/runs/${runId}`)).finally(() => setStarting(false));
  });
  const executing = starting || (following && program?.status !== 'finished');
  return (
    <main className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <header className="refine-breadcrumb"><a href="/projects" aria-label="Voltar para projetos"><Icon name="home" size={18} /><span>Projetos</span></a><span>›</span><strong>{projectId}</strong><span>›</span><span>{specId} {snap?.state.mode === 'new-spec' ? 'spec nova' : 'rascunho'}</span>
        <span className={startGroup}>
          <button data-testid="start" className="primary flex-auto whitespace-nowrap max-[720px]:w-full" disabled={starting || !canStartRun(snap.state, snap.state.status === 'evaluating')} onClick={startRun}>
            {executing ? <span className="loading-spinner" aria-hidden="true" /> : <Icon name="play" size={16} />}
            {starting ? 'Iniciando…' : executing ? 'Em execução' : 'Iniciar análise'}
          </button>
          <InfoTip text={startInfo} />
        </span>
      </header>
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
        onEvaluate={act(() => refineApi.evaluate(projectId, specId))}
        onEnableBacklog={act(() => refineApi.enableBacklog(projectId, specId))}
        onEnableDetail={act(() => refineApi.enableDetail(projectId, specId))}
        onAnswer={(id, t, d) => act(() => refineApi.answer(projectId, specId, id, t, d))()}
        onSkip={(id) => act(() => refineApi.skip(projectId, specId, id))()}
        onAccept={(id) => act(() => refineApi.accept(projectId, specId, id))()}
        onReject={(id, r) => act(() => refineApi.reject(projectId, specId, id, r))()}
        onSecret={(n, v) => act(() => refineApi.secret(projectId, specId, n, v).then(load))()}
        onStart={startRun}
        startInHeader
        events={events}
      />
    </main>
  );
}
