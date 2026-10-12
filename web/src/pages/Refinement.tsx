import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, refineApi, type AcceptanceCriterion, type ChecklistItem, type ProgramView, type Snapshot, type StoredEvent } from '../api.js';
import { applyToSnapshot, type LiveSnapshot } from '../refine/reducer.js';
import { useJournal } from '../useSse.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { buildSpecsIndex } from '@server/refine/specs-index';
import { BacklogPanel } from '../refine/BacklogPanel.js';
import { canStartRun, ProgramPanel } from '../refine/ProgramPanel.js';
import { SpecTree } from '../refine/SpecTree.js';
import './refine.css';

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
    <span className="jev-actions">
      <button type="button" data-testid="jev-validate" disabled={check.checking} onClick={validate}>{check.checking ? 'Validando…' : 'Validar conexão'}</button>
      <Link to="/onboarding?item=openrouter">Informar nova chave</Link>
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
  /** The ledger of the program that runs a started backlog. */
  program?: ProgramView | null;
  events?: StoredEvent[];
}

function Checklist({ items, role }: { items: ChecklistItem[]; role: 'po' | 'sm' }) {
  const own = items.filter((i) => i.role === role);
  if (own.length === 0) return <p className="file-empty">Preenchida na primeira avaliação.</p>;
  return (
    <ul className="checklist">
      {own.map((i) => (
        <li key={i.id} className={i.passed ? 'pass' : 'fail'}>
          <span className="check-mark" role="img" aria-label={i.passed ? 'Atendido' : 'Não atendido'}><Icon name={i.passed ? 'check' : 'close'} size={16} /></span>
          <span>{checkLabel[i.id] ?? i.id.slice(3)}<small>{checkDetail(i.detail)}</small></span>
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
    ? 'Os agentes estão executando o backlog, uma spec por vez. Acompanhe cada uma abaixo; clique no link da run para ver os detalhes.'
    : st.status === 'evaluating'
    ? 'Aguarde o fim da avaliação; o andamento aparece logo abaixo.'
    : jevAdvisory
    ? 'O Jev apontou pontos nos documentos. Ajuste o que fizer sentido e clique em Reavaliar.'
    : pending.length > 0
    ? 'Responda às perguntas em aberto para continuar.'
    : st.stale
      ? 'Clique em Reavaliar para atualizar a lista de verificação com as últimas mudanças.'
      : st.patches.some((x) => x.status === 'pending')
        ? 'Revise as sugestões de alteração abaixo e aceite ou rejeite cada uma.'
        : st.backlog?.enabled && st.status === 'ready'
          ? st.backlog.detail
            ? 'O backlog detalhado está pronto: cada item tem spec e pré-plano. Para mudar algo, escreva nos documentos e reavalie; clique em Iniciar para os agentes executarem o backlog inteiro, uma spec por vez.'
            : 'O backlog está pronto para revisão. Para mudar prioridades ou cortes, escreva no briefing.md e reavalie; quando o esboço estiver certo, clique em Detalhar specs para gerar a spec e o pré-plano de cada item.'
        : st.backlog?.detail
          ? 'Detalhamento pedido: clique em Reavaliar para gerar a spec e o pré-plano de cada item; o que faltar aparece em vermelho na cobertura.'
        : canStart
          ? 'Tudo pronto. Clique em Iniciar análise para os agentes desenvolverem o projeto.'
          : st.cycle === 0
            ? 'Revise os documentos e clique em Avaliar. Os agentes vão revisar a demanda e preencher a lista de verificação.'
            : 'Corrija nos documentos os itens não atendidos da lista de verificação e clique em Reavaliar.';
  const existing = st.mode === 'new-spec' || st.mode === 'continue';
  const suggest = (file: Exclude<DocFile, 'flow.md'>) => {
    setSuggesting(true);
    void p.onSuggestDoc!(file)
      .then((text) => { if (text !== null) setDocs((d) => ({ ...d, [file]: text })); })
      .finally(() => setSuggesting(false));
  };
  const tabButton = (f: DocFile) => (
    <button key={f} className={tab === f ? 'active' : ''} onClick={() => setTab(f)}>
      {docLabel[f]}
    </button>
  );
  return (
    <div className="refine refine-workspace">
      <section className="docs panel-card">
        <div className="section-heading">
          <div>
            <span className="refine-heading-icon refine-heading-icon-docs"><Icon name="file" size={26} /></span>
            <div><span className="eyebrow">Área de trabalho</span>
            <h2>{existing ? (st.mode === 'continue' ? 'Continuação da spec' : 'Spec nova') : 'Documentos do projeto'}</h2>
            </div>
          </div>
        </div>
        {existing ? (
          <div className="tabs tab-groups" role="tablist" aria-label="Documentos">
            <div className="tab-group" data-testid="docs-group-spec">
              <span className="tab-group-label">Spec</span>
              {tabButton('brief.md')}
            </div>
            <div className="tab-group" data-testid="docs-group-project">
              <span className="tab-group-label">Contexto do projeto · muda só com sua aprovação</span>
              {(['flow.md', 'project.md', 'stack.md', 'design.md'] as DocFile[]).map(tabButton)}
            </div>
          </div>
        ) : (
          <div className="tabs" role="tablist" aria-label="Documentos do projeto">
            {(['flow.md', 'project.md', 'brief.md', 'stack.md', 'design.md'] as DocFile[]).map(tabButton)}
          </div>
        )}
        <p data-testid="doc-impact" className="hint">{backlogOn && tab === 'brief.md' ? briefingImpact : docImpact[tab]}</p>
        <div className="document-editor">
          <button type="button" className="editor-copy" aria-label="Copiar documento" onClick={() => copyDoc(docs[tab] ?? '')}><Icon name="copy" size={19} /></button>
          {tab !== 'flow.md' && p.onSuggestDoc && (
            <button type="button" data-testid="suggest" className="editor-suggest" disabled={locked || suggesting} title="Gera este documento a partir do flow.md" onClick={() => suggest(tab)}>
              {suggesting ? 'Sugerindo…' : 'Sugerir'}
            </button>
          )}
          <textarea
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
          <p data-testid="stale" className="notice">
            A lista de verificação está desatualizada: houve mudanças depois da última avaliação.
          </p>
        )}
        {jevAdvisory && <p className="notice">O Jev é obrigatório no refinamento: ele valida os documentos e decide pontos da avaliação, e seus apontamentos são considerados por Claude, PO e SM. <InfoTip text={jevInfo} /></p>}
        <div className="doc-actions">
          <span className="save-hint"><Icon name="info" size={18} />As alterações são salvas automaticamente ao sair do editor.</span>
          <button data-testid="evaluate" className="primary refine-action" disabled={locked} onClick={p.onEvaluate}>
          <Icon name="check" size={18} />{st.cycle === 0 ? 'Avaliar' : 'Reavaliar'}
          </button>
          {st.status === 'evaluating' && <span className="spinner">Avaliando…</span>}
        </div>
      </section>
      <section className="conversation panel-card">
        <div className="section-heading">
          <div>
            <span className="refine-heading-icon refine-heading-icon-review"><Icon name="clipboard" size={26} /></span>
            <div><span className="eyebrow">Refinamento</span>
            <h2>Área de revisão</h2>
            </div>
          </div>
          <span className={`count-pill ${pending.length > 0 ? 'tone-warn' : 'tone-good'}`}>{pending.length === 1 ? '1 pergunta em aberto' : `${pending.length} perguntas em aberto`}</span>
        </div>
        <p className="next-step"><Icon name="lightbulb" size={20} /><span><b>Próximo passo:</b> {nextStep}</span></p>
        {busy && (
          <div className={`claude-session${jevDown ? ' claude-session-bad' : ''}`} role="status" aria-live="polite">
            <span className="live-dot" aria-hidden="true" />
            <div>
              <b>Avaliação em andamento <InfoTip text={evaluationInfo} /></b>
              <span>Rodada {st.cycle} · {claudeStage}</span>
            </div>
            <span className="session-spinner" aria-hidden="true">•••</span>
          </div>
        )}
        {evaluating ? (
          <p className="muted">Avaliando… As perguntas e as sugestões aparecem aqui quando a avaliação terminar.</p>
        ) : current ? (
          <div className="question card-inner">
            <div className="question-meta">
              <span className={`badge ${current.role}`}>{current.role.toUpperCase()}</span>
              <InfoTip text={roleInfo[current.role]} />
              {current.blocking && <span className="tag">Obrigatória</span>}
            </div>
            <p>{questionText(current.text)}</p>
            {current.relatedAcIds.length > 0 && (
              <small className="question-criteria">
                Critérios de aceite:{' '}
                {current.relatedAcIds.map((id, i) => {
                  const criterion = criteria.find((c) => c.id === id);
                  return <Fragment key={id}>{i > 0 ? ', ' : ''}{id}{criterion ? <InfoTip text={criterionText(criterion)} /> : null}</Fragment>;
                })}
              </small>
            )}
            <label className="field-label" htmlFor="refinement-answer">Sua resposta</label>
            <textarea id="refinement-answer" data-testid="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <div className="field-label">
              <label>
                <input type="checkbox" data-testid="docs-answered" checked={docsAnswered} onChange={(e) => setDocsAnswered(e.target.checked)} /> Os documentos já respondiam esta pergunta
              </label>{' '}
              <InfoTip text="Marque quando a resposta já estava nos documentos: essas marcas medem quando o Jev pode responder sozinho." />
            </div>
            <div className="question-actions">
              <div className="question-actions-buttons">
                <button
                  data-testid={`answer-${current.questionId}`}
                  disabled={locked || answer.trim() === ''}
                  onClick={() => {
                    p.onAnswer(current.questionId, answer, docsAnswered);
                    setAnswer('');
                    setDocsAnswered(false);
                  }}
                >
                  Responder
                </button>
                {!current.blocking && (
                  <button data-testid={`skip-${current.questionId}`} disabled={locked} onClick={() => p.onSkip(current.questionId)}>
                    Ignorar
                  </button>
                )}
              </div>
              <small>{pending.length === 1 ? 'Esta é a última pergunta em aberto.' : pending.length === 2 ? 'Mais 1 pergunta depois desta.' : `Mais ${pending.length - 1} perguntas depois desta.`}</small>
            </div>
          </div>
        ) : (
          <p className="muted">Nenhuma pergunta em aberto.</p>
        )}
        {(evaluating ? [] : st.patches)
          .filter((x) => x.status === 'pending')
          .map((x, i) => (
            <div key={x.patchId} className="patch">
              <div className="patch-heading">
                <span className={`badge ${x.role}`}>{x.role === 'front' ? 'FRONT' : x.role.toUpperCase()}</span>
                <b>Sugestão para {docName(x.file)}</b>
                {i === 0 ? <InfoTip text={patchInfo} /> : null}
                <span className="patch-reason">{x.reason}</span>
              </div>
              <pre className="diff">{x.diff}</pre>
              <div className="patch-actions">
              <button type="button" className="patch-accept" data-testid={`accept-${x.patchId}`} disabled={locked} onClick={() => p.onAccept(x.patchId)}>
                Aceitar
              </button>
              <input
                data-testid={`reject-reason-${x.patchId}`}
                aria-label="Motivo da rejeição (opcional)"
                placeholder="Motivo (opcional)"
                value={reasons[x.patchId] ?? ''}
                onChange={(e) => setReasons({ ...reasons, [x.patchId]: e.target.value })}
              />
              <button type="button" className="patch-reject" data-testid={`reject-${x.patchId}`} disabled={locked} onClick={() => p.onReject(x.patchId, reasons[x.patchId] || null)}>
                Rejeitar
              </button>
              </div>
            </div>
          ))}
        {st.discarded.map((d, i) => (
          <p key={i} className="warning">
            Uma sugestão do {d.role.toUpperCase()} para {docName(d.file)} não pôde ser aplicada e foi descartada ({d.reason}).
          </p>
        ))}
        <h4><Icon name="clock" size={20} />Histórico</h4>
        <ul className="history">
          {[...st.questions]
            .filter((q) => q.status !== 'pending')
            .reverse()
            .map((q) => (
              <li key={q.questionId}>
                <span className={`badge ${q.role}`}>{q.role.toUpperCase()}</span> {questionText(q.text)} → {q.status === 'skipped' ? <i>ignorada</i> : q.answer}{q.answeredBy ? <i> (suposição do {q.answeredBy.toUpperCase()}, tirada dos documentos)</i> : null}
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
        {!p.startInHeader && <div className="refine-start-group">
          <button data-testid="start" className="primary full-width refine-start" disabled={!canStart} onClick={p.onStart}>
            <Icon name="play" size={18} />Iniciar análise
          </button>
          <InfoTip text={startInfo} />
        </div>}
      </section>
      <section className="panels panel-card">
        <div className="section-heading">
          <div>
            <span className="refine-heading-icon refine-heading-icon-quality"><Icon name="shield" size={26} /></span>
            <div><span className="eyebrow">Controle de qualidade</span>
            <h2>Lista de verificação</h2>
            </div>
          </div>
          <span className={`status-dot ${listState.tone}`}>{listState.label}</span>
        </div>
        <div className="cost-summary">
          <p className="cost-title">Consumo de IA no refinamento</p>
          <dl>
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
        <div className="quality-checks"><h5>Produto (PO)</h5><Checklist items={st.checklist} role="po" /><h5>Técnico (SM)</h5><Checklist items={st.checklist} role="sm" /></div>
        <BacklogPanel backlog={st.backlog} evaluating={evaluating} locked={locked} ready={st.status === 'ready' && !st.stale} onEnable={p.onEnableBacklog} onDetail={p.onEnableDetail} />
        {p.program && st.backlog && <ProgramPanel program={p.program} titles={Object.fromEntries(st.backlog.items.map((i) => [i.key, i.title]))} />}
        {st.backlog?.detail && <SpecTree backlog={st.backlog} evaluating={evaluating} />}
        <h4><Icon name="file" size={20} />Arquivos gerados<InfoTip text="Versão estruturada dos documentos, gerada pelo Claude a cada avaliação. O project.json descreve o projeto; o spec.json, esta demanda, com tarefas e critérios de aceite." /></h4>
        {!backlogOn && (
          <>
        {st.derived?.spec && <p data-testid="spec-type">Tipo da demanda: <strong>{typeLabel[st.derived.spec.type] ?? st.derived.spec.type}</strong></p>}
        {st.derived?.spec.type === 'bug' && st.derived.spec.bug && (
          <div data-testid="bug-details" className="notice bug-details">
            <strong>Detalhes do bug</strong>
            <span>Comportamento atual: {st.derived.spec.bug.actual}</span>
            <span>Comportamento esperado: {st.derived.spec.bug.expected}</span>
            <span>Como reproduzir: {st.derived.spec.bug.reproduction}</span>
          </div>
        )}
        <details>
          <summary><span>spec.json</span>{st.derived ? <a data-testid="download-spec-json" href={jsonDownload(st.derived.spec)} download="spec.json" aria-label="Baixar spec.json" onClick={(e) => e.stopPropagation()}><Icon name="download" size={18} /></a> : <span className="file-status">Aguardando avaliação</span>}</summary>
          {st.derived ? <pre>{JSON.stringify(st.derived.spec, null, 2)}</pre> : <p className="file-empty">Será gerado após a avaliação.</p>}
        </details>
          </>
        )}
        {backlogOn && (
          <details>
            <summary><span>specs.json</span>{specsIndex ? <a data-testid="download-specs-json" href={jsonDownload(specsIndex)} download="specs.json" aria-label="Baixar specs.json" onClick={(e) => e.stopPropagation()}><Icon name="download" size={18} /></a> : <span className="file-status">Aguardando avaliação</span>}</summary>
            {specsIndex ? <pre>{JSON.stringify(specsIndex, null, 2)}</pre> : <p className="file-empty">Será gerado após a avaliação.</p>}
          </details>
        )}
        <details>
          <summary><span>project.json</span>{projectJson ? <a data-testid="download-project-json" href={jsonDownload(projectJson)} download="project.json" aria-label="Baixar project.json" onClick={(e) => e.stopPropagation()}><Icon name="download" size={18} /></a> : <span className="file-status">Aguardando avaliação</span>}</summary>
          {projectJson ? <pre>{JSON.stringify(projectJson, null, 2)}</pre> : <p className="file-empty">Será gerado após a avaliação.</p>}
        </details>
        {!backlogOn && (
          <>
        <h4><Icon name="list" size={20} />Tarefas<InfoTip text="Tarefas descritas no briefing, extraídas a cada avaliação. Na execução, o SM as usa para montar o plano de trabalho." /></h4>
        <ul className="quality-tasks">
          {(st.derived?.spec.tasks ?? []).map((t, i) => (
            <li key={i}>
              <b>{t.title}</b>: {t.description}
            </li>
          ))}
        </ul>
        {(st.derived?.spec.tasks ?? []).length === 0 && <div className="quality-empty"><Icon name="clipboard" size={26} /><strong>Nenhuma tarefa gerada ainda.</strong><span>As tarefas aparecerão aqui após a avaliação.</span></div>}
          </>
        )}
        <div className="secrets-heading"><h4><Icon name="lock" size={20} />Segredos<InfoTip text="Chaves e senhas de serviços externos que o projeto usa, como a URL de um banco de dados. Ficam salvas neste computador e o valor nunca volta a ser exibido." /></h4><button type="button" className="secondary add-secret" onClick={() => setNewSecrets((rows) => [...rows, { id: Date.now(), name: '', value: '' }])}><Icon name="plus" size={16} />Adicionar segredo</button></div>
        <ul className="quality-secrets">
          {snap.secrets.map((s) => (
            <li key={s.name} className="secret-row">
              {/* A hint made only of asterisks is a mask, not a hint: it tells the user nothing. */}
              <div className="secret-label"><code>{s.name}</code>{s.hint && /[^*]/.test(s.hint) && <small>termina em {s.hint}</small>}<span className={`status-dot ${s.present ? 'ok' : 'warn'}`}>{s.present ? 'Salvo' : 'Não salvo'}</span></div>
              <div className="secret-entry"><input type="password" data-testid={`secret-${s.name}`} aria-label={`Novo valor de ${s.name}`} placeholder={s.present ? 'Digite um novo valor para substituir' : 'Cole o valor da chave'} value={secretValues[s.name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [s.name]: e.target.value })} /><button data-testid={`save-secret-${s.name}`} disabled={locked || !(secretValues[s.name] ?? '')} onClick={() => { p.onSecret(s.name, secretValues[s.name]!); setSecretValues({ ...secretValues, [s.name]: '' }); }}>Salvar</button></div>
            </li>
          ))}
          {newSecrets.map((s) => <li key={s.id} className="secret-row new-secret-row"><div className="secret-entry secret-key-entry"><input aria-label="Nome da chave" placeholder="NOME_DA_CHAVE" value={s.name} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === s.id ? { ...row, name: e.target.value.toUpperCase() } : row))} /><input type="password" aria-label="Valor da chave" placeholder="Cole o valor da chave" value={s.value} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === s.id ? { ...row, value: e.target.value } : row))} /><button disabled={locked || !/^[A-Z][A-Z0-9_]*$/.test(s.name) || !s.value} onClick={() => { p.onSecret(s.name, s.value); setNewSecrets((rows) => rows.filter((row) => row.id !== s.id)); }}>Salvar</button></div></li>)}
        </ul>
      </section>
    </div>
  );
}

export function RefinementPage() {
  const { projectId = '', specId = '' } = useParams();
  const navigate = useNavigate();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [program, setProgram] = useState<ProgramView | null>(null);
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
  useEffect(() => {
    if (!following) return;
    const poll = () => refineApi.program(projectId, specId).then((r) => setProgram(r.program)).catch(() => undefined);
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => clearInterval(timer);
  }, [following, projectId, specId]);
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
  const startRun = act(() => refineApi.start(projectId, specId).then(({ runId, program: started }) => (started ? (setProgram(started), load()) : navigate(`/runs/${runId}`))));
  return (
    <main className="refine-page">
      <header className="refine-breadcrumb"><a href="/projects" aria-label="Voltar para projetos"><Icon name="home" size={18} /><span>Projetos</span></a><span>›</span><strong>{projectId}</strong><span>›</span><span>{specId} {snap?.state.mode === 'new-spec' ? 'spec nova' : 'rascunho'}</span>
        <span className="refine-start-group">
          <button data-testid="start" className="primary refine-start refine-top-action" disabled={!canStartRun(snap.state, snap.state.status === 'evaluating')} onClick={startRun}>
            <Icon name="play" size={18} />Iniciar análise
          </button>
          <InfoTip text={startInfo} />
        </span>
      </header>
      {(error || snap.state.status === 'error') && (
        <div className="error refine-page-error" role="alert">
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
        program={program}
        events={events}
      />
    </main>
  );
}
