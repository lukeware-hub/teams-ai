import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { criterionSentence } from '../criterion.js';
import { api, refineApi, settingsApi, type AcceptanceCriterion, type ChecklistItem, type DroppedQuestionRow, type PatchRow, type QuestionRow, type Snapshot, type StoredEvent } from '../api.js';
import { mdDownload } from '../download.js';
import { StepCard, TILE } from '../refine/StepCard.js';
import { StartMissingAlert } from '../refine/StartMissingAlert.js';
import { BacklogProgress } from '../refine/BacklogProgress.js';
import { backlogProgress } from '../refine/backlog-progress.js';
import { applyBatch, type LiveSnapshot } from '../refine/reducer.js';
import { useJournal } from '../useSse.js';
import { visibleInterval } from '../visibleInterval.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icons.js';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { afterStartPath, executionPath, projectPath } from '../routes.js';
import { InfoTip, Tipped } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { OptionGroup } from '../components/OptionGroup.js';
import { money } from './costs/format.js';
import { renderSpecMd } from '@server/refine/spec-md';
import { planItems } from '@server/refine/plan-items';
import { renderSpecsMd } from '@server/refine/specs-md';
import { allGreen, isApproval, requestHeading } from '@server/refine/state';
import { CHECK_NAMES, type Divergence, type DivergenceSide } from '@server/refine/checklist';
import { BacklogPanel } from '../refine/BacklogPanel.js';
import { MoveNotice } from '../refine/MoveNotice.js';
import { ReshapeNotice } from '../refine/ReshapeNotice.js';
import { ClosingDialog } from '../refine/ClosingDialog.js';
import { ArchitectureCard } from '../refine/ArchitectureCard.js';
import { DocsSyncNotice } from '../refine/DocsSyncNotice.js';
import { jevVerdict, scoresDocs } from '@server/refine/readiness';
import { canStartRun, ProgramStatus, useProgram } from '../refine/ProgramPanel.js';
import { PlansStatus } from '../refine/PlansStatus.js';
import { Elapsed, lastEvaluationText, ProcessBox, ProcessingBanner, stageInfo } from '../refine/ProcessingBanner.js';
import { ReviewDecision } from '../refine/ReviewDecision.js';
import { runningSteps, type RunningStep } from '../refine/running-steps.js';
import { StageSteps } from '../refine/StageSteps.js';
import { allStagesCurrent, currentStage, previousStage, stageOutdated, stageViews } from '../refine/stage-view.js';
import { ReadinessBanner } from '../refine/ReadinessBanner.js';
import { DOC_LABEL as docLabel } from '../refine/doc-labels.js';
import { stageAction, stageTitle } from '../refine/stages.js';
import { stageText } from '../refine/stage-text.js';
import { firstFailing, graphLabel, stageChecklist, type StageCheck } from '../refine/stage-checklist.js';
import { SpecTree } from '../refine/SpecTree.js';
import { ImpactCard, ReadyBar, ReplanCard, RequestCard, type RequestStatus } from '../refine/RequestCards.js';
import { acceptedAdditions, readyChecks, replanRows, requestNodes, requestTrail, understoodCounts } from '../refine/request.js';
import { Workspace } from '../components/Workspace.js';
import { Stepper } from '../components/Stepper.js';
import { WizardShell } from '../components/WizardShell.js';
import { DocScoreInset, ScoreChecks } from '../refine/DocScoreView.js';
import { architectureQuestions, docPatches, docQuestions, initialStep, isDocStep, nextStep as nextWizardStep, parseStep, pendingCount, prevStep, specsQuestions, speckitQuestions, stepOpen, stepsOf, stepParam, unfiledQuestions, wizardNodes, type WizardStep } from '../refine/wizard.js';
import { DOC_STAGES } from '@server/refine/doc-stages';
import { PASS_LINE, percentOf } from '@server/refine/readiness';

type DocFile = 'project.md' | 'briefing.md' | 'stack.md' | 'flow.md' | 'design.md';
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
  ?.replace(/^.*(OAuth session expired|Failed to authenticate).*$/s, 'A sessão do Claude expirou. Entre de novo no Claude em Configurações e processe de novo.')
  ?.replace(/^Jev bloqueou a derivação:/,'O Jev encontrou pontos para revisão:')
  ?.replace(/\binterrupted\b/gi, 'A avaliação foi interrompida. Clique em Reavaliar para tentar novamente.')
  .replaceAll('failed', 'falhou')
  .replaceAll('timeout', 'tempo limite excedido')
  .replaceAll('internal error', 'erro interno')
  .replace(/\b(documents_consistent|flow_covers_scope|validation_aligned|persistence_aligned|responses_aligned|health_aligned)\b/g, (id) => jevCheckLabel[id] ?? id) ?? null;
// The server refuses a second evaluation while one runs: the owner waits for it, so the page shows progress, not an error.
/** The pause after the last keystroke before a stage document is saved on its own. */
const AUTOSAVE_MS = 1500;
/** The pause before a save the server refused while it organizes a document is sent again. */
const BUSY_SAVE_RETRY_MS = 500;

/** The card each step of a request opens on the page: the owner's words, the impact, the replan, and the ready bar. */
const REQUEST_STEP_TARGET: Record<string, string> = { pedido: 'step-card-request', impacto: 'step-card-impact', specs: 'step-card-replan', pronto: 'request-ready' };
/** Whether an evaluation is open in the journal: it spans a stage's review, its score and its graph extraction, so the page shows the work from the first event to the last. */
const evaluationOpen = (st: Pick<Snapshot['state'], 'evaluation'>): boolean => st.evaluation != null && st.evaluation.endedAt === null;
/** The notice a click gets while a process is open: it says to wait, and the page frees itself when the process ends. */
function BusyDialog({ onClose }: { onClose: () => void }) {
  return (
    <ConfirmDialog title="Aguarde o processo terminar" confirmLabel="Entendi" tone="accent" icon="check" confirmTestId="busy-dialog-ok" onConfirm={onClose} onCancel={onClose}>
      Tem um processo em aberto. Aguarde ele finalizar: os botões liberam sozinhos, sem precisar recarregar a página.
    </ConfirmDialog>
  );
}

// Every refusal for a process still running starts with "Já tem": the busy dialog explains them all.
const isBusyError = (e: Error) => e.message.startsWith('Já tem ');
// The server refuses a save for a moment while it organizes a document after a suggestion: only that save is sent again.
const isOrganizingError = (e: Error) => e.message.startsWith('Já tem o documento sendo organizado');
const typeLabel: Record<string, string> = { feature: 'Feature', bug: 'Bug', maintenance: 'Manutenção', refactor: 'Refatoração' };

/** The alignment line: the last stage review's divergences of the document, or else the full round's contradictions check. */
const alignedLine = (divergences: string[] | undefined, check: { passed: boolean; detail: string } | undefined): string | null => {
  if (divergences) return divergences.length === 0 ? 'Alinhado com os outros documentos.' : `Não alinhado com os outros documentos: ${divergences.join('; ')}`;
  if (!check) return null;
  return check.passed ? 'Alinhado com os outros documentos.' : `Não alinhado com os outros documentos: ${check.detail}`;
};
const docImpact: Record<DocFile, string> = {
  'project.md': 'O que o projeto é: visão, objetivos, o que ele precisa entregar e quem responde por cada parte.',
  'briefing.md': 'Como o sistema funciona em detalhe, com o que entra, o que fica de fora e como saber que ficou pronto. Dele saem as specs.',
  'stack.md': 'Tecnologias, versões e regras de uso: o que não usar e as boas práticas. Orienta o plano técnico e a implementação.',
  'flow.md': 'O fluxo de negócio completo, como diagrama: estados, desvios, erros e quem age em cada passo. Base dos critérios de aceite e dos testes.',
  'design.md': 'Contrato visual: cores, tipografia, componentes e acessibilidade. Seguido pelo agente Front, que cuida da interface.',
};
/** Short text for the info icon on each document tab. */
const docTip: Record<DocFile, string> = {
  'project.md': 'Explica o que é o projeto, seus objetivos, o que ele precisa entregar e quem responde por cada parte.',
  'briefing.md': 'Explica como o sistema funciona em detalhe, passo a passo, com o que entra, o que fica de fora e como saber que ficou pronto. As decisões respondidas ficam em "## Decisões" e são mantidas ao salvar ou anexar.',
  'stack.md': 'Lista as tecnologias, as versões e as regras de uso: o que não usar e as boas práticas que os agentes precisam seguir.',
  'flow.md': 'Mostra o fluxo de negócio completo em um diagrama: estados, desvios, erros e quem age em cada passo.',
  'design.md': 'Define o visual do projeto: cores, letras, componentes e acessibilidade. O agente Front segue este documento na interface.',
};
/** Backlog mode: the briefing is the target project's docs/briefing.md, one file for the whole backlog. */
const briefingImpact = 'Briefing do projeto (docs/briefing.md): objetivos, prioridades, cortes e decisões que valem para todo o backlog. Os agentes seguem o que estiver escrito aqui.';
const docName = (file: string) => docLabel[file.split('/').pop() as DocFile] ?? file;
/** The design of a project without an interface: the document says so, and the Jev counts a part marked not applicable as present. */
const NOT_APPLICABLE_DESIGN = 'Não se aplica: este projeto não tem interface.';
/** Journal events that change a document or a decision: after one of them a new evaluation is not a repeat. */
const CHANGE_EVENTS = new Set(['DOC_EDITED', 'PATCH_ACCEPTED', 'PATCH_REJECTED', 'QUESTION_ANSWERED', 'QUESTION_SKIPPED', 'BACKLOG_DETAIL_ENABLED']);
const roleInfo: Record<'po' | 'sm', string> = {
  po: 'Pergunta do PO (Product Owner), o agente que revisa objetivos, critérios de aceite e o fluxo de negócio.',
  sm: 'Pergunta do SM (Scrum Master), o agente que revisa stack, tarefas, validação e viabilidade técnica.',
};
const checkLabel: Record<string, string> = Object.fromEntries(Object.entries(CHECK_NAMES).map(([id, name]) => [id, name.label]));
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
const criterionText = (c: AcceptanceCriterion) => `${c.id}: ${criterionSentence(c)}`;
const jevInfo = 'O Jev é obrigatório no refinamento. Ele confere se os cinco documentos estão consistentes entre si e classifica e decide pontos da avaliação: critérios de aceite ainda não prontos, perguntas repetidas e contradições com o histórico do projeto. Sem ele, a avaliação não inicia. Ajuste o que fizer sentido e reavalie.';
const patchInfo = 'Mudança proposta por um agente: linhas com - saem e linhas com + entram. Aceitar aplica a mudança no documento; Rejeitar a descarta, e o motivo opcional fica no histórico.';

// Skip re-rendering the 59-spec backlog on each tab click: its props stay the same.
const MemoBacklogPanel = memo(BacklogPanel);
const MemoSpecTree = memo(SpecTree);

// Builds the body only after the file is opened: a closed details still mounts its children.
const QUEUED_TEXT = { accept: 'Aceita — entra quando o time terminar', reject: 'Rejeitada — entra quando o time terminar', answer: 'Resposta na fila — entra quando o time terminar' } as const;

/** A decision the owner took while the team worked: it waits in line, and Desfazer takes it back. */
function QueuedNote({ id, kind, onUndo }: { id: string; kind: keyof typeof QUEUED_TEXT; onUndo?: (id: string) => unknown }) {
  return (
    <div data-testid={`queued-${id}`} role="status" className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warn-line bg-warn-soft px-2.5 py-1 text-[0.8125rem] font-semibold text-warn"><Icon name="clock" size={14} />{QUEUED_TEXT[kind]}</span>
      {onUndo && <ActionButton data-testid={`unqueue-${id}`} className="secondary h-9" onClick={() => onUndo(id)}>Desfazer</ActionButton>}
    </div>
  );
}

function LazyDetails({ className, summary, body }: { className: string; summary: ReactNode; body: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details data-testid="refinement-lazy-details" className={className} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary data-testid="refinement-lazy-details-summary">{summary}</summary>
      {open && body()}
    </details>
  );
}

const panelCard = 'edge-lit min-w-0 rounded-xl border border-line bg-surface p-5 shadow-card';
// The checklist panel styles the headings and lists inside it; disclosures bring their own box.
const qualityStyles = `[&_details_pre]:max-h-48 [&_details_pre]:overflow-auto [&_details_pre]:text-[0.7rem] [&_details_pre]:text-ink-soft [&_details_summary]:flex [&_details_summary]:cursor-pointer [&_details_summary]:items-center [&_details_summary]:justify-between [&_details_summary_svg]:text-accent-text [&_:is(h3,h4)]:mx-0 [&_:is(h3,h4)]:mt-5 [&_:is(h3,h4)]:mb-[0.7rem] [&_:is(h3,h4)]:flex [&_:is(h3,h4)]:items-center [&_:is(h3,h4)]:gap-[0.55rem] [&_:is(h3,h4)]:text-[0.8rem] [&_:is(h3,h4)]:tracking-[0.06em] [&_:is(h3,h4)]:text-ink [&_:is(h3,h4)]:uppercase [&_:is(h3,h4)>svg]:text-ink-soft [&_h5]:mx-0 [&_h5]:mt-4 [&_h5]:mb-[0.45rem] [&_h5]:text-[0.72rem] [&_h5]:tracking-[0.08em] [&_h5]:text-ink-soft [&_h5]:uppercase [&_ul]:pl-[1.1rem] [&_ul]:text-[0.8rem] [&_ul]:leading-[1.45]`;
const qualityCard = `${panelCard} ${qualityStyles}`;
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
// Discarded suggestions stay folded: they are history, not something the owner must act on.
const DiscardedNotices = ({ rows, testId, named }: { rows: { role: string; file: string; reason: string }[]; testId: string; named: boolean }) =>
  rows.length === 0 ? null : (
    <details data-testid={`${testId}-group`} className="group m-0">
      <summary data-testid={`${testId}-summary`} className={`flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden ${notice}`}>
        <span className="flex-1">{rows.length === 1 ? '1 sugestão descartada' : `${rows.length} sugestões descartadas`}</span>
        <span className="transition-transform group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
      </summary>
      <ul className="m-0 mt-2 grid list-none gap-2 p-0">
        {rows.map((d, i) => (
          <li data-testid={testId} key={i} className={notice}>
            Uma sugestão do {d.role.toUpperCase()}{named ? ` para ${docName(d.file)}` : ''} não pôde ser aplicada e foi descartada ({d.reason}).
          </li>
        ))}
      </ul>
    </details>
  );
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
const neutralBadge = 'badge px-2 py-[0.15rem] text-[0.6875rem] font-bold tracking-[0.04em] bg-surface-muted text-ink';
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
    <span data-testid="refinement-jev-actions" className="mt-2 flex flex-wrap items-center gap-x-[0.8rem] gap-y-[0.3rem]">
      <ActionButton className="rounded-md border-current bg-transparent px-[0.6rem] py-[0.2rem] text-[0.75rem] font-semibold text-current disabled:cursor-default disabled:opacity-60" data-testid="jev-validate" busy={check.checking} onClick={validate} icon={<Icon name="check" size={14} />}>{check.checking ? 'Validando…' : 'Validar conexão'}</ActionButton>
      <Link className="font-semibold text-current underline" to="/settings">Informar nova chave</Link>
      {check.ok !== undefined && <span data-testid="jev-validate-result">{check.ok ? 'Conexão com o OpenRouter funcionando. Clique em Reavaliar.' : `Falha na conexão: ${check.detail ?? 'chave inválida.'}`}</span>}
    </span>
  );
}

/** The stage the evaluation is in now, and whether Jev is down, from the journal of the current round. */
/** The line of a stage review: what runs now, from the server's steps and the round's events, and whether the Jev did not answer. */
function stageLineOf(signals: { reviewed: boolean; scored: boolean; jevDown: boolean }, graphing: boolean, file: string, running: RunningStep[], jevReads: boolean): { line: string; jevDown: boolean } {
  return { line: stageText({ file, running, reviewed: signals.reviewed, scored: signals.scored, graphing, jevReads, jevDown: signals.jevDown, firstStage: file === 'flow.md' }), jevDown: signals.jevDown };
}

export function stageNow(events: StoredEvent[], cycle: number): { stage: string; jevDown: boolean; running: RunningStep[] } {
  const derived = events.some((e) => e.type === 'DERIVED' && Number(e.data.cycle) === cycle);
  const jevEvent = events.find((e) => e.type === 'REFINE_DOCS_VALIDATED' && Number(e.data.cycle) === cycle);
  return { stage: currentClaudeStage(events, cycle, jevEvent, derived), jevDown: jevEvent?.data.available === false, running: runningSteps(events, cycle) };
}

function currentClaudeStage(events: StoredEvent[], cycle: number, jevEvent: StoredEvent | undefined, derived: boolean): string {
  if (!jevEvent) return 'Jev está validando os cinco documentos do projeto.';
  // The status says whether the Jev answered, never a verdict on the documents.
  const stage = jevEvent.data.stage !== undefined;
  if (jevEvent.data.available === false) return stage ? 'Jev indisponível: confira a chave do OpenRouter. A etapa segue sem a nota dele.' : 'O Jev não respondeu. A avaliação segue sem as notas dele.';

  const active = runningSteps(events, cycle);
  if (active.some((step) => step.kind === 'backlog')) return 'PO está quebrando os documentos em backlog, com épicos e prioridades.';
  if (active.some((step) => step.kind === 'spec')) return 'PO está detalhando a spec de cada item do backlog.';
  if (active.some((step) => step.kind === 'preplan')) return 'SM está fazendo o pré-plano de cada spec.';
  if (active.some((step) => step.kind === 'derive')) return 'Claude está derivando as specs a partir dos cinco documentos.';
  if (active.some((step) => step.kind === 'answer')) return 'PO e SM estão respondendo, a partir dos documentos, as perguntas que eles já resolvem.';
  const roles = active.filter((step) => step.kind === 'refine').map((step) => step.role);
  if (roles.includes('front')) return 'Front está revisando o contrato visual, responsividade e acessibilidade.';
  if (roles.includes('po') && roles.includes('sm')) return 'PO e SM estão revisando objetivos, critérios e fluxos em paralelo.';
  if (roles.includes('po')) return 'PO está revisando objetivos, critérios e o fluxo de negócio.';
  if (roles.includes('sm')) return 'SM está revisando stack, tarefas, validação e viabilidade.';
  if (stage) return 'Jev respondeu; Claude está analisando o documento da etapa.';
  if (!derived) return 'Jev validou os documentos; Claude está iniciando a derivação dos arquivos.';
  return 'Derivação concluída; Claude está preparando a revisão do PO e do SM.';
}
export interface ViewProps {
  snap: Snapshot;
  busy: boolean;
  /** Saves a document over the hash its text was typed over; resolves to the hash it has now, or null when the server refused. */
  onSaveDoc(file: DocFile, text: string, baseHash?: string, keepalive?: boolean): Promise<string | null> | void;
  /** Reads a document as the server holds it now, with its hash; resolves to null when the read fails. */
  onReadDoc?(file: DocFile): Promise<{ text: string; hash?: string } | null>;
  /** The message of the last save the server refused: shown beside the editor until a save goes through. */
  saveError?: string | null;
  /** "Sugerir": the agent's version of a document written from flow.md, or null when it failed. */
  onSuggestDoc?(file: Exclude<DocFile, 'flow.md'>): Promise<string | null>;
  /** "Anexar imagem": the agent's design.md adjusted from template images (base64), or null when it failed. */
  onDesignFromImages?(images: { data: string }[]): Promise<string | null>;
  onEvaluate(): void | Promise<unknown>;
  /** The owner's button for everything: the team answers, decides, repairs and prepares until the start is clear. */
  onResolveAll?(): void | Promise<unknown>;
  /** Whether the project lets the agents decide; unknown until the setting loads. */
  agentsDecide?: boolean;
  /** The owner accepts every suggestion at once; the agents run again on what was decided. */
  onAcceptAll?(): void | Promise<unknown>;
  /** The owner takes every suggestion the review of a stage left, with no new review. */
  onApplyStage?(file: DocFile): void | Promise<unknown>;
  /** The owner goes on without what the review of a stage left: the PO answers its questions. */
  onProceedStage?(file: DocFile): void | Promise<unknown>;
  onEnableBacklog?(): void | Promise<unknown>;
  /** Decides the architecture of the five documents, in a repository session. */
  onDecideArchitecture?(): void | Promise<unknown>;
  /** Stage 7: the owner asks for the plans of every backlog item. */
  onPreparePlans?(): void | Promise<unknown>;
  onResolveClosing?(): void | Promise<unknown>;
  /** The owner moves on from a document's stage; `false` says the server refused. */
  onContinueStage?(doc?: DocFile, confirmLowScore?: boolean): void | boolean | Promise<unknown>;
  /** The final review puts a document in the Graphify graph as it is now; `false` says the server refused. */
  onAddToGraph?(doc: DocFile): void | boolean | Promise<unknown>;
  /** design.md is marked not applicable: the server writes the mark, keeps it as passed and, in a repository session, adds it to the graph. */
  onNotApplicable?(): void | boolean | Promise<unknown>;
  /** The owner moves on from the final review to the backlog; `false` says the server refused. */
  onCloseReview?(): void | boolean | Promise<unknown>;
  /** The owner asks the agents to review the document of a stage. */
  onEvaluateStage?(file: DocFile): void | Promise<unknown>;
  /** The owner asks for the review of a stage again, from the text that was passed to it. */
  /** The owner asks the Jev for the score of one document. */
  onScoreDoc?(file: DocFile): void | Promise<unknown>;
  /** The owner asks the Jev for the score of all five documents. */
  onScoreAll?(): void | Promise<unknown>;
  /** The owner's answer on whether the project is confidential. */
  onConfidential?(value: boolean): void | Promise<unknown>;
  /** Stage 2 of a new project: the whole backlog in one run, stopped by a question or an error and resumed by the next call. */
  /** Resolves to `false` when the server refused the answer: the owner's text then stays in its field. */
  onAnswer(id: string, text: string, docsAnswered: boolean): void | boolean | Promise<unknown>;
  onSkip(id: string): void | Promise<unknown>;
  /** The owner asks again for a question the guard dropped. */
  onReask?(id: string): void | Promise<unknown>;
  onAccept(id: string): void | Promise<unknown>;
  onReject(id: string, reason: string | null): void | Promise<unknown>;
  /** Takes back a decision queued while the team worked. */
  onUnqueue?(id: string): void | Promise<unknown>;
  /** Resolves to `false` when the server refused the value: the owner's text then stays in its field. */
  onSecret(name: string, value: string): void | boolean | Promise<unknown>;
  onStart(): void | Promise<unknown>;
  startState?: { label: string; busy: boolean };
  /** The score banner above offers the start, so the review panel does not repeat it. */
  hideStart?: boolean;
  events?: StoredEvent[];
}

/** Each verified divergence: the fact, both places with their quotes, and how to correct it. */
function Divergences({ items }: { items: Divergence[] }) {
  const place = (s: DivergenceSide) => `${docName(s.file)}${s.heading ? ` › ${s.heading}` : ''}`;
  return (
    <ul data-testid="refinement-divergence-list" className="m-0 mt-[0.35rem] list-none space-y-[0.45rem] p-0 text-ink-soft">
      {items.map((d, n) => (
        <li data-testid="refinement-divergence-item" key={n}>
          <span data-testid="refinement-divergence-fact" className="block text-ink">{d.fact}</span>
          <span data-testid="refinement-divergence-where" className="block">{`Onde: ${place(d.a)} — “${d.a.quote}” × ${place(d.b)} — “${d.b.quote}”`}</span>
          <span data-testid="refinement-divergence-fix" className="block">{`Como corrigir: ${d.fix || 'corrija o trecho divergente nos documentos e reavalie.'}`}</span>
        </li>
      ))}
    </ul>
  );
}

function Checklist({ items, role }: { items: ChecklistItem[]; role: 'po' | 'sm' }) {
  const own = items.filter((i) => i.role === role);
  if (own.length === 0) return <p data-testid="refinement-checklist-empty" className={fileEmpty}>Preenchida na primeira avaliação.</p>;
  return (
    <ul data-testid="refinement-checklist-list" className="m-0 list-none rounded-lg border border-line bg-surface py-[0.55rem] pr-3 pl-[1.1rem] text-[0.8rem] leading-[1.45] text-justify">
      {own.map((i) => (
        <li data-testid={`refinement-checklist-item-${i.id}`} key={i.id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 py-[0.4rem] text-[0.8125rem] text-ink">
          <span data-testid={`refinement-checklist-status-${i.id}`} className={`grid h-5 place-items-center ${i.passed ? 'text-good' : 'text-warn'}`} role="img" aria-label={i.passed ? 'Atendido' : 'Não atendido'}><Icon name={i.passed ? 'check' : 'close'} size={16} /></span>
          <div data-testid={`refinement-checklist-body-${i.id}`}>{checkLabel[i.id] ?? i.id.slice(3)}<small data-testid={`refinement-checklist-detail-${i.id}`} className="mx-0 mt-[0.15rem] mb-0 block leading-[1.35] text-ink-soft">{checkDetail(i.detail)}</small>{i.divergences?.length ? <Divergences items={i.divergences} /> : null}</div>
        </li>
      ))}
    </ul>
  );
}

/** The questions the guard dropped as repeats of decided ones: each shows what it repeats, and the owner may ask it again. */
function DroppedRepeats({ rows, locked, onReask, compact = false }: { rows: DroppedQuestionRow[]; locked: boolean; onReask: (id: string) => unknown; compact?: boolean }) {
  return (
    <details open className="group rounded-lg border border-line bg-surface px-4 py-3" data-testid="dropped-repeats">
      <summary data-testid="refinement-dropped-repeats-summary" className="flex cursor-pointer list-none items-center gap-2 text-[0.8125rem] font-semibold text-ink [&::-webkit-details-marker]:hidden">
        <span data-testid="refinement-dropped-repeats-chevron" className="text-ink-soft transition-transform group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
        Perguntas repetidas que não foram feitas de novo ({rows.length})
      </summary>
      <ul data-testid="refinement-dropped-repeats-list" className="m-0 mt-3 grid list-none gap-3 p-0">
        {rows.map((r) => (
          <li data-testid={`refinement-dropped-repeat-${r.questionId}`} key={r.questionId} className="grid gap-[0.3rem] border-t border-line pt-3">
            <p data-testid={`refinement-dropped-repeat-text-${r.questionId}`} className="m-0 text-[0.875rem] text-ink-soft">{r.text}</p>
            {compact ? (
              <small data-testid={`refinement-dropped-repeat-note-${r.questionId}`} className="text-[0.75rem] text-ink-soft">{r.matchedAnswer === null ? 'Repete uma pergunta que você ignorou.' : `Resolvida com "${r.matchedAnswer}"`}</small>
            ) : (
              <>
                <p data-testid={`refinement-dropped-repeat-before-${r.questionId}`} className="m-0 text-[0.8125rem] text-ink-soft">Antes: {r.matchedText}</p>
                <p data-testid={`refinement-dropped-repeat-answer-${r.questionId}`} className="m-0 text-[0.875rem] font-semibold text-ink">{r.matchedAnswer === null ? 'Você ignorou esta pergunta.' : `Você respondeu: ${r.matchedAnswer}`}</p>
              </>
            )}
            <ActionButton className="secondary h-10 w-fit px-3 text-[0.8125rem]" data-testid={`reask-${r.questionId}`} disabled={locked} onClick={() => onReask(r.questionId)}>Perguntar de novo</ActionButton>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function RefinementView(p: ViewProps) {
  const navigate = useNavigate();
  const { snap, busy, saveError } = p;
  const st = snap.state;
  const [tab, setTab] = useState<DocFile>('flow.md');
  const [docs, setDocs] = useState(snap.docs);
  // The text on screen as of now: an answer from the agents arrives after the click, so it reads the text it finds then.
  const docsNow = useRef(docs);
  useEffect(() => {
    docsNow.current = docs;
  }, [docs]);
  const [suggesting, setSuggesting] = useState(false);
  const [askRe, setAskRe] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(true);
  const [architectureNote, setArchitectureNote] = useState<string | null>(null);
  const [prepareClick, setPrepareClick] = useState<{ at: number; inputHash?: string } | null>(null);
  const [busyDialog, setBusyDialog] = useState(false);
  const [ask, setAsk] = useState<{ title: string; text: string; confirmLabel: string; tone?: 'danger' | 'accent'; icon?: 'trash' | 'refresh' | 'file' | 'check'; onConfirm: () => void } | null>(null);
  // The owner's button for everything: the team takes the autonomy to answer, decide, repair and prepare, after one confirmation.
  const resolveAll = () => setAsk({ title: 'Preparar o backlog', text: 'O time revisa os documentos (PO e SM), aceita as sugestões, responde as perguntas, gera o specs.md e os planos, corrige o que for reprovado, coloca os cinco documentos no Graphify e salva tudo nos repositórios. Só para quando o desenvolvimento puder começar. Isso usa chamadas de agente.', confirmLabel: 'Preparar backlog', tone: 'accent', icon: 'check', onConfirm: () => { setPreparing(true); void Promise.resolve(p.onResolveAll?.()).finally(() => setPreparing(false)); } });
  // A new project is refined one document per screen; the step lives in the address, so a reload opens the same screen.
  // A running project opens on the step named in the address when it is open, else stage 7; an old `vista=backlog` address opens stage 7.
  const [step, setStep] = useState<WizardStep>(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('vista') === 'backlog') return 'backlog';
    if (snap.state.status === 'started' && parseStep(query.get('etapa')) === null) return 'backlog';
    return initialStep(snap.state, query.get('etapa'));
  });
  const stepMoved = useRef(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (stepMoved.current) stepHeading.current?.focus();
  }, [step]);
  // Nothing changed since the last evaluation: a new one would spend the same calls on the same documents.
  const changedSince = useMemo(() => {
    const events = p.events ?? [];
    const lastEvaluated = events.filter((e) => e.type === 'REFINE_EVALUATED').at(-1)?.seq ?? 0;
    return events.some((e) => e.seq > lastEvaluated && CHANGE_EVENTS.has(e.type));
  }, [p.events]);
  const unchanged = st.cycle > 0 && !st.stale && !changedSince;
  const attachInput = useRef<HTMLInputElement>(null);
  const docFileInput = useRef<HTMLInputElement>(null);
  // What the owner typed for each open question: every question keeps its own draft, so several can be answered one after the other.
  const [drafts, setDrafts] = useState<Record<string, { text: string; docs: boolean }>>({});
  const draftOf = (id: string) => drafts[id] ?? { text: '', docs: false };
  const setDraft = (id: string, change: Partial<{ text: string; docs: boolean }>) => setDrafts((all) => ({ ...all, [id]: { ...(all[id] ?? { text: '', docs: false }), ...change } }));
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // The patch being accepted or rejected: both of its buttons stay locked until the action ends.
  const [deciding, setDeciding] = useState<string | null>(null);
  const decide = (patchId: string, action: () => unknown) => {
    setDeciding(patchId);
    return Promise.resolve(action()).finally(() => setDeciding(null));
  };
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [newSecrets, setNewSecrets] = useState<Array<{ id: number; name: string; value: string }>>([]);
  // The text the server holds for each document, with its hash: a save is sent over that hash, and text typed beyond it is not saved yet.
  const baseline = useRef<Partial<Record<DocFile, { text: string; hash?: string }>>>(
    Object.fromEntries(DOC_STAGES.map((file) => [file, { text: snap.docs[file], hash: snap.hashes?.[file] }])),
  );
  // A reload moves the editor to the server text, except where the owner typed text the server does not hold yet.
  useEffect(() => {
    const held = baseline.current;
    const adopted: Partial<Record<DocFile, string>> = {};
    for (const file of DOC_STAGES) {
      if (docs[file] !== held[file]?.text) continue;
      held[file] = { text: snap.docs[file], hash: snap.hashes?.[file] };
      if (snap.docs[file] !== docs[file]) adopted[file] = snap.docs[file];
    }
    if (Object.keys(adopted).length === 0) return;
    // Only a file still showing the text read above takes the server text: a keystroke made meanwhile stays.
    setDocs((local) => {
      const next = { ...local };
      for (const file of DOC_STAGES) {
        if (adopted[file] !== undefined && local[file] === docs[file]) next[file] = adopted[file];
      }
      return next;
    });
  }, [snap.docs]);
  // Saves run one after another, so each one is sent over the hash the one before it left; an idle page sends at once.
  const saves = useRef<Promise<boolean> | null>(null);
  const sendSave = async (file: DocFile, text: string, keepalive: boolean): Promise<boolean> => {
    const held = baseline.current[file];
    if (held?.text === text) return true;
    try {
      const hash = keepalive ? await p.onSaveDoc(file, text, held?.hash, true) : await p.onSaveDoc(file, text, held?.hash);
      if (hash === null) return false;
      baseline.current[file] = { text, hash: hash ?? undefined };
      return true;
    } catch (e) {
      if (!isOrganizingError(e as Error)) return false;
      // The server is organizing the document for a moment: the text is sent again by itself, with no message.
      await new Promise((resolve) => setTimeout(resolve, BUSY_SAVE_RETRY_MS));
      // The layout moved the document to a new hash, so the retry is sent over the one the server holds now.
      const fresh = await p.onReadDoc?.(file);
      if (!fresh) return false;
      baseline.current[file] = fresh;
      return sendSave(file, text, keepalive);
    }
  };
  const saveText = (file: DocFile, text: string): Promise<boolean> => {
    const run = () => sendSave(file, text, false);
    saves.current = saves.current ? saves.current.then(run, run) : run();
    return saves.current;
  };
  // A save made as the page hides is sent at once, not behind an earlier save, so the browser can still send it as the page closes.
  const saveHidden = (file: DocFile, text: string): void => {
    saves.current = sendSave(file, text, true);
  };
  // The text typed last is saved before the server reads the document: a save the server refuses stops the action.
  const saveTyped = async (): Promise<boolean> => {
    if (!isDocStep(step) || locked || docs[step] === baseline.current[step]?.text) return true;
    return saveText(step, docs[step] ?? '');
  };
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
  // The button shows the spinner until the request answers; the server's own work keeps it on while the snapshot reports it busy.
  const [preparing, setPreparing] = useState(false);
  // The server holds a process of its own (the plans, the specs, a check) that the page may not have seen start: the decisions on suggestions wait for it, with a notice on the click.
  const serverBusy = snap.busy === true && !st.graphing;
  const locked = evaluating || st.status === 'started';
  // A document in Graphify holds the buttons that run the agents: the server refuses them until the extraction ends, the editor stays open.
  const graphingNow = Boolean(st.graphing);
  const runLocked = locked || graphingNow;
  const graphReason = 'Espere a extração do Graphify terminar: os botões liberam sozinhos.';
  const jevAdvisory = st.error?.startsWith('Jev bloqueou') ?? false;
  const pending = [...st.questions.filter((q) => q.status === 'pending')].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const current = pending[0];
  const speckitAsked = speckitQuestions(st);
  const specsAsked = specsQuestions(st);
  const canStart = canStartRun(snap.state, busy);
  // Past the lock round, another evaluation is refused by the server: the button says so instead of failing.
  const atMax = snap.limits !== undefined && st.cycle - (st.stageStartCycle ?? 0) >= snap.limits.max;
  const limitTitle = atMax ? `Limite de ${snap.limits?.max} rodadas nesta etapa` : undefined;
  const backlogOn = st.backlog?.enabled === true;
  // A new project's refinement has two mandatory stages: the documents, then the backlog the program runs from.
  const newProject = st.mode === 'new-project';
  const onStage = currentStage(st);
  const noContradictions = st.checklist.find((c) => c.id === 'po.no-contradictions');
  const stageDivergences = st.stageAlignment?.[tab];
  const staleFrom = st.staleBy?.[tab] as DocFile | undefined;
  const aligned = newProject ? alignedLine(stageDivergences, noContradictions) : null;
  const openChecks = st.checklist.filter((c) => !c.passed).map((c) => c.id);
  // The text typed on a stage screen is saved a moment after the owner stops typing.
  const typed = isDocStep(step) ? docs[step] : undefined;
  useEffect(() => {
    if (!newProject || !isDocStep(step) || locked || typed === undefined) return;
    const timer = setTimeout(() => void saveText(step, typed), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [typed, step, locked, newProject]);
  // A new project's owner sees the document of the stage they are on; Continuar moves the view along.
  // The view follows only an owner who is on the stage that just ended: one reading another document stays there.
  const stageBefore = useRef(onStage);
  useEffect(() => {
    const before = stageBefore.current;
    stageBefore.current = onStage;
    if (newProject && onStage) setTab((current) => (before === undefined || current === before ? onStage : current));
  }, [onStage, newProject]);
  // The agents start only when the owner clicks a button: opening or reloading a page never calls them.
  const stageStep = newProject ? stageAction(st) : null;
  // The note sits under the coverage of the spec tree; without a tree it sits under the backlog panel.
  const backlogBlock = (note: ReactNode) => {
    const panel = <MemoBacklogPanel backlog={st.backlog} evaluating={evaluating} locked={locked} onEnable={newProject ? undefined : p.onEnableBacklog} mandatory={newProject} hideTitle />;
    // A detailed backlog opens its list of specs from the coverage chip; before that the list stands alone.
    return st.backlog?.detail ? <MemoSpecTree backlog={st.backlog} evaluating={evaluating} note={note} locked={locked} steps={st.speckit?.steps} /> : <>{panel}{note}</>;
  };
  // What the plan preparation covers: each backlog item, or the single spec as one item.
  const speckitList = useMemo(() => planItems(snap.specId, st as never), [snap.specId, st.backlog, st.derived, st.featureKey]);
  const itemTitles = new Map(speckitList.map((i) => [i.key, i.title]));
  const speckit = st.speckit;
  const speckitRunning = speckit?.status === 'running';
  // Every session prepares its plans before it starts; the server holds the same rule.
  const speckitReady = speckit?.status === 'done' && !speckit.stale;
  // What the plan preparation still owes the start, in plain words.
  const speckitReason = speckitRunning ? 'A preparação dos planos está em andamento.'
    : speckitAsked.some((q) => q.blocking) ? 'Responda a pergunta obrigatória dos planos.'
    : !speckitReady ? (speckit?.stale ? 'Os documentos mudaram: prepare os planos de novo.' : 'Prepare os planos antes de iniciar.')
    : undefined;
  // The start would open with a current preparation, so the preparation is the next step.
  const waitsForSpeckit = !canStart && canStartRun({ ...st, speckit: { status: 'done', stale: false }, questions: [] }, busy);
  const backlogStageHeading = (
    <header data-testid="refinement-backlog-heading" className="grid gap-1">
      <h2 data-testid="refinement-backlog-title" ref={stepHeading} tabIndex={-1} className="m-0 text-[1.25rem] font-semibold text-ink outline-none">Preparar o desenvolvimento</h2>
      <p data-testid="refinement-backlog-intro" className="m-0 text-[0.9375rem] leading-[1.55] text-ink-soft">Os agentes quebram os cinco documentos em itens do backlog, cada um com a sua spec. Quando o backlog estiver detalhado, o desenvolvimento pode começar.</p>
    </header>
  );
  // A wizard project and a backlog list markdown files only: specs.md, written by the evaluation, and the five documents.
  const mdFiles = backlogOn || newProject;
  const legacyFiles = !mdFiles;
  const specsMd = useMemo(() => (backlogOn && (st.backlog?.items.length ?? 0) > 0 ? renderSpecsMd(snap.specId, st.backlog as never) : ''), [backlogOn, snap.specId, st.backlog]);
  // One plan step per item, so the plans box lists the ones still to come.
  const speckitPlan = useMemo(() => speckitList.map((item) => ({ command: 'plan', itemKey: item.key })), [speckitList]);
  const speckitStatus = <PlansStatus speckit={speckit} titles={itemTitles} plan={speckitPlan} waiting={speckitAsked.some((q) => q.blocking)} startable={canStart} />;
  // A preparation whose inputs did not change reuses every plan: the owner is told, since nothing on screen changes.
  const preparedUnchanged = prepareClick !== null && !speckitRunning && speckit?.status === 'done' && speckit.startedAt !== undefined
    && Date.parse(speckit.startedAt) >= prepareClick.at && speckit.inputHash === prepareClick.inputHash;
  // A backlog prepares once it is detailed, a single spec once it is derived.
  const preparable = backlogOn ? st.backlog?.detail === true : Boolean(st.derived);
  const prepareButton = (
    <ActionButton data-testid="speckit-prepare" className={speckitReady ? 'secondary' : 'primary'} busy={speckitRunning} disabled={runLocked || speckitRunning || !preparable} title={preparable ? undefined : backlogOn ? 'Espere o backlog ficar detalhado' : 'Avalie a spec antes de preparar'} onClick={() => { setPrepareClick({ at: Date.now(), inputHash: speckit?.inputHash }); return p.onPreparePlans?.(); }} icon={<Icon name={speckit ? 'refresh' : 'play'} size={16} />}>
      {speckitRunning ? 'Preparando…' : speckit ? 'Preparar de novo' : 'Preparar os planos'}
    </ActionButton>
  );
  const baseDocs = (['project.md', 'flow.md', 'briefing.md', 'stack.md', 'design.md'] as DocFile[]).map((doc) => ({ doc, text: snap.docs[doc] }));
  // A wizard project lists specs.md; the single-spec flow lists the spec it derived, also as Markdown.
  const specFile = mdFiles ? { name: 'specs.md', text: specsMd } : { name: 'spec.md', text: st.derived ? renderSpecMd(st.derived.spec as never) : '' };
  // A detailed backlog numbers criteria across its item specs, so a question may cite any of them; a single-spec
  // derivation left in the journal from before backlog mode no longer counts.
  const criteria = backlogOn ? Object.values(st.backlog?.specs ?? {}).flatMap((row) => row.spec?.acceptanceCriteria ?? []) : st.derived?.spec.acceptanceCriteria ?? [];
  const listState = st.status === 'evaluating'
    ? { label: 'Avaliando', tone: 'tone-neutral' }
    : st.cycle === 0
      ? { label: 'Não avaliada', tone: '' }
      : (st.stages === true ? DOC_STAGES.some((doc) => (st.doneStages ?? []).includes(doc) && stageOutdated(st, doc)) : st.stale && !allStagesCurrent(st))
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
        : waitsForSpeckit && speckitReason
          ? speckitReason
        : st.backlog?.enabled && st.status === 'ready'
          ? st.backlog.detail
            ? pendingSuggestion
              ? 'O backlog detalhado está pronto. Aceite ou rejeite cada sugestão pendente, ou clique em Iniciar análise para começar sem elas, que vão para o histórico.'
              : 'O backlog detalhado está pronto: cada item tem spec e pré-plano. Clique em Iniciar análise para os agentes executarem o backlog. Para mudar algo antes, escreva nos documentos e reavalie.'
            : 'O backlog está pronto para revisão. Para mudar prioridades ou cortes, escreva no briefing.md e reavalie.'
        : st.backlog?.detail && !backlogDetailed
          ? 'O detalhamento ainda não cobre todos os itens: clique em Reavaliar para gerar a spec e o pré-plano do que falta; o que faltar aparece em vermelho na cobertura.'
        : canStart && !green
          ? `Critérios ainda reprovados: ${st.checklist.filter((c) => !c.passed).map((c) => c.id).join(', ')}. Você decide: inicie agora ou corrija os documentos e reavalie.`
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
      .then((text) => { if (text !== null) replaceDoc(file, suggestionDialog, () => setDocs((d) => ({ ...d, [file]: text }))); })
      .finally(() => setSuggesting(false));
  };
  // Without flow.md the agents have nothing to write from: the server refuses, so the button says so first.
  const flowEmpty = docs['flow.md'].trim() === '';
  const suggestTitle = graphingNow ? graphReason : flowEmpty ? 'Preencha o flow.md antes de pedir uma sugestão.' : 'Gera este documento a partir do flow.md';
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
      if (text !== null) replaceDoc('design.md', suggestionDialog, () => setDocs((d) => ({ ...d, 'design.md': text })));
    } finally {
      setSuggesting(false);
    }
  };
  const readText = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(f);
    });
  /** The question of the system dialog, with what to do once the owner confirms. */
  const askDialog = ask ? (
    <ConfirmDialog title={ask.title} confirmLabel={ask.confirmLabel} tone={ask.tone} icon={ask.icon} confirmTestId="stage-confirm" onConfirm={() => { const go = ask.onConfirm; setAsk(null); go(); }} onCancel={() => setAsk(null)}>
      {ask.text}
    </ConfirmDialog>
  ) : null;
  /** Replacing a document that holds text asks the owner first; an empty one is replaced at once. */
  const replaceDoc = (doc: DocFile, dialog: { title: string; text: string; confirmLabel: string; icon: 'file' | 'check' }, apply: () => void) => {
    if (docsNow.current[doc].trim() === '') apply();
    else setAsk({ ...dialog, tone: 'accent', onConfirm: apply });
  };
  /** The agent's text takes the place of the document only after the owner confirms. */
  const suggestionDialog = { title: 'Substituir pelo texto sugerido', text: 'O texto atual deste documento será trocado pelo texto sugerido. Copie o seu texto antes, se quiser guardá-lo.', confirmLabel: 'Substituir', icon: 'file' as const };
  const markNotApplicable = () => replaceDoc('design.md', { title: 'Marcar o design como não se aplica', text: 'O texto do design será trocado por "Não se aplica".', confirmLabel: 'Marcar', icon: 'check' }, () => {
    setDocs((d) => ({ ...d, 'design.md': NOT_APPLICABLE_DESIGN }));
    // The server writes the mark itself, so the text counts as held: the reload brings the hash it has now.
    baseline.current['design.md'] = { text: NOT_APPLICABLE_DESIGN };
    void p.onNotApplicable?.();
  });
  const attachDoc = async (files: FileList | null, doc: DocFile = tab) => {
    const file = files?.[0];
    if (!file) return;
    const text = await readText(file).catch(() => null);
    if (text === null) return;
    replaceDoc(doc, { title: 'Anexar o arquivo', text: 'O texto atual deste documento será trocado pelo arquivo anexado.', confirmLabel: 'Anexar', icon: 'file' }, () => {
      setDocs((d) => ({ ...d, [doc]: text }));
      void saveText(doc, text);
    });
  };
  const tabButton = (f: DocFile) => (
    <span data-testid={`refinement-tab-${f}`} key={f} className="inline-flex items-center">
      <button
        data-testid={`refinement-tab-button-${f}`}
        className={`min-w-[auto] h-auto min-h-11 rounded-none border-0 border-b-2 bg-transparent px-3 py-[0.55rem] whitespace-nowrap transition-none hover:enabled:bg-surface-sunken hover:enabled:text-ink ${tab === f ? 'border-accent text-accent-text' : 'border-transparent text-ink-soft'}`}
        onClick={() => setTab(f)}
      >
        {docLabel[f]}
      </button>
      {/* The icon sits beside the tab: a button cannot hold another button. */}
      <InfoTip text={backlogOn && f === 'briefing.md' ? briefingImpact : docTip[f]} label={docLabel[f]} />
    </span>
  );
  /** Asked until the owner answers: a stage session sends no document to the Jev before. */
  const confidentialAsk = st.stages === true && st.confidential === undefined ? (
    <div className={notice} data-testid="confidential-ask">
      <p data-testid="refinement-confidential-question" className="m-0">Este projeto é confidencial? Sem resposta, nenhum documento vai ao Jev.</p>
      <div data-testid="refinement-confidential-actions" className="mt-2 flex flex-wrap gap-2">
        <button type="button" data-testid="confidential-yes" onClick={() => p.onConfidential?.(true)}>Sim, é confidencial</button>
        <button type="button" data-testid="confidential-no" onClick={() => p.onConfidential?.(false)}>Não é confidencial</button>
      </div>
    </div>
  ) : null;
  const docsTitle = existing ? (st.mode === 'continue' ? 'Continuação da spec' : 'Spec nova') : 'Documentos do projeto';
  /** The checks of a stage, from the state and the snapshot's format problem. */
  const stageLines = (file: DocFile) => {
    const graphError = st.graphError?.file === file ? st.graphError.reason : null;
    return stageChecklist({
      processed: st.passedStages?.includes(file) ?? false,
      formatProblem: snap.stageProblems?.[file] ?? null,
      graphed: st.graphed?.includes(file) ?? false,
      graphing: st.graphing === file,
      graphError,
    });
  };
  /** The first failing check of a stage: what the disabled Continuar names. Null when the stage can continue. */
  const stageBlock = (file: DocFile): StageCheck | null => firstFailing(stageLines(file));
  const docsPanel = (
    <section data-testid="refinement-docs-panel" className={panelCard}>
      <div data-testid="refinement-docs-panel-heading" className={panelHeading}>
        <div data-testid="refinement-docs-panel-title-row" className="flex min-w-0 items-center gap-3">
          <span data-testid="refinement-docs-panel-tile" className={`${headingTile} text-[color:var(--tile-accent-ink)] [background:var(--tile-accent)]`}><Icon name="file" size={26} /></span>
          <div data-testid="refinement-docs-panel-title-group"><span data-testid="refinement-docs-panel-eyebrow" className={eyebrow}>Área de trabalho</span>
          <h2 data-testid="refinement-docs-panel-title" className={panelTitle}>{docsTitle}</h2>
          </div>
        </div>
      </div>
      {newProject ? (
        <>
          {confidentialAsk}
          <StageSteps views={stageViews(st)} shown={tab} />
        </>
      ) : existing ? (
        <div data-testid="refinement-docs-tabs-existing" className="mb-4 flex flex-wrap gap-x-6 border-b border-line" role="tablist" aria-label="Documentos">
          <div className="flex flex-wrap items-center" data-testid="docs-group-spec">
            <span data-testid="refinement-docs-group-spec-label" className={tabGroupLabel}>Spec</span>
            {tabButton('briefing.md')}
          </div>
          <div className="flex flex-wrap items-center" data-testid="docs-group-project">
            <span data-testid="refinement-docs-group-project-label" className={tabGroupLabel}>Contexto do projeto · muda só com sua aprovação</span>
            {(['flow.md', 'project.md', 'stack.md', 'design.md'] as DocFile[]).map(tabButton)}
          </div>
        </div>
      ) : (
        <div data-testid="refinement-docs-tabs-new" className="mb-4 flex flex-wrap border-b border-line" role="tablist" aria-label="Documentos do projeto">
          {(['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'] as DocFile[]).map(tabButton)}
        </div>
      )}
      <p data-testid="doc-impact" className="hint">{backlogOn && tab === 'briefing.md' ? briefingImpact : docImpact[tab]}</p>
      <div data-testid="refinement-docs-editor" className="grid gap-2">
        {/* The editor's actions sit above it, so they never cover the document's first lines. */}
        <div data-testid="refinement-docs-actions" className="flex flex-col gap-2">
          {tab !== 'flow.md' && p.onSuggestDoc && (
            <ActionButton data-testid="suggest" className="h-10 px-[0.8rem]" busy={suggesting} disabled={runLocked || flowEmpty} title={suggestTitle} onClick={() => suggest(tab)} icon={<Icon name="lightbulb" size={16} />}>
              {suggesting ? 'Sugerindo…' : 'Sugerir'}
            </ActionButton>
          )}
          {tab === 'design.md' && p.onDesignFromImages && (
            <>
            <button type="button" data-testid="refinement-docs-attach-image" className="h-10 px-[0.8rem]" disabled={runLocked || suggesting} title="Ajusta o design.md pelas cores, fontes e alinhamentos de imagens de exemplo; as imagens são apagadas depois" onClick={() => attachInput.current?.click()}>
              Anexar imagem
              <Icon name="file" size={16} />
            </button>
            <input ref={attachInput} data-testid="attach-images" type="file" accept="image/png,image/jpeg" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
            </>
          )}
          {newProject && (
            <>
              <button type="button" data-testid="refinement-docs-attach-file" className="h-10 px-[0.8rem]" disabled={locked} onClick={() => docFileInput.current?.click()}>
                Anexar arquivo
                <Icon name="file" size={16} />
              </button>
              <input ref={docFileInput} data-testid="attach-doc" type="file" accept=".md,.txt,text/markdown,text/plain" hidden onChange={(e) => { void attachDoc(e.target.files); e.target.value = ''; }} />
            </>
          )}
          {newProject && tab === 'design.md' && (
            <button type="button" data-testid="refinement-docs-not-applicable" className="h-10 px-[0.8rem]" disabled={runLocked} title={graphingNow ? graphReason : undefined} onClick={markNotApplicable}>Não se aplica</button>
          )}
          <button type="button" data-testid="refinement-docs-copy" className="h-10 px-[0.8rem]" aria-label="Copiar documento" onClick={() => copyDoc(docs[tab] ?? '')}>
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
        onChange={(e) => setDocs((d) => ({ ...d, [tab]: e.target.value }))}
        onBlur={() => {
          if (!locked) void saveText(tab, docs[tab] ?? '');
        }}
      />
      {saveError && <p role="alert" data-testid="refinement-save-error" className={notice}>{saveError}</p>}
      </div>
      {newProject && (
        <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="stage-nav">
          <button type="button" data-testid="stage-back" disabled={!previousStage(tab) || locked} onClick={() => setTab(previousStage(tab)!)}>Voltar</button>
          {onStage ? (
            <>
              <ActionButton data-testid="stage-evaluate" disabled={runLocked || atMax} onClick={() => p.onEvaluateStage?.(onStage)} icon={<Icon name="check" size={16} />}>Avaliar esta etapa</ActionButton>
              <ActionButton data-testid="stage-continue" className="primary" disabled={locked || stageBlock(onStage) !== null} title={stageBlock(onStage)?.hint ?? undefined} onClick={() => p.onContinueStage?.()} icon={<Icon name="check" size={16} />}>Continuar</ActionButton>
            </>
          ) : (
            <ActionButton data-testid="stage-backlog" className="primary" disabled={locked} onClick={() => p.onEnableBacklog?.()} icon={<Icon name="play" size={16} />}>Quebrar o backlog</ActionButton>
          )}
        </div>
      )}
      {newProject && staleFrom && (
        <p data-testid="doc-stale" className={notice}>{docLabel[staleFrom]} mudou depois desta etapa: avalie esta etapa de novo.</p>
      )}
      {newProject && stageOutdated(st, tab) && (
        <p data-testid="doc-outdated" className={notice}>{docLabel[tab]} saiu do Graphify depois de uma edição: avalie esta etapa e continue para incluí-lo de novo.</p>
      )}
      {aligned && (
        <p data-testid="aligned" className="m-0 text-[0.8125rem] text-ink-soft">{aligned}</p>
      )}
      {newProject && openChecks.length > 0 && (
        <p data-testid="gap-summary" className="m-0 text-[0.8125rem] text-ink-soft">Lacunas: {openChecks.join(', ')}</p>
      )}
      {st.stale && (
        <p data-testid="stale" className={notice}>
          A lista de verificação está desatualizada: houve mudanças depois da última avaliação.
        </p>
      )}
      {jevAdvisory && <p data-testid="refinement-jev-advisory" className={notice}>O Jev é obrigatório no refinamento: ele valida os documentos e decide pontos da avaliação, e seus apontamentos são considerados por Claude, PO e SM. <InfoTip text={jevInfo} /></p>}
      <div data-testid="refinement-docs-footer" className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3">
        <span data-testid="refinement-docs-autosave-note" className="inline-flex items-start gap-[0.45rem] text-[0.8125rem] leading-[1.35] text-ink-soft"><Icon name="info" size={18} />As alterações são salvas automaticamente ao sair do editor.</span>
      </div>
      {askDialog}
      {busyDialog && <BusyDialog onClose={() => setBusyDialog(false)} />}
    </section>
  );
  // A new project offers one step at a time: the start, or the evaluation, never two primary actions.
  const showEvaluate = stageStep !== 'started';
  const startButton = (
    <ActionButton data-testid="start" className={newProject ? `${stageStep === 'start' ? 'primary' : 'secondary'} min-w-40 flex-auto` : 'primary mb-4 w-full'} busy={p.startState?.busy ?? false} disabled={!canStart} onClick={p.onStart} icon={<Icon name="play" size={16} />}>
      {p.startState?.label ?? 'Iniciar análise'}
    </ActionButton>
  );
  const reevaluateDialog = askRe ? (
    <ConfirmDialog title="Reavaliar sem mudanças" confirmLabel="Reavaliar mesmo assim" tone="accent" icon="refresh" confirmTestId="reevaluate-confirm" onConfirm={() => { setAskRe(false); void p.onEvaluate(); }} onCancel={() => setAskRe(false)}>
      <p data-testid="refinement-reevaluate-text">Nada mudou desde a última avaliação. Reavaliar gasta de novo as chamadas dos agentes (cerca de US$ 0,7) e pode dar um veredito diferente sobre os mesmos documentos.</p>
    </ConfirmDialog>
  ) : null;
  /** One pending question with its options, answer box and actions; `remaining` counts the open ones, this included. */
  // A question is answered while the agents work: the server queues the answer and applies it when they end.
  const answerLocked = st.status === 'started';
  const queuedOf = (id: string) => st.queued?.find((x) => x.id === id);
  const questionCard = (current: QuestionRow, remaining: number) => {
    const typed = draftOf(current.questionId);
    // A question the team asked about specs.md comes with its recommended choice marked: one click confirms it.
    const answer = typed.text === '' && drafts[current.questionId] === undefined && current.origin === 'specs' ? (current.options?.find((o) => o.recommended)?.label ?? '') : typed.text;
    const docsAnswered = typed.docs;
    const setAnswer = (text: string) => setDraft(current.questionId, { text });
    const setDocsAnswered = (docs: boolean) => setDraft(current.questionId, { docs });
    return (
        <div data-testid="refinement-question-card" className="rounded-lg border border-line bg-surface-sunken p-4">
          <div data-testid="refinement-question-badges" className="flex flex-wrap items-center gap-[0.35rem]">
            {current.origin === 'speckit'
              ? <><span data-testid="refinement-question-plan-badge" className={neutralBadge}>PLANO</span><InfoTip text="Pergunta da preparação dos planos de cada item do backlog." /></>
              : <><span data-testid="refinement-question-role-badge" className={badge(current.role)}>{current.role.toUpperCase()}</span><InfoTip text={roleInfo[current.role]} /></>}
            {current.blocking && <Tipped text="Pergunta que bloqueia o avanço: precisa de resposta antes de seguir."><span data-testid="refinement-question-blocking-tag" className="tag ml-0">Obrigatória</span></Tipped>}
          </div>
          {current.origin === 'speckit' && current.itemKey && <p data-testid="refinement-question-item-title" className="m-0 text-[0.8125rem] font-semibold text-ink-soft">Sobre o item {itemTitles.get(current.itemKey) ?? current.itemKey}</p>}
          {(current.origin === 'speckit' || current.origin === 'architecture') && current.context && <p data-testid="refinement-question-context" className="m-0 leading-normal text-ink-soft">{current.context}</p>}
          <p data-testid="refinement-question-text" className="m-0">{questionText(current.text)}</p>
          {current.origin === 'speckit' && (current.distinctFrom ?? []).length > 0 && (
            <div className="grid gap-[0.3rem] rounded-lg border border-line bg-surface px-4 py-3" data-testid="distinct-from">
              <p data-testid="refinement-distinct-title" className="m-0 text-[0.8125rem] font-semibold text-ink-soft">Por que não é a mesma pergunta</p>
              {(current.distinctFrom ?? []).map((d) => {
                const earlier = st.questions.find((q) => q.questionId === d.questionId);
                return (
                  <div data-testid={`refinement-distinct-item-${d.questionId}`} key={d.questionId} className="grid gap-[0.3rem] border-t border-line pt-3">
                    <p data-testid={`refinement-distinct-before-${d.questionId}`} className="m-0 text-[0.8125rem] text-ink-soft">Antes: {earlier?.text ?? d.questionId}</p>
                    <p data-testid={`refinement-distinct-answer-${d.questionId}`} className="m-0 text-[0.875rem] font-semibold text-ink">{earlier?.status === 'skipped' ? 'Você ignorou esta pergunta.' : `Você respondeu: ${earlier?.answer ?? ''}`}</p>
                    <p data-testid={`refinement-distinct-difference-${d.questionId}`} className="m-0 text-[0.8125rem] text-ink-soft">Diferença: {d.difference}</p>
                  </div>
                );
              })}
            </div>
          )}
          {current.blocking && <p data-testid="refinement-question-blocking-note" className="m-0 text-[0.8125rem] text-warn">{current.origin === 'speckit' || current.origin === 'specs' ? 'Bloqueia o início do desenvolvimento até você responder.' : (st.reprocessedStages ?? []).includes(current.file ?? '') ? 'Pode pular: Continuar avança sem resposta.' : 'Bloqueia o avanço até você responder.'}</p>}
          {current.relatedAcIds.length > 0 && (
            <small data-testid="refinement-question-criteria" className="question-criteria block leading-[1.6] text-ink-soft [&_.info-tip]:ml-[0.15rem]">
              Critérios de aceite:{' '}
              {current.relatedAcIds.map((id, i) => {
                const criterion = criteria.find((c) => c.id === id);
                return <Fragment key={id}>{i > 0 ? ', ' : ''}{id}{criterion ? <InfoTip text={criterionText(criterion)} /> : null}</Fragment>;
              })}
            </small>
          )}
          {current.options && current.options.length > 0 && (
            <OptionGroup lead="Escolha uma opção ou escreva a sua resposta abaixo." options={current.options} value={answer} onChange={setAnswer} disabled={answerLocked} />
          )}
          <label data-testid="refinement-question-answer-label" className="mt-4 mb-[0.4rem] block text-[0.8125rem] font-semibold text-ink-soft" htmlFor={`refinement-answer-${current.questionId}`}>Sua resposta</label>
          <textarea id={`refinement-answer-${current.questionId}`} data-testid="answer" className="min-h-28 w-full resize-y p-4 text-[0.9rem] leading-normal" value={answer} onChange={(e) => setAnswer(e.target.value)} />
          {/* A long label wraps under its text, so the checkbox and the tip sit on the first line. */}
          {current.origin !== 'speckit' && <div data-testid="refinement-question-docs-row" className="mt-3 mb-4 flex items-start gap-[0.35rem] text-[0.8125rem] leading-5 text-ink-soft [&_.info-tip]:mt-[0.1rem]">
            <label data-testid="refinement-question-docs-label" className="inline-flex cursor-pointer items-start gap-2">
              <input type="checkbox" className="m-0 mt-0.5 size-4 flex-none cursor-pointer" data-testid="docs-answered" checked={docsAnswered} onChange={(e) => setDocsAnswered(e.target.checked)} />
              Os documentos já respondiam esta pergunta
            </label>
            <InfoTip text="Marque quando a resposta já estava nos documentos: essas marcas medem quando o Jev pode responder sozinho." />
          </div>}
          {st.decisionDropped?.[current.questionId] && <p data-testid={`decision-dropped-${current.questionId}`} role="status" className="m-0 mb-2 text-[0.8125rem] text-warn">{st.decisionDropped[current.questionId]}</p>}
          {queuedOf(current.questionId) ? <QueuedNote id={current.questionId} kind="answer" onUndo={p.onUnqueue} /> : <div data-testid="refinement-question-actions" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <ActionButton
              className="primary"
              data-testid={`answer-${current.questionId}`}
              disabled={answerLocked || answer.trim() === ''}
              onClick={async () => {
                const sent = await p.onAnswer(current.questionId, answer, docsAnswered);
                // The answer leaves the field only once the server has taken it: a refused one stays for another try.
                if (sent !== false) setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== current.questionId)));
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
          </div>}
          <small data-testid="refinement-question-remaining" className="mt-2 block text-ink-soft">{remaining === 1 ? 'Esta é a última pergunta em aberto.' : remaining === 2 ? 'Mais 1 pergunta depois desta.' : `Mais ${remaining - 1} perguntas depois desta.`}</small>
        </div>
    );
  };
  /** One pending suggestion with its diff, reason box and the two decisions. */
  const patchCard = (x: PatchRow, i: number) => (
          <div data-testid={`refinement-patch-${x.patchId}`} key={x.patchId} className="mt-4 rounded-lg border border-line bg-surface p-[0.85rem]">
            <div data-testid={`refinement-patch-header-${x.patchId}`} className="flex flex-wrap items-center gap-[0.45rem] text-[0.82rem] text-ink">
              <span data-testid={`refinement-patch-role-${x.patchId}`} className={badge(x.role)}>{x.role === 'front' ? 'FRONT' : x.role.toUpperCase()}</span>
              <b data-testid={`refinement-patch-title-${x.patchId}`}>{isApproval(x) ? 'Aprovação de ajuste' : `Sugestão para ${docName(x.file)}`}</b>
              {i === 0 ? <InfoTip text={patchInfo} /> : null}
              <span data-testid={`refinement-patch-reason-${x.patchId}`} className="flex-[1_1_100%] leading-[1.4] text-ink-soft">{x.reason}</span>
            </div>
            <pre data-testid={`refinement-patch-diff-${x.patchId}`} className="mx-0 my-3 overflow-auto rounded-md bg-term-bg p-[0.8rem] text-[0.75rem] leading-normal text-term-ink">{x.diff}</pre>
            {st.decisionDropped?.[x.patchId] && <p data-testid={`decision-dropped-${x.patchId}`} role="status" className="m-0 mb-2 text-[0.8125rem] text-warn">{st.decisionDropped[x.patchId]}</p>}
            {queuedOf(x.patchId) ? <QueuedNote id={x.patchId} kind={queuedOf(x.patchId)!.kind === 'reject' ? 'reject' : 'accept'} onUndo={p.onUnqueue} /> : <div data-testid={`refinement-patch-actions-${x.patchId}`} className="grid grid-cols-2 items-center gap-2">
            <ActionButton className="min-w-[5.5rem] border-good-line bg-good-soft text-good hover:enabled:border-good aria-disabled:opacity-60 aria-disabled:cursor-not-allowed" data-testid={`accept-${x.patchId}`} aria-disabled={answerLocked} disabled={deciding !== null} onClick={() => (answerLocked ? setBusyDialog(true) : decide(x.patchId, () => p.onAccept(x.patchId)))} icon={<Icon name="check" size={16} />}>
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
            <ActionButton className="min-w-[5.5rem] border-bad-line bg-bad-soft text-bad hover:enabled:border-bad aria-disabled:opacity-60 aria-disabled:cursor-not-allowed" data-testid={`reject-${x.patchId}`} aria-disabled={answerLocked} disabled={deciding !== null} onClick={() => (answerLocked ? setBusyDialog(true) : decide(x.patchId, () => p.onReject(x.patchId, reasons[x.patchId] || null)))} icon={<Icon name="close" size={16} />}>
              Rejeitar
            </ActionButton>
            </div>}
          </div>
  );
  const reviewPanel = (
    <section data-testid="refinement-review-panel" className={panelCard}>
      <div data-testid="refinement-review-panel-heading" className={panelHeading}>
        <div data-testid="refinement-review-panel-title-row" className="flex min-w-0 items-center gap-3">
          <span data-testid="refinement-review-panel-tile" className={`${headingTile} text-[color:var(--tile-violet-ink)] [background:var(--tile-violet)]`}><Icon name="clipboard" size={26} /></span>
          <div data-testid="refinement-review-panel-title-group"><span data-testid="refinement-review-panel-eyebrow" className={eyebrow}>Refinamento</span>
          <h2 data-testid="refinement-review-panel-title" className={panelTitle}>Área de revisão</h2>
          </div>
        </div>
        <Tipped text="Quantas perguntas dos agentes e sugestões de documento ainda esperam a sua decisão.">
          <span data-testid="refinement-review-open-count" className={`count-pill ${openCount > 0 ? 'tone-warn' : 'tone-good'}`}>{openCount === 1 ? '1 pendência em aberto' : `${openCount} pendências em aberto`}</span>
        </Tipped>
      </div>
      <div data-testid="refinement-review-actions" className="mb-4 flex flex-wrap items-center gap-3">
        {newProject && !p.hideStart && startButton}
        {showEvaluate && (
        <ActionButton data-testid="evaluate" className={`${newProject && stageStep !== 'evaluate' ? 'secondary' : 'primary'} min-w-40 flex-auto`} busy={evaluating} disabled={runLocked || atMax} onClick={unchanged ? () => setAskRe(true) : p.onEvaluate} icon={<Icon name="check" size={16} />}>
          {st.cycle === 0 ? 'Avaliar' : 'Reavaliar'}
        </ActionButton>
        )}
        {reevaluateDialog}
      </div>
      {/* The plans box and its button sit right before the start, as on the screen that prepares a new project's development. */}
      {!newProject && <div className="mb-4 grid gap-3" data-testid="speckit-block">{speckitStatus}{prepareButton}</div>}
      {!newProject && !p.hideStart && startButton}
      {nextStep !== null && <p data-testid="refinement-review-next-step" className="m-0 mb-4 flex items-start gap-[0.6rem] rounded-lg border border-accent-line bg-accent-soft p-[0.85rem] text-[0.8125rem] leading-[1.45] text-ink [&_svg]:flex-none [&_svg]:text-accent-text"><Icon name="lightbulb" size={20} /><span data-testid="refinement-review-next-step-text"><b data-testid="refinement-review-next-step-label">Próximo passo:</b> {nextStep}{optional}</span></p>}
      {answerLocked ? null : current ? questionCard(current, pending.length) : (
        <p data-testid="refinement-review-no-questions" className={muted}>Nenhuma pergunta em aberto.</p>
      )}
      {(answerLocked ? [] : st.patches).filter((x) => x.status === 'pending').map(patchCard)}
      <DiscardedNotices rows={st.discarded} testId="refinement-discarded-notice" named />
      <details data-testid="refinement-history" className="group mt-5" open>
      <summary data-testid="refinement-history-summary" className="mx-0 mb-[0.7rem] flex cursor-pointer list-none items-center gap-[0.55rem] text-[0.8rem] tracking-[0.06em] text-ink uppercase [&>svg]:text-ink-soft [&::-webkit-details-marker]:hidden"><Icon name="clock" size={20} /><span data-testid="refinement-history-count" className="flex-1">Histórico · {st.questions.filter((q) => q.status !== 'pending').length + st.patches.filter((x) => x.status !== 'pending').length}</span><span data-testid="refinement-history-chevron" className="text-ink-soft transition-transform group-open:rotate-90"><Icon name="chevron-right" size={18} /></span></summary>
      <ul data-testid="refinement-history-list" className="m-0 list-none rounded-lg border border-line bg-surface px-4 py-[0.8rem] text-[0.8rem] leading-normal text-justify text-ink-soft empty:grid empty:min-h-[3.3rem] empty:place-items-center empty:before:text-ink-soft empty:before:content-['Nenhum_registro_no_momento.'] [&>li+li]:mt-[0.6rem] [&>li+li]:border-t [&>li+li]:border-line [&>li+li]:pt-[0.6rem]">
        {[...st.questions]
          .filter((q) => q.status !== 'pending')
          .reverse()
          .map((q) => (
            <li data-testid={`refinement-history-question-${q.questionId}`} key={q.questionId}>
              <span data-testid={`refinement-history-question-role-${q.questionId}`} className={badge(q.role)}>{q.role.toUpperCase()}</span> {questionText(q.text)} → {q.status === 'skipped' ? <i data-testid={`refinement-history-question-skipped-${q.questionId}`}>ignorada</i> : q.answer}{q.answeredBy ? <i data-testid={`refinement-history-question-assumed-${q.questionId}`}> (suposição do {q.answeredBy.toUpperCase()}, tirada dos documentos)</i> : null}
            </li>
          ))}
        {[...st.patches]
          .filter((x) => x.status !== 'pending')
          .reverse()
          .map((x) => (
            <li data-testid={`refinement-history-patch-${x.patchId}`} key={x.patchId}>
              {isApproval(x) ? 'Aprovação de ajuste' : `Sugestão para ${docName(x.file)}`} ({x.reason}) → {x.status === 'accepted' ? 'aceita' : x.status === 'rejected' ? 'rejeitada' : 'descartada'}
              {x.decision ? `: ${x.decision}` : ''}
            </li>
          ))}
      </ul>
      </details>
    </section>
  );
  const verificationDetails = (
    <>
      <div data-testid="refinement-quality-checklists" className={`grid gap-[0.3rem] ${evaluating ? 'opacity-60' : ''}`} aria-busy={evaluating || undefined}>
        <details data-testid="refinement-checklist-po" className="group">
          <summary data-testid="refinement-checklist-po-summary" className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[0.8125rem] font-semibold text-ink-soft [&::-webkit-details-marker]:hidden"><span data-testid="refinement-checklist-po-chevron" className="flex-none transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span><span data-testid="refinement-checklist-po-label" className="flex-1">Produto (PO)</span></summary>
          <Checklist items={st.checklist} role="po" />
        </details>
        <details data-testid="refinement-checklist-sm" className="group">
          <summary data-testid="refinement-checklist-sm-summary" className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[0.8125rem] font-semibold text-ink-soft [&::-webkit-details-marker]:hidden"><span data-testid="refinement-checklist-sm-chevron" className="flex-none transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span><span data-testid="refinement-checklist-sm-label" className="flex-1">Técnico (SM)</span></summary>
          <Checklist items={st.checklist} role="sm" />
        </details>
      </div>
    </>
  );
  /** The verification blocks (usage, checklist, generated files, tasks, secrets); the panel and the final review give it their own box. */
  const qualityBlock = (boxClass: string) => (
    <section data-testid="refinement-quality-block" className={boxClass}>
      <div data-testid="refinement-quality-heading" className={panelHeading}>
        <div data-testid="refinement-quality-title-row" className="flex min-w-0 items-center gap-3">
          <span data-testid="refinement-quality-tile" className={`${headingTile} text-[color:var(--tile-good-ink)] [background:var(--tile-good)]`}><Icon name="shield" size={26} /></span>
          <div data-testid="refinement-quality-title-group"><span data-testid="refinement-quality-eyebrow" className={eyebrow}>Controle de qualidade</span>
          <h2 data-testid="refinement-quality-title" className={panelTitle}>Lista de verificação</h2>
          </div>
        </div>
        <span data-testid="refinement-quality-status" className={`status-dot ${listState.tone}`}>{listState.label}</span>
      </div>
      <div data-testid="refinement-usage" className="mb-4 rounded-lg border border-line bg-surface px-[0.9rem] py-3">
        <p data-testid="refinement-usage-title" className="m-0 mb-[0.45rem] text-[0.8125rem] font-semibold text-ink">Consumo de IA no refinamento</p>
        <dl data-testid="refinement-usage-list" className="m-0 grid gap-[0.3rem] [&_dd]:m-0 [&_dd]:text-[0.875rem] [&_dd]:font-semibold [&_dd]:text-ink [&_dd]:tabular-nums [&_dt]:inline-flex [&_dt]:items-center [&_dt]:gap-[0.3rem] [&_dt]:text-[0.8125rem] [&_dt]:text-ink-soft [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-4">
          <div data-testid="refinement-usage-calls">
            <dt data-testid="refinement-usage-calls-label">Chamadas<InfoTip text="Quantas vezes um agente de IA foi acionado neste refinamento, somando todas as rodadas de avaliação." /></dt>
            <dd data-testid="refinement-usage-calls-value">{snap.tokens.steps}</dd>
          </div>
          <div data-testid="refinement-usage-tokens">
            <dt data-testid="refinement-usage-tokens-label">Tokens<InfoTip text={`Volume de texto processado pelos modelos de IA: ${snap.tokens.inputTokens} tokens lidos e ${snap.tokens.outputTokens} escritos. O custo cresce com o número de tokens.`} /></dt>
            <dd data-testid="refinement-usage-tokens-value">{snap.tokens.inputTokens + snap.tokens.outputTokens}</dd>
          </div>
          <div data-testid="refinement-usage-cost">
            <dt data-testid="refinement-usage-cost-label">Custo estimado<InfoTip text="Estimativa em dólares das chamadas aos modelos de IA neste refinamento, calculada pelos preços de API." /></dt>
            <dd data-testid="refinement-usage-cost-value">{money(snap.tokens.costUsd)}</dd>
          </div>
          <div data-testid="refinement-usage-last-evaluation">
            <dt data-testid="refinement-usage-last-evaluation-label">Última avaliação<InfoTip text="Quanto a última avaliação levou, do clique em Avaliar ou Reavaliar até ela terminar." /></dt>
            <dd data-testid="last-evaluation">{lastEvaluationText(snap.state.evaluation)}</dd>
          </div>
        </dl>
      </div>
      {step !== 'review' && verificationDetails}
      {!newProject && backlogBlock(null)}
      <h4 data-testid="refinement-quality-generated-title"><Icon name="file" size={20} />Arquivos gerados<InfoTip text={mdFiles ? "Os cinco documentos e o specs.md, que o Claude gera a cada avaliação. O plano de cada item parte desses seis arquivos." : "Os cinco documentos e o spec.md, a demanda que o Claude deriva a cada avaliação, com critérios de aceite e tarefas."} /></h4>
      {legacyFiles && (
        <>
      {st.derived?.spec && <p data-testid="spec-type">Tipo da demanda: <strong data-testid="refinement-spec-type-value">{typeLabel[st.derived.spec.type] ?? st.derived.spec.type}</strong></p>}
      {st.derived?.spec.type === 'bug' && st.derived.spec.bug && (
        <div data-testid="bug-details" className={`grid gap-[0.2rem] ${notice}`}>
          <strong data-testid="refinement-bug-details-title">Detalhes do bug</strong>
          <span data-testid="refinement-bug-actual">Comportamento atual: {st.derived.spec.bug.actual}</span>
          <span data-testid="refinement-bug-expected">Comportamento esperado: {st.derived.spec.bug.expected}</span>
          <span data-testid="refinement-bug-reproduction">Como reproduzir: {st.derived.spec.bug.reproduction}</span>
        </div>
      )}
        </>
      )}
      {step !== 'review' && <LazyDetails key={specFile.name} className={fileBox} summary={<><span data-testid="refinement-spec-file-name">{specFile.name}</span>{specFile.text ? <a data-testid={`download-${specFile.name.replace('.', '-')}`} href={mdDownload(specFile.text)} download={specFile.name} aria-label={`Baixar ${specFile.name}`} onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a> : <span data-testid="refinement-spec-file-status" className={fileStatus}>Aguardando avaliação</span>}</>} body={() => specFile.text ? <pre data-testid="refinement-spec-file-body" className="whitespace-pre-wrap break-words">{specFile.text}</pre> : <p data-testid="refinement-spec-file-empty" className={fileEmpty}>Será gerado após a avaliação.</p>} />}
      {baseDocs.map(({ doc, text }) => (
        <LazyDetails key={doc} className={fileBox} summary={<><span data-testid={`refinement-doc-file-name-${doc}`}>{doc}</span><a data-testid={`download-${doc.replace('.', '-')}`} href={mdDownload(text ?? '')} download={doc} aria-label={`Baixar ${doc}`} onClick={(e) => e.stopPropagation()}>Baixar<Icon name="download" size={16} /></a></>} body={() => <pre data-testid={`refinement-doc-file-body-${doc}`} className="whitespace-pre-wrap break-words">{text}</pre>} />
      ))}
      {legacyFiles && (
        <>
      <h4 data-testid="refinement-tasks-title"><Icon name="list" size={20} />Tarefas<InfoTip text="Tarefas descritas no briefing, extraídas a cada avaliação. Na execução, o SM as usa para montar o plano de trabalho." /></h4>
      <ul data-testid="refinement-tasks-list" className="m-0">
        {(st.derived?.spec.tasks ?? []).map((t, i) => (
          <li data-testid="refinement-task-item" key={i}>
            <b data-testid="refinement-task-title">{t.title}</b>: {t.description}
          </li>
        ))}
      </ul>
      {(st.derived?.spec.tasks ?? []).length === 0 && <div data-testid="refinement-tasks-empty" className="grid place-items-center gap-[0.35rem] rounded-lg border border-line bg-surface-sunken px-[0.8rem] py-[1.4rem] text-center text-ink-soft [&_svg]:text-ink-faint"><Icon name="clipboard" size={26} /><strong data-testid="refinement-tasks-empty-title" className="text-[0.85rem] text-ink">Nenhuma tarefa gerada ainda.</strong><span data-testid="refinement-tasks-empty-text" className="text-[0.78rem]">As tarefas aparecerão aqui após a avaliação.</span></div>}
        </>
      )}
      <div data-testid="refinement-secrets-heading" className="mt-5 flex items-center justify-between gap-3"><h4 data-testid="refinement-secrets-title" className="m-0!"><Icon name="lock" size={20} />Segredos<InfoTip text="Chaves e senhas de serviços externos que o projeto usa, como a URL de um banco de dados. Ficam salvas neste computador e o valor nunca volta a ser exibido." /></h4><button type="button" data-testid="refinement-secrets-add" className="secondary h-10 px-[0.7rem] text-[0.78rem]" onClick={() => setNewSecrets((rows) => [...rows, { id: Date.now(), name: '', value: '' }])}>Adicionar segredo<Icon name="plus" size={16} /></button></div>
      <ul data-testid="refinement-secrets-list" className="m-0 grid list-none gap-3 p-0">
        {snap.secrets.map((s) => (
          <li data-testid={`refinement-secret-${s.name}`} key={s.name} className={`${secretRow} border-line bg-surface-sunken`}>
            {/* A hint made only of asterisks is a mask, not a hint: it tells the user nothing. */}
            <div data-testid={`refinement-secret-header-${s.name}`} className="flex min-w-0 items-center gap-[0.45rem]"><code data-testid={`refinement-secret-name-${s.name}`} className="mr-auto text-[0.78rem] font-bold text-ink wrap-anywhere">{s.name}</code><InfoTip label={s.name} text={secretTip(s)} />{s.hint && /[^*]/.test(s.hint) && <small data-testid={`refinement-secret-hint-${s.name}`} className="text-[0.7rem] text-ink-soft">termina em {s.hint}</small>}<span data-testid={`refinement-secret-status-${s.name}`} className={`status-dot ${s.present ? 'ok' : 'warn'}`}>{s.present ? 'Salvo' : 'Não salvo'}</span></div>
            <div data-testid={`refinement-secret-entry-${s.name}`} className={`${secretEntry} grid-cols-[minmax(0,1fr)_7rem]`}><input type="password" autoComplete="new-password" className={secretInput} data-testid={`secret-${s.name}`} aria-label={`Novo valor de ${s.name}`} placeholder={s.present ? 'Digite um novo valor para substituir' : 'Cole o valor da chave'} value={secretValues[s.name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [s.name]: e.target.value })} /><ActionButton className={secretSave} data-testid={`save-secret-${s.name}`} disabled={!(secretValues[s.name] ?? '')} onClick={async () => { const value = secretValues[s.name]!; if ((await p.onSecret(s.name, value)) !== false) setSecretValues((all) => ({ ...all, [s.name]: '' })); }} icon={<Icon name="check" size={14} />}>Salvar</ActionButton></div>
          </li>
        ))}
        {newSecrets.map((s) => <li data-testid={`refinement-new-secret-${s.id}`} key={s.id} className={`${secretRow} border-accent-line bg-accent-soft`}><div data-testid={`refinement-new-secret-title-${s.id}`} className="flex items-center gap-[0.45rem] text-[0.78rem] font-bold text-ink">Nova variável<InfoTip text="Valor sigiloso que o projeto lê para acessar um serviço externo, como NATS_URL com o endereço do servidor de mensagens. Fica salvo neste computador e o valor nunca volta a ser exibido." /></div><div data-testid={`refinement-new-secret-entry-${s.id}`} className={`${secretEntry} grid-cols-[minmax(8rem,0.7fr)_minmax(0,1fr)_auto] max-[720px]:grid-cols-1`}><input data-testid={`refinement-new-secret-name-${s.id}`} className={secretInput} aria-label="Nome da chave" placeholder="NOME_DA_CHAVE" value={s.name} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === s.id ? { ...row, name: e.target.value.toUpperCase() } : row))} /><input data-testid={`refinement-new-secret-value-${s.id}`} type="password" autoComplete="new-password" className={secretInput} aria-label="Valor da chave" placeholder="Cole o valor da chave" value={s.value} onChange={(e) => setNewSecrets((rows) => rows.map((row) => row.id === s.id ? { ...row, value: e.target.value } : row))} /><button data-testid={`refinement-new-secret-save-${s.id}`} className={secretSave} disabled={!/^[A-Z][A-Z0-9_]*$/.test(s.name) || !s.value} onClick={async () => { if ((await p.onSecret(s.name, s.value)) !== false) setNewSecrets((rows) => rows.filter((row) => row.id !== s.id)); }}>Salvar<Icon name="check" size={16} /></button></div></li>)}
      </ul>
    </section>
  );
  const qualityPanel = qualityBlock(qualityCard);
  // The text of the step on screen is saved before the owner leaves it: by a step change, by Back, or by closing the page.
  const leaving = useRef<(hidden?: boolean) => void>(() => {});
  leaving.current = (hidden = false) => {
    if (!isDocStep(step) || locked) return;
    if (hidden) saveHidden(step, docs[step] ?? '');
    else void saveText(step, docs[step] ?? '');
  };
  useEffect(() => {
    // The text is saved when the page is hidden or closed, best effort: the browser may drop the request on the way out.
    const onHide = () => leaving.current(true);
    const onVisibility = () => {
      if (document.hidden) leaving.current(true);
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      leaving.current();
    };
  }, []);
  useEffect(() => {
    // Each step is an entry of the history, so the browser's Back returns to the step before.
    const onBack = () => {
      const named = initialStep(st, new URLSearchParams(window.location.search).get('etapa'));
      if (named === step) return;
      leaving.current();
      stepMoved.current = true;
      setStep(named);
    };
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, [step, st]);
  const goTo = (next: WizardStep | null) => {
    if (next === null || next === step) return;
    leaving.current();
    stepMoved.current = true;
    setStep(next);
    const url = new URL(window.location.href);
    url.searchParams.set('etapa', stepParam(next));
    url.searchParams.delete('vista');
    window.history.pushState(null, '', url);
  };
  const stageSession = st.stages === true;
  const doneStages = st.doneStages ?? [];
  const outdatedDocs = st.outdatedDocs ?? [];
  // What keeps Continuar closed, in plain words; the graph check is not one: Continuar itself adds the document.
  // A document scored below the pass line and not edited since: the agents already tried once, so the owner decides to go on.
  // The flag compares the percent on screen, so 49.6% (shown as 50%) is not below the line.
  const lowScore = isDocStep(step) && !doneStages.includes(step) && !outdatedDocs.includes(step) && st.readiness?.docs?.[step] !== undefined && percentOf(st.readiness.docs[step]!.score) < percentOf(PASS_LINE) ? percentOf(st.readiness.docs[step]!.score) : null;
  // A stale document, or an empty flow.md, closes Continuar in every stage session; a repository session also keeps the stage checks, but not the graph check, which Continuar itself serves.
  const continueBlock = ((): string | null => {
    if (!stageSession || !isDocStep(step)) return null;
    if (st.staleBy?.[step] !== undefined) return `Processe a etapa ${step} de novo antes de continuar.`;
    if (step === 'flow.md' && docs['flow.md'].trim() === '') return 'Escreva o flow.md antes de continuar: a etapa está vazia.';
    if (st.repositories !== true || doneStages.includes(step)) return null;
    const block = stageBlock(step);
    return block && block.id !== 'graphed' ? block.hint : null;
  })();
  const confidentialProject = st.confidential === true || st.readiness?.skipped === 'confidential';
  // The tokens count the Graphify extraction too, the cost does not: the line says so.
  const graphTokens = (snap.tokens.graph?.inputTokens ?? 0) + (snap.tokens.graph?.outputTokens ?? 0);
  const usageLine = `${snap.tokens.steps} chamadas · ${snap.tokens.inputTokens + snap.tokens.outputTokens} tokens (${graphTokens} do Graphify, pagos pelo plano) · ${money(snap.tokens.costUsd)} sem o Graphify`;
  const stageScreen = (file: DocFile) => {
    const score = st.readiness?.docs?.[file];
    const scoreOutdated = outdatedDocs.includes(file);
    const questions = docQuestions(st, file);
    const patches = docPatches(st, file);
    const divergences = st.stageAlignment?.[file];
    const alignment = file === 'flow.md'
      ? 'Primeira etapa: não há documento anterior.'
      : divergences
        ? divergences.length === 0 ? 'Alinhado com os documentos anteriores.' : `Não alinhado com os documentos anteriores: ${divergences.join('; ')}`
        : stageSession ? 'Ainda não revisado pelos agentes.' : null;
    const cause = st.staleBy?.[file] as DocFile | undefined;
    const discarded = st.discarded.filter((d) => d.file.split('/').pop() === file);
    const count = pendingCount(st, file);
    const jevBlocked = stageSession && st.confidential === undefined;
    const checks = stageLines(file);
    return (
      <div data-testid="refinement-stage-layout" className="grid grid-cols-[minmax(0,1fr)] gap-6 @3xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div data-testid="refinement-stage-main" className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3">
          <header data-testid="refinement-stage-heading" className="grid gap-1">
            <p data-testid="refinement-stage-eyebrow" className="m-0 text-[0.75rem] font-semibold tracking-[0.07em] text-ink-soft uppercase">Etapa {DOC_STAGES.indexOf(file) + 1} de {DOC_STAGES.length}</p>
            <h2 ref={stepHeading} tabIndex={-1} className="m-0 text-[1.25rem] font-semibold text-ink outline-none" data-testid="refinement-stage-title">{docLabel[file]}</h2>
            <p data-testid="doc-impact" className="m-0 text-[0.9375rem] leading-[1.55] text-ink-soft">{backlogOn && file === 'briefing.md' ? briefingImpact : docImpact[file]}</p>
          </header>
          {confidentialAsk}
          <div className="grid grid-cols-1 gap-2 *:w-full @3xl:flex @3xl:flex-wrap @3xl:items-center @3xl:*:w-auto" data-testid="editor-actions">
            <button type="button" data-testid="refinement-stage-attach-file" className="secondary h-10 px-[0.8rem]" disabled={locked} onClick={() => docFileInput.current?.click()}>
              Anexar arquivo
              <Icon name="file" size={16} />
            </button>
            <input ref={docFileInput} data-testid="attach-doc" type="file" accept=".md,.txt,text/markdown,text/plain" hidden onChange={(e) => { void attachDoc(e.target.files, file); e.target.value = ''; }} />
            {file !== 'flow.md' && p.onSuggestDoc && (
              <ActionButton data-testid="suggest" className="secondary h-10 px-[0.8rem]" busy={suggesting} disabled={runLocked || flowEmpty} title={suggestTitle} onClick={() => suggest(file)} icon={<Icon name="lightbulb" size={16} />}>
                {suggesting ? 'Sugerindo…' : 'Sugerir'}
              </ActionButton>
            )}
            {file === 'design.md' && p.onDesignFromImages && (
              <>
                <button type="button" data-testid="refinement-stage-attach-image" className="secondary h-10 px-[0.8rem]" disabled={runLocked || suggesting} title="Ajusta o design.md pelas cores, fontes e alinhamentos de imagens de exemplo; as imagens são apagadas depois" onClick={() => attachInput.current?.click()}>
                  Anexar imagem
                  <Icon name="file" size={16} />
                </button>
                <input ref={attachInput} data-testid="attach-images" type="file" accept="image/png,image/jpeg" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
              </>
            )}
            {file === 'design.md' && (
              <button type="button" data-testid="refinement-stage-not-applicable" className="secondary h-10 px-[0.8rem]" disabled={runLocked} title={graphingNow ? graphReason : undefined} onClick={markNotApplicable}>Não se aplica</button>
            )}
            <button type="button" data-testid="refinement-stage-copy" className="secondary h-10 px-[0.8rem]" aria-label="Copiar documento" onClick={() => copyDoc(docs[file] ?? '')}>
              Copiar
              <Icon name="copy" size={16} />
            </button>
          </div>
          <textarea
            className="min-h-[clamp(22rem,60vh,40rem)] w-full resize-y bg-surface-sunken p-4 font-mono text-[0.8125rem] leading-[1.6]"
            aria-label={`${docLabel[file]} editor`}
            data-testid={`doc-${file}`}
            value={docs[file] ?? ''}
            readOnly={locked}
            onChange={(e) => setDocs((d) => ({ ...d, [file]: e.target.value }))}
            onBlur={() => {
              if (!locked) void saveText(file, docs[file] ?? '');
            }}
          />
          {saveError && <p role="alert" data-testid="refinement-save-error" className={notice}>{saveError}</p>}
          <span data-testid="refinement-stage-autosave-note" className="inline-flex items-start gap-[0.45rem] text-[0.8125rem] leading-[1.35] text-ink-soft"><Icon name="info" size={18} />As alterações são salvas automaticamente ao sair do editor.</span>
        </div>
        <aside data-testid="refinement-stage-review" className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 border-line @max-3xl:border-t @max-3xl:pt-6 @3xl:border-l @3xl:pl-6" aria-label="Revisão da etapa">
          <div data-testid="refinement-stage-review-heading" className="flex flex-wrap items-center justify-between gap-3">
            <h3 data-testid="refinement-stage-review-title" className="m-0 text-[1rem] font-semibold text-ink">Revisão da etapa</h3>
            <span data-testid="refinement-stage-count" className={`count-pill ${count > 0 ? 'tone-warn' : 'tone-good'}`}>{count === 1 ? '1 pendência' : `${count} pendências`}</span>
          </div>
          {locked && <p data-testid="refinement-stage-locked" className="m-0 text-[0.8125rem] text-ink-soft" role="status">Avaliação em andamento{st.evaluation?.startedAt ? <> · <Elapsed since={st.evaluation.startedAt} /></> : '.'}</p>}
          <DocScoreInset label={docLabel[file]} doc={score}>
            {confidentialProject ? (
              <p data-testid="refinement-stage-confidential" className={`m-0 ${muted}`}>Projeto confidencial: o Jev não lê os documentos.</p>
            ) : (
              <>
                {!score && <p data-testid="refinement-stage-no-score" className={`m-0 ${muted}`}>Sem nota do Jev ainda.</p>}
                {score && scoreOutdated && <p data-testid="refinement-stage-score-outdated" className={`m-0 ${muted}`}>Nota anterior à última edição.</p>}
                {jevBlocked && <p data-testid="refinement-stage-jev-blocked" className={`m-0 ${muted}`}>Responda se o projeto é confidencial para usar o Jev.</p>}
                <ActionButton data-testid="score-doc" className="secondary h-10 w-full" disabled={runLocked || jevBlocked || (score !== undefined && !scoreOutdated)} title={score && !scoreOutdated ? 'A nota já está atual' : undefined} onClick={() => p.onScoreDoc?.(file)} icon={<Icon name="check" size={16} />}>
                  Validar com o Jev
                </ActionButton>
              </>
            )}
          </DocScoreInset>
          {alignment && <p data-testid="aligned" className="m-0 text-[0.8125rem] text-ink-soft">{alignment}</p>}
          {newProject && (
            <ol className="m-0 grid list-none gap-2 p-0" aria-label="Lista de verificação da etapa" data-testid="stage-checklist">
              {checks.map((check) => (
                <li key={check.id} className="flex items-start gap-2 text-[0.8125rem] text-ink-soft" data-testid={`check-${check.id}`} data-ok={check.ok}>
                  <Icon name={check.ok ? 'check' : 'info'} size={16} />
                  <span data-testid={`refinement-stage-check-text-${check.id}`}>
                    {check.id === 'graphed' ? graphLabel({ graphed: check.ok, graphing: st.graphing === file }, null) : check.label}
                    {!check.ok && check.hint ? ` — ${check.hint}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {cause && <p data-testid="doc-stale" className={notice}>{docLabel[cause]} mudou depois desta revisão: revise esta etapa de novo, se quiser.</p>}
          {!answerLocked && questions.map((q, i) => <Fragment key={q.questionId}>{questionCard(q, questions.length - i)}</Fragment>)}
          {!answerLocked && patches.map(patchCard)}
          {!answerLocked && count > 0 && p.onProceedStage && <ReviewDecision id={file} suggestions={patches.length} questions={questions.length} locked={locked} onApply={() => p.onApplyStage?.(file)} onProceed={() => p.onProceedStage?.(file)} onReview={p.onEvaluateStage ? () => p.onEvaluateStage?.(file) : undefined} />}
          <DiscardedNotices rows={discarded} testId="refinement-stage-discarded" named={false} />
          {count === 0 && !locked && <p data-testid="refinement-stage-no-pending" className={`m-0 ${muted}`}>Nenhuma pendência neste documento.</p>}
          {(st.droppedQuestions ?? []).some((d) => d.file === file) && <DroppedRepeats rows={(st.droppedQuestions ?? []).filter((d) => d.file === file)} locked={runLocked} onReask={(id) => p.onReask?.(id)} />}
        </aside>
      </div>
    );
  };
  const finalScreen = () => {
    // Only the suggestions the agents applied and the owner kept: a Reprocessar reverts the others.
    const autoApplied = st.patches.filter((x) => x.auto === true && x.status === 'accepted').length;
    const needsScore = DOC_STAGES.some((file) => !st.readiness?.docs?.[file] || outdatedDocs.includes(file));
    return (
      <div data-testid="refinement-final-layout" className="grid grid-cols-[minmax(0,1fr)] gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div data-testid="refinement-final-main" className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-5">
          <header data-testid="refinement-final-heading" className="grid gap-1">
            <p data-testid="refinement-final-eyebrow" className="m-0 text-[0.75rem] font-semibold tracking-[0.07em] text-ink-soft uppercase">Etapa final</p>
            <h2 ref={stepHeading} tabIndex={-1} className="m-0 text-[1.25rem] font-semibold text-ink outline-none" data-testid="refinement-final-title">Resumo</h2>
            <p data-testid="refinement-final-intro" className="m-0 text-[0.9375rem] leading-[1.55] text-ink-soft">Veja as notas, as pendências e o que foi verificado. Para mudar algo, volte à etapa do documento.</p>
          </header>
          {resolveBlock}
          {autoApplied > 0 && <p data-testid="final-auto-applied" className="m-0 text-[0.875rem] text-ink-soft">Os agentes aplicaram {autoApplied === 1 ? '1 sugestão' : `${autoApplied} sugestões`} que não mudam o escopo, sem precisar de você.</p>}
          <div className="grid gap-2 rounded-lg bg-surface-sunken px-3 py-2.5" data-testid="final-scores">
            <p data-testid="refinement-final-scores-title" className="m-0 text-[0.8125rem] text-ink-soft">Notas do Jev</p>
            {DOC_STAGES.map((file) => {
              const score = st.readiness?.docs?.[file];
              return (
                <div data-testid={`refinement-final-score-${file}`} key={file} className="grid gap-0.5 border-t border-line pt-2 first-of-type:border-0 first-of-type:pt-0">
                  <p data-testid={`refinement-final-score-line-${file}`} className="m-0 flex flex-wrap items-baseline gap-2 text-[0.875rem] text-ink">
                    <b data-testid={`refinement-final-score-name-${file}`}>{docLabel[file]}</b>
                    <span data-testid={`refinement-final-score-value-${file}`} className="tabular-nums">{score ? `${percentOf(score.score)}%` : 'sem nota'}</span>
                    {score && outdatedDocs.includes(file) && <span data-testid={`refinement-final-score-outdated-${file}`} className="text-[0.75rem] text-warn">desatualizada</span>}
                  </p>
                  {score && <ScoreChecks doc={score} />}
                </div>
              );
            })}
            {confidentialProject ? (
              <p data-testid="refinement-final-confidential" className={`m-0 ${muted}`}>Projeto confidencial: o Jev não lê os documentos.</p>
            ) : needsScore && (
              <ActionButton data-testid="score-all" className="secondary h-10 w-full" disabled={runLocked || (stageSession && st.confidential === undefined)} onClick={() => p.onScoreAll?.()} icon={<Icon name="check" size={16} />}>
                Validar com o Jev
              </ActionButton>
            )}
          </div>
          <div className="grid gap-3" data-testid="final-graph">
            <h3 data-testid="refinement-final-graph-title" className="m-0 text-[1rem] font-semibold text-ink">Graphify</h3>
            {DOC_STAGES.map((file) => {
              const inGraph = (st.graphed ?? []).includes(file);
              return (
                <div key={file} className="flex flex-wrap items-center justify-between gap-3 text-[0.875rem] text-ink" data-testid={`graph-row-${file}`}>
                  <span data-testid={`refinement-final-graph-status-${file}`}>{docLabel[file]}: {inGraph ? 'no Graphify' : 'fora do Graphify'}</span>
                  {!inGraph && <ActionButton data-testid={`graph-add-${file}`} className="secondary h-10 px-3" disabled={runLocked} title={graphingNow ? graphReason : undefined} onClick={() => p.onAddToGraph?.(file)}>Adicionar ao Graphify</ActionButton>}
                </div>
              );
            })}
          </div>
        </div>
        <div data-testid="refinement-final-quality" className="min-w-0 border-line @max-3xl:border-t @max-3xl:pt-6 @3xl:border-l @3xl:pl-6">{qualityBlock(`grid min-w-0 grid-cols-[minmax(0,1fr)] content-start ${qualityStyles}`)}</div>
      </div>
    );
  };
  // Why the final review cannot move on to the backlog yet, as the server words it; null when it can.
  const reviewBlock = ((): string | null => {
    if (!stageSession) return null;
    const open = DOC_STAGES.filter((file) => !doneStages.includes(file));
    // An outdated stage is only a notice: it never holds the move to the backlog.
    return st.repositories === true && open.length > 0 ? `Conclua as etapas dos documentos antes: falta ${open.join(', ')}.` : null;
  })();
  // Breaking the backlog down also waits for every document in Graphify, in a repository session.
  const breakdownBlock = ((): string | null => {
    const missing = DOC_STAGES.filter((file) => !(st.graphed ?? []).includes(file));
    if (reviewBlock) return reviewBlock;
    return st.repositories === true && stageSession && missing.length > 0 ? `Adicione os cinco documentos ao Graphify antes: falta ${missing.join(', ')}.` : null;
  })();
  // A stage the agents already processed once shows the button as a new run.
  const processedBefore = isDocStep(step) && (st.passedStages ?? []).includes(step);
  const failingChecks = st.checklist.filter((c) => !c.passed).length;
  const needsCard = (withStart = true) => (
      <StepCard id="needs" open={focusCard === 'needs'} focus={focusCard === 'needs'} icon="alert" tone="violet" title="Precisa de você" info="O que espera uma decisão sua antes de o desenvolvimento começar: perguntas do PO e do SM, pendências e o que ainda falta para iniciar." owner="Perguntas do PO e do SM" chip={openOwner > 0 ? { label: `${openOwner} em aberto`, tone: 'warn' } : { label: 'Nada em aberto', tone: 'ok' }}>
        {withStart && startMissing.length > 0 && <p data-testid="start-missing" role="status" className={notice}><b>Falta para iniciar o desenvolvimento:</b> {startMissing.join(' ')}</p>}
        {pendingSummary}
        {st.status !== 'started' && unfiled.length > 0 && (
          <div data-testid="round-questions" className="grid gap-3">
            <p data-testid="round-questions-intro" className="m-0 text-[0.875rem] leading-normal text-ink-soft">Todas as perguntas do PO e do SM que esperam você ficam aqui, nesta etapa.</p>
            {unfiled.map((q, i, all) => <Fragment key={q.questionId}>{questionCard(q, all.length - i)}</Fragment>)}
          </div>
        )}
      </StepCard>
  );
  /** The backlog items; a follow-on request also shows its plans and checks. */
  const backlogCards = (withPlans = false) => (
    <div className="card grid divide-y divide-line overflow-hidden p-0" data-testid="backlog-cards">
      <StepCard grouped id="backlog" open={focusCard === 'backlog'} focus={focusCard === 'backlog'} icon="list" tone="accent" title="Itens do backlog" info="Os cinco documentos quebrados em specs por épico, de P0 (base) a P3 (depois). Para mudar prioridades ou cortes, escreva no briefing.md e reavalie." owner="Montado pelo PO e pelo SM" chip={st.backlog?.detail && st.backlog.items.length > 0 && st.backlog.items.every((i) => st.backlog?.specs?.[i.key]?.spec) ? { label: `${st.backlog.items.length} ${st.backlog.items.length === 1 ? 'spec' : 'specs'} · detalhado`, tone: 'ok' } : { label: st.backlog?.items.length ? `${st.backlog.items.length} ${st.backlog.items.length === 1 ? 'spec' : 'specs'} · em preparo` : 'Em preparo' }}>
        {backlogBlock(startLine)}
      </StepCard>
      {withPlans && (
        <>
          <StepCard grouped id="plans" open={focusCard === 'plans' || speckitAsked.length > 0} focus={focusCard === 'plans'} icon="clipboard" tone="violet" title="Planos de implementação" info="Um agente escreve o plano de cada item do backlog, com os testes primeiro. O desenvolvimento só começa com todos os planos atuais." owner="Preparados pelo Dev" chip={speckitRunning ? { label: 'Preparando' } : speckitReady ? { label: 'Atuais', tone: 'ok' } : speckit?.stale ? { label: 'Desatualizados', tone: 'warn' } : { label: 'Não preparados' }}>
            {backlogOn && speckitStatus}
            {preparedUnchanged && <p role="status" data-testid="speckit-unchanged" className="m-0 text-[0.8125rem] text-ink-soft">Os planos já estavam atuais; nada foi refeito.</p>}
            {!locked && !speckitRunning && speckitAsked[0] && questionCard(speckitAsked[0], speckitAsked.length)}
            {(st.droppedQuestions ?? []).some((d) => d.origin === 'speckit') && <DroppedRepeats rows={(st.droppedQuestions ?? []).filter((d) => d.origin === 'speckit')} locked={runLocked} onReask={(id) => p.onReask?.(id)} />}
          </StepCard>
          <StepCard grouped id="checks" open={focusCard === 'checks' || specsAsked.length > 0} focus={focusCard === 'checks'} icon="shield" tone="good" title="Verificação" info="O specs.md é gerado a partir do backlog, sem nova revisão. As listas do PO e do SM mostram o que eles verificaram nos documentos." owner="Gerada do backlog" chip={snap.specsReady === true ? { label: 'Gerado', tone: 'ok' } : failingChecks > 0 ? { label: `${failingChecks} ${failingChecks === 1 ? 'item falhou' : 'itens falharam'}`, tone: 'warn' } : { label: 'Pendente' }}>
            {verificationDetails}
          </StepCard>
        </>
      )}
    </div>
  );
  // The steps from the backlog to the start, and what the latest evaluation spent, so the owner sees the work move.
  const items = st.backlog?.items.length ?? 0;
  const backlogSteps = backlogProgress({
    items: speckitList,
    detailed: speckitList.filter((i) => st.backlog?.specs?.[i.key]?.spec).map((i) => i.key),
    steps: speckit?.steps ?? [],
    running: speckit?.running ?? [],
    repositories: st.repositories === true,
    checks: snap.closing?.checks ?? [],
    architectureRunning: st.architectureRunning === true,
    closed: snap.closing?.ok === true,
  });
  const progress = snap.evaluationProgress;
  // While an evaluation runs its numbers are read at its end, so the line says so instead of showing a stale count.
  const lastLine = evaluating ? 'Avaliação em andamento: o tempo e o custo dela aparecem quando terminar.' : progress ? `Última avaliação: ${Math.max(1, Math.round(progress.durationMs / 60_000))} min · ${money(progress.costUsd)} · ${progress.redone} ${progress.redone === 1 ? 'item refeito' : 'itens refeitos'}, ${Math.max(0, items - progress.redone)} ${items - progress.redone === 1 ? 'reaproveitado' : 'reaproveitados'}` : null;
  const backlogScreen = () => (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6" data-testid="backlog-stage">
      {backlogStageHeading}
      {backlogOn && startMissing.length > 0 && <StartMissingAlert items={startMissing} agentsDecide={p.agentsDecide} busy={preparing || serverBusy || evaluating} onResolve={p.onResolveAll ? resolveAll : undefined} />}
      {openOwner > 0 && needsCard(false)}
      {backlogOn && <BacklogProgress progress={backlogSteps} since={speckit?.startedAt ?? st.evaluation?.startedAt} waiting={snap.waiting ?? null} ready={snap.closing?.ok === true} last={lastLine} total={money(snap.tokens.costUsd)} repeated={progress?.repeated === true} />}
      {backlogCards()}
    </div>
  );
  // The development starts only once specs.md is written from the current backlog, with the reason beside the button.
  const specsGate = st.stages === true && backlogOn && snap.specsReady !== true;
  const specsReason = !specsGate ? null : st.status !== 'ready' ? 'Aguardando o backlog ficar pronto' : evaluating ? 'Gerando o specs.md' : 'Gere o specs.md do backlog';
  const developButton = (
    <ActionButton data-testid="start" className={speckitReady && canStart && !specsGate ? 'primary' : 'secondary'} busy={p.startState?.busy ?? false} disabled={!canStart || !speckitReady || specsGate} onClick={p.onStart} icon={<Icon name="play" size={16} />}>
      {p.startState?.busy ? p.startState.label : 'Iniciar desenvolvimento'}
    </ActionButton>
  );
  // What the start waits for, in plain words, while it cannot start: the one primary action is the next step.
  const startReason = canStart && speckitReady ? undefined
    : !speckitRunning && !st.backlog?.detail ? 'Detalhe o backlog antes de iniciar.'
    : speckitReason;
  const closingFailing = snap.closing?.checks.filter((check) => !check.ok) ?? [];
  const resolveClosing = p.onResolveClosing;
  // What the team can settle alone on the summary: stages outdated by an edit and suggestions that change no scope.
  const stagePending = [...Object.keys(st.staleBy ?? {}), ...st.patches.filter((x) => x.status === 'pending').map((x) => x.patchId)].sort().join(',');
  const canResolve = resolveClosing !== undefined && !locked && st.reviewClosed !== true && (stagePending !== '' || (closingFailing.length > 0 && st.backlog?.detail === true));
  const resolveBlock = canResolve ? (
    <div data-testid="final-resolve" className="grid gap-2 rounded-lg bg-surface-sunken px-3 py-2.5">
              <p className="m-0 text-[0.875rem] text-ink-soft">Há pendências que o time resolve sozinho: ele revisa o que mudou e aceita o que não muda o escopo. Só começa quando você clicar.</p>
              <ActionButton data-testid="final-resolve-run" className="secondary h-10 w-full" onClick={() => p.onResolveClosing?.()} icon={<Icon name="refresh" size={16} />}>Deixar o time resolver as pendências</ActionButton>
            </div>
  ) : null;
  // Everything the start still waits for, in plain words, in the order the owner can act on it; empty once the button is open.
  const blockingOpen = pending.filter((q) => q.blocking).length;
  const startMissing: string[] = [];
  if (backlogOn) {
    if (evaluating) startMissing.push('O time ainda está trabalhando: espere ele terminar.');
    if (blockingOpen > 0) startMissing.push(blockingOpen === 1 ? 'Responda a pergunta obrigatória em aberto.' : `Responda as ${blockingOpen} perguntas obrigatórias em aberto.`);
    if (!st.backlog?.detail) startMissing.push('Detalhe o backlog antes de iniciar.');
    else if (st.status !== 'ready' && !evaluating && blockingOpen === 0) {
      const lacks = st.checklist.filter((c) => !c.passed).map((c) => c.detail || c.id);
      // A reason that already ends in a period gets no second one.
      startMissing.push(`O backlog ainda não está pronto: ${(lacks.length > 0 ? lacks.join('; ') : 'avalie o backlog').replace(/\.$/, '')}.`);
    }
    if (speckitReason && !speckitAsked.some((q) => q.blocking)) startMissing.push(speckitReason);
    if (specsReason && st.status === 'ready') startMissing.push(`${specsReason}.`);
  }
  // The summary of everything that waits for the owner, shown in the backlog step: each document's open items, the questions and the repeats the guard dropped.
  // The backlog step shows no plans card, so its plan and specs.md questions wait for the owner here.
  // A plan question waits while the preparation runs, since the server refuses the answer then.
  const unfiled = st.extension === undefined ? [...unfiledQuestions(st), ...(speckitRunning ? [] : speckitAsked), ...specsAsked] : unfiledQuestions(st);
  const byDoc = DOC_STAGES.map((file) => ({ file, count: pendingCount(st, file) })).filter((x) => x.count > 0);
  const pendingTotal = byDoc.reduce((sum, x) => sum + x.count, 0);
  /** The suggestions the owner can take at once: the pending ones not already queued. */
  const acceptable = st.patches.filter((x) => x.status === 'pending' && !queuedOf(x.patchId)).length;
  const queuedIn = (file: DocFile) => (st.queued ?? []).filter((d) => st.patches.some((x) => x.patchId === d.id && x.file === file) || st.questions.some((q) => q.questionId === d.id && q.file === file)).length;
  const pendingSummary = (
    <div className="grid gap-3" data-testid="final-pending">
            {acceptable > 0 && p.onAcceptAll && <p data-testid="accept-all-note" className="m-0 max-w-[72ch] text-[0.8125rem] leading-normal text-ink-soft">Decida uma por uma, abaixo, ou aceite todas de uma vez: as sugestões entram nos documentos e o time segue, sem revisar de novo.</p>}
            {(byDoc.length > 0 || (acceptable > 0 && p.onAcceptAll)) && (
              <div className="flex flex-wrap items-center gap-2">
                {acceptable > 0 && p.onAcceptAll && (
                  <div className="contents" data-testid="accept-all-block">
                    <ActionButton data-testid="accept-all" className="primary h-10" disabled={answerLocked} onClick={() => void p.onAcceptAll?.()} icon={<Icon name="check" size={16} />}>
                      Aceitar todas ({acceptable})
                    </ActionButton>
                  </div>
                )}
                {byDoc.length > 0 && (
                  <button type="button" className="secondary group h-10 px-3.5" data-testid="pending-toggle" aria-expanded={pendingOpen} aria-controls="pending-docs" onClick={() => setPendingOpen(!pendingOpen)}>
                    {pendingOpen ? 'Ocultar pendências' : `Mostrar pendências (${pendingTotal})`}
                    <span className="inline-flex transition-transform duration-200 ease-out group-aria-expanded:-rotate-90 rotate-90 motion-reduce:transition-none" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>
                  </button>
                )}
              </div>
            )}
            {pendingOpen && byDoc.length > 0 && (
              <ul id="pending-docs" className="m-0 grid list-none divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-sunken p-0">
                {byDoc.map(({ file, count }) => (
                  <li key={file}>
                    <button type="button" className="group flex h-auto min-h-11 w-full min-w-0 items-center gap-3 rounded-none border-0 bg-transparent px-3.5 py-2 text-left text-ink transition-colors duration-150 hover:bg-accent-soft focus-visible:bg-accent-soft" data-testid={`pending-${file}`} onClick={() => goTo(file)}>
                      <span className="inline-flex text-accent-text" aria-hidden="true"><Icon name="file" size={16} /></span>
                      <span className="min-w-0 flex-1 truncate text-[0.875rem] font-semibold">{docLabel[file]}</span>
                      <span className="rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 text-[0.75rem] font-semibold tabular-nums text-warn">{count === 1 ? '1 pendência' : `${count} pendências`}{queuedIn(file) > 0 ? ` · ${queuedIn(file)} na fila` : ''}</span>
                      <span className="inline-flex text-ink-soft transition-transform duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-accent-text motion-reduce:transition-none" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(st.droppedQuestions ?? []).some((d) => d.file === undefined && (st.extension === undefined || d.origin !== 'speckit')) && <DroppedRepeats compact rows={(st.droppedQuestions ?? []).filter((d) => d.file === undefined && (st.extension === undefined || d.origin !== 'speckit'))} locked={runLocked} onReask={(id) => p.onReask?.(id)} />}
            {byDoc.length === 0 && unfiled.length === 0 && <p data-testid="refinement-final-no-pending" className={`m-0 ${muted}`}>Nenhuma pendência.</p>}
          </div>
  );
  const startLine = null;
  // What waits for the owner in the first card of the backlog step.
  const openOwner = unfiled.length + pendingTotal;
  // The one card the owner should look at now: what waits for them, else the first part still unfinished; the backlog step shows only its items.
  const focusCard = openOwner > 0 ? 'needs' : !st.backlog?.detail || st.extension === undefined ? 'backlog' : !speckitReady ? 'plans' : snap.specsReady !== true ? 'checks' : 'needs';
  // A documentation-repository session without its backlog: the notice names the repository, and the button creates the backlog.
  const docsRepoNoBacklog = snap.docsRepo === true && !backlogOn;
  const docsNoticeTarget = docsRepoNoBacklog ? snap.docsTarget : undefined;
  // The architecture step only names the style: its button is always enabled and checks the decision on the click.
  const architectureBusy = evaluating || (st.evaluation != null && st.evaluation.endedAt === null);
  const architectureBlock = (): string | null => (architectureBusy ? 'A arquitetura ainda está sendo decidida: espere ela terminar.'
    : st.architecture == null ? 'Decida a arquitetura antes de quebrar o backlog.'
    : null);
  const architectureAsked = architectureQuestions(st);
  const architectureScreen = () => (
    <div className="grid min-w-0 gap-4" data-testid="architecture-step">
      {docsNoticeTarget && (
        <div role="status" data-testid="architecture-docs-notice" className="flex gap-3 rounded-lg border border-accent-line bg-accent-soft p-[0.85rem] text-[0.8125rem] leading-[1.45] text-ink">
          <Icon name="file" size={16} />
          <div data-testid="refinement-architecture-notice-text" className="grid min-w-0 gap-1">
            <b data-testid="refinement-architecture-notice-title" className="text-[0.875rem] font-semibold">Documentos</b>
            <span data-testid="refinement-architecture-notice-body" className="break-words">{`Cria o repositório privado ${docsNoticeTarget.owner}/${docsNoticeTarget.name} e publica os documentos. Apagar o projeto aqui não apaga o repositório.`}</span>
          </div>
        </div>
      )}
      <header data-testid="refinement-architecture-heading" className="grid gap-1">
        <h2 data-testid="refinement-architecture-title" className="m-0 text-[1.25rem] font-semibold text-ink">Arquitetura</h2>
        <p data-testid="refinement-architecture-intro" className="m-0 text-[0.9375rem] leading-[1.55] text-ink-soft">Decida se o sistema é um monólito ou microsserviços, antes de quebrar o backlog por repositório.</p>
      </header>
      <ArchitectureCard architecture={st.architecture} error={st.architectureError} issues={st.architectureIssues} busy={architectureBusy} locked={st.status === 'started'} stale={snap.architectureStale === true} blocked={graphingNow ? graphReason : null} startedAt={st.evaluation && st.evaluation.endedAt === null ? st.evaluation.startedAt : null} onDecide={() => { setArchitectureNote(null); return p.onDecideArchitecture?.(); }} />
      {architectureAsked.length > 0 && (
        <section className="grid gap-3" aria-labelledby="architecture-questions-title" data-testid="architecture-questions">
          <h3 id="architecture-questions-title" className="m-0 text-[1rem] font-semibold">Perguntas da arquitetura</h3>
          <p className="m-0 text-[0.875rem] text-ink-soft" data-testid="architecture-questions-hint">Os cinco documentos não resolvem estes pontos. Ao responder a última, a arquitetura é decidida de novo com as respostas.</p>
          {architectureAsked.map((q, i) => <Fragment key={q.questionId}>{questionCard(q, architectureAsked.length - i)}</Fragment>)}
        </section>
      )}
    </div>
  );
  const wizardActions = step === 'backlog' ? (
    !backlogOn ? (
      <>
        {breakdownBlock && <p data-testid="wizard-action-reason" className="m-0 basis-full text-[0.8125rem] text-ink-soft @3xl:order-first @3xl:text-right">{breakdownBlock}</p>}
        <ActionButton data-testid="enable-backlog" className="primary" disabled={runLocked || breakdownBlock !== null} onClick={() => p.onEnableBacklog?.()} icon={<Icon name="play" size={16} />}>Quebrar o backlog</ActionButton>
      </>
    ) : <><ActionButton data-testid="prepare-backlog" className={startMissing.length > 0 ? 'primary' : 'secondary'} busy={preparing || serverBusy || evaluating} disabled={runLocked || preparing || evaluating || serverBusy || !p.onResolveAll} onClick={resolveAll} icon={<Icon name="check" size={16} />}>{preparing || serverBusy || evaluating ? 'Preparando…' : 'Preparar backlog'}</ActionButton>{developButton}</>
  ) : step === 'review' ? (
    <>
      {reviewBlock && <p data-testid="wizard-action-reason" className="m-0 basis-full text-[0.8125rem] text-ink-soft @3xl:order-first @3xl:text-right">{reviewBlock}</p>}
      {backlogOn || st.repositories === true ? (
        <>
        <ActionButton
          data-testid="open-backlog"
          className="primary"
          disabled={runLocked || reviewBlock !== null}
          onClick={async () => {
            if (stageSession && !st.reviewClosed) {
              const result = await p.onCloseReview?.();
              if (result === false) return;
            }
            // The next step of the list: the architecture in a repository session, the backlog otherwise.
            goTo(nextWizardStep('review', stepsOf(st)) ?? 'backlog');
          }}
          icon={<Icon name="arrow-right" size={16} />}
        >
          {st.repositories === true ? 'Continuar' : 'Abrir backlog e execução'}
        </ActionButton>
        </>
      ) : (
        <ActionButton data-testid="enable-backlog" className="primary" disabled={runLocked || reviewBlock !== null} onClick={() => p.onEnableBacklog?.()} icon={<Icon name="play" size={16} />}>Quebrar o backlog</ActionButton>
      )}
    </>
  ) : step === 'architecture' ? (
    <>
      {architectureNote && <p role="alert" data-testid="architecture-note" className="m-0 basis-full text-[0.8125rem] text-warn">{architectureNote}</p>}
      <ActionButton data-testid="architecture-continue" className="primary" disabled={locked} onClick={() => {
        if (backlogOn) return goTo('backlog');
        const block = architectureBlock();
        setArchitectureNote(block);
        if (block) return;
        if (!docsRepoNoBacklog) return goTo('backlog');
        // The button shows its spinner until the backlog is created; the page opens the backlog only when that succeeded.
        return Promise.resolve(p.onEnableBacklog?.()).then((ok) => { if (ok === true) goTo('backlog'); });
      }} icon={<Icon name="arrow-right" size={16} />}>
        Quebrar o backlog por repositório
      </ActionButton>
    </>
  ) : (
    <>
      <ActionButton data-testid="wizard-process" className="secondary" busy={evaluating} disabled={runLocked || atMax} title={limitTitle} onClick={async () => {
          // The agents review the text as it is now: a hand edit is saved first and kept.
          if (!(await saveTyped())) return;
          return stageSession ? p.onEvaluateStage?.(step) : p.onEvaluate();
        }} icon={<Icon name={processedBefore ? 'refresh' : 'check'} size={16} />}>
        {processedBefore ? 'Processar de novo' : 'Processar com agentes'}
      </ActionButton>
      {graphingNow && <p data-testid="wizard-graph-reason" className="m-0 basis-full text-[0.8125rem] text-ink-soft @3xl:order-first @3xl:text-right">{graphReason}</p>}
      {continueBlock && <p data-testid="wizard-continue-reason" className="m-0 basis-full text-[0.8125rem] text-ink-soft @3xl:order-first @3xl:text-right">{continueBlock}</p>}
      {!continueBlock && lowScore !== null && <p data-testid="wizard-low-score" className="m-0 basis-full text-[0.8125rem] text-warn @3xl:order-first">A nota do Jev está em {lowScore}%, abaixo de {percentOf(PASS_LINE)}%. Os agentes já tentaram melhorar o documento. Você decide se continua assim.</p>}
      <ActionButton
        data-testid="wizard-continue"
        className="primary"
        disabled={runLocked || continueBlock !== null}
        onClick={async () => {
          // A save the server refuses keeps the owner on the stage.
          if (!(await saveTyped())) return;
          // A document still outside the Graphify graph is added on Continuar, even when its stage is already done.
          const notGraphed = isDocStep(step) && !(st.graphed ?? []).includes(step);
          if (stageSession && (!doneStages.includes(step) || notGraphed)) {
            const result = await p.onContinueStage?.(step, lowScore !== null);
            // The document goes into Graphify in the background while the owner moves on.
            if (result === false) return;
          }
          goTo(nextWizardStep(step, stepsOf(st)));
        }}
        icon={<Icon name="arrow-right" size={16} />}
      >
        {lowScore !== null && !continueBlock ? 'Continuar mesmo assim' : 'Continuar'}
      </ActionButton>
    </>
  );
  // A follow-on request (design.md §31): its trail, its impact and its replan above the backlog's own cards, and the bar that starts it.
  if (st.extension) {
    const added = replanRows(st).filter((r) => r.state === 'nova').map((r) => r.key);
    const startOpen = canStart && speckitReady && !specsGate;
    // "Precisa de você" sits in front only once the team stopped with something left; while it works, or when a request has no
    // team record (an older one), only what blocks the start sits in front. The rest waits inside the details.
    const autopilot = st.autopilot;
    const teamStopped = autopilot?.status === 'stopped';
    const needsFirst = openOwner > 0 && (autopilot === undefined ? !startOpen : teamStopped);
    // Where the request stands, said plainly: the team working, something waiting for the owner, or ready to start.
    // The team stopped with nothing to decide but a reason (the Claude login expired, a quota): the owner sees it and can run the team again.
    const teamBlocked = teamStopped && openOwner === 0 && !startOpen && autopilot.reasons.length > 0;
    const requestStatus: RequestStatus = autopilot?.status === 'queued'
      ? { tone: 'working', title: 'Seu pedido está na fila', text: autopilot.reasons[0] || 'Há agentes trabalhando no pedido anterior. O refinamento começa sozinho quando eles terminarem.' }
      : evaluating || speckitRunning || autopilot?.status === 'running'
      ? { tone: 'working', title: 'O time está refinando seu pedido', text: 'Você não precisa fazer nada agora. O botão libera sozinho quando o time terminar.' }
      : teamBlocked
        ? { tone: 'needs', title: 'O time parou', text: autopilot.reasons.join(' ') }
      : openOwner > 0
        ? { tone: 'needs', title: startOpen ? `${openOwner} ${openOwner === 1 ? 'sugestão do time espera' : 'sugestões do time esperam'} você` : `${openOwner} ${openOwner === 1 ? 'decisão espera' : 'decisões esperam'} você`, text: teamStopped && autopilot.reasons.length > 0 ? `O time não conseguiu decidir sozinho: ${autopilot.reasons.join(' ')}` : startOpen ? 'São opcionais: inicie o desenvolvimento sem decidir agora, ou veja em "Detalhes do time".' : 'Resolva os itens abaixo para liberar o desenvolvimento.' }
        : startOpen
          ? { tone: 'ready', title: 'Tudo pronto para desenvolver', text: 'O time terminou o refinamento. Inicie quando quiser.' }
          : { tone: 'working', title: 'Falta pouco para iniciar', text: startReason ?? 'O time prepara o que falta.' };
    // An address with `?etapa=<document>` opens that document of the request; Voltar leads back to the request screen.
    if (isDocStep(step) && new URLSearchParams(window.location.search).has('etapa')) {
      return (
        <div className="min-h-0 min-w-0 lg:overflow-y-auto" data-testid="request-document">
          <WizardShell
            stepper={<Stepper steps={requestNodes(st)} ariaLabel="Etapas do pedido" onSelect={() => navigate(window.location.pathname)} />}
            stepKey={step}
            meta={usageLine}
            back={{ onClick: () => navigate(window.location.pathname), disabled: false }}
            actions={null}
          >
            <div className="grid gap-4">{stageScreen(step)}</div>
          </WizardShell>
          {askDialog}
        </div>
      );
    }
    return (
      <div className="min-h-0 min-w-0 lg:overflow-y-auto" data-testid="request-screen">
        <h1 className="sr-only">{requestHeading(st.extension.requestId)}</h1>
        <WizardShell
          stepper={<Stepper steps={requestNodes(st)} ariaLabel="Etapas do pedido" onSelect={(key) => { document.querySelector('[data-testid="request-details"]')?.setAttribute('open', ''); document.querySelector(`[data-testid="${REQUEST_STEP_TARGET[key]}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />}
          stepKey="request"
          meta={usageLine}
          back={{ onClick: () => navigate(projectPath(snap.projectId)), disabled: false }}
          actions={null}
        >
          <div className="grid gap-4">
          <ReadyBar status={requestStatus} checks={readyChecks(st, snap.specsReady === true, snap.trace)} trail={requestTrail(snap.trace)} action={teamBlocked ? <ActionButton data-testid="team-retry" className="primary" busy={serverBusy} disabled={locked || serverBusy || !p.onResolveAll} onClick={() => void p.onResolveAll?.()} icon={<Icon name="refresh" size={16} />}>Tentar de novo</ActionButton> : developButton} />
          {needsFirst && needsCard()}
          <RequestCard text={st.extension.text} heading={requestHeading(st.extension.requestId)} interpreted={st.impact?.impact != null} concluded={st.status === 'ready'} understood={st.impact?.impact != null ? understoodCounts(st, added) : null} />
          <details data-testid="request-details" className="group min-w-0">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[0.9375rem] font-semibold text-ink [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="text-ink-soft transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
              Detalhes do time
              <span className="text-[0.8125rem] font-normal text-ink-soft">impacto, replanejamento, backlog, planos e verificação</span>
            </summary>
            <div className="mt-3 grid gap-4">
              <ImpactCard impact={st.impact?.impact ?? null} issues={st.impact?.issues ?? []} addedKeys={added} accepted={acceptedAdditions(st.patches)} />
              <ReplanCard rows={replanRows(st)} />
              {backlogStageHeading}
              {!needsFirst && needsCard()}
              {backlogCards(true)}
            </div>
          </details>
          </div>
        </WizardShell>
        {reevaluateDialog}
        {askDialog}
        {busyDialog && <BusyDialog onClose={() => setBusyDialog(false)} />}
      </div>
    );
  }
  if (newProject) {
    return (
      <div className="min-h-0 min-w-0 lg:overflow-y-auto" data-testid="stage-wizard">
        <WizardShell
          stepper={<Stepper steps={wizardNodes(st, step)} ariaLabel="Etapas dos documentos" canSelect={(key) => stepOpen(st, key as WizardStep)} onSelect={(key) => { if (stepOpen(st, key as WizardStep)) goTo(key as WizardStep); }} />}
          stepKey={step}
          meta={usageLine}
          back={{ onClick: () => goTo(prevStep(step, stepsOf(st))), disabled: prevStep(step, stepsOf(st)) === null, reason: 'Esta é a primeira etapa' }}
          actions={wizardActions}
        >
          <div className="grid gap-4">
            {snap.docsRepo === true && <DocsSyncNotice docsSync={snap.docsSync} />}
            {step === 'backlog' ? backlogScreen() : step === 'review' ? finalScreen() : step === 'architecture' ? architectureScreen() : stageScreen(step)}
          </div>
        </WizardShell>
        {reevaluateDialog}
        {askDialog}
        {busyDialog && <BusyDialog onClose={() => setBusyDialog(false)} />}
      </div>
    );
  }
  return (
    <>
      {snap.docsRepo === true && <DocsSyncNotice docsSync={snap.docsSync} />}
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
    </>
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
  const [busyNotice, setBusyNotice] = useState(false);
  const [busyDialog, setBusyDialog] = useState(false);
  const [starting, setStarting] = useState(false);
  const [closingOpen, setClosingOpen] = useState(false);
  const applied = useRef(0);
  // The stream starts after the snapshot the page read first, so opening or reloading the page does not replay the whole journal.
  const [streamFrom, setStreamFrom] = useState<number | null>(null);
  const { events, reopened } = useJournal(snap && streamFrom !== null ? `${refineApi.events(projectId, specId)}?after=${streamFrom}` : null);
  // One snapshot read at a time: a request made during a read is answered by one more read after it, so a burst costs two reads.
  const reading = useRef<Promise<void> | null>(null);
  const rereadQueued = useRef(false);
  // Each write the server answered counts here: a read that started before one is older than it, so the page reads again.
  const writes = useRef(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [agentsDecide, setAgentsDecide] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    settingsApi.agentsDecide(projectId).then((r) => setAgentsDecide(r.agentsDecide), () => undefined);
  }, [projectId]);
  const load = (): void => {
    if (reading.current) {
      rereadQueued.current = true;
      return;
    }
    const started = writes.current;
    reading.current = refineApi
      .snapshot(projectId, specId)
      .then((s) => {
        if (started !== writes.current) {
          rereadQueued.current = true;
          return;
        }
        // The snapshot already holds every event up to its seq: the replay applies only the ones after it.
        applied.current = s.seq ?? 0;
        setStreamFrom((from) => from ?? s.seq ?? 0);
        setSnap({ ...s, docsDirty: false });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        reading.current = null;
        if (rereadQueued.current) {
          rereadQueued.current = false;
          load();
        }
      });
  };
  useEffect(() => {
    load();
  }, [projectId, specId]);
  // A stream that was reopened may have missed document changes, so the snapshot is read again.
  const lastReopen = useRef(0);
  useEffect(() => {
    if (reopened === lastReopen.current) return;
    lastReopen.current = reopened;
    load();
  }, [reopened]);
  // The stream is the way the page follows the work. As a safety net the page also reads the snapshot on its own while its tab is visible: every few seconds while work is open, and every fifteen otherwise.
  const working = snap ? snap.state.status === 'evaluating' || evaluationOpen(snap.state) || Boolean(snap.state.graphing) || snap.busy === true : false;
  const loaded = snap !== null;
  useEffect(() => {
    if (!loaded) return;
    return visibleInterval(load, working ? 5_000 : 15_000);
  }, [working, loaded]);
  useEffect(() => {
    const onShow = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);
  // The program ledger moves with the runs, not with the refinement journal: poll it while a started backlog is on screen.
  const following = snap?.state.status === 'started' && snap.state.backlog?.enabled === true;
  const { program, phases } = useProgram(projectId, specId, following);
  useEffect(() => {
    if (!snap) return;
    const fresh = events.filter((e) => e.seq > applied.current);
    if (fresh.length === 0) return;
    applied.current = fresh[fresh.length - 1].seq;
    const next = applyBatch(snap, fresh);
    // A started execution moves on to the project, which follows it.
    if (fresh.some((e) => e.type === 'REFINE_STARTED_RUN')) navigate(afterStartPath(projectId), { replace: true });
    // The status moves at once; a document the server changed is read again on top of it.
    setSnap(next);
    if (next.docsDirty) load();
  }, [events, snap]);
  const now = useMemo(() => stageNow(events, snap?.state.cycle ?? 0), [events, snap?.state.cycle]);
  // A stage review names its document and reads its steps from the server, so a reloaded page shows them too.
  const reviewing = snap?.reviewing ?? null;
  const stageLine = reviewing ? stageLineOf(snap?.stageSignals ?? { reviewed: false, scored: false, jevDown: false }, snap?.state.graphing === reviewing, reviewing, snap?.running ?? [], snap?.state.confidential === false) : null;
  if (!snap) return (
    <main data-testid="refinement-loading">
      {error ? <p data-testid="refinement-loading-error" className="error">{error}</p> : <Loading />}
    </main>
  );
  // A refused click during a process is explained in a dialog right where the owner is, not by a jump to the top of the page.
  const refused = (e: Error) => {
    if (isBusyError(e)) {
      setBusyNotice(true);
      setBusyDialog(true);
    } else {
      setError(e.message);
      window.scrollTo?.({ top: 0, behavior: 'smooth' });
    }
  };
  // A failed action writes its reason at the top of the page: the page goes there, so the owner sees it from any step.
  // Resolves to whether the action succeeded, so a caller moves on only after it. The page reads the snapshot again after the action, win or lose.
  const act = (f: () => Promise<unknown>) => () => {
    setError(null);
    setBusyNotice(false);
    return f().then(() => {
      writes.current += 1;
      load();
      return true;
    }, (e: Error) => {
      refused(e);
      load();
      return false;
    });
  };
  // A save the server answers counts as a write. A refused save keeps the owner's text in the editor; the page reads the snapshot again either way.
  // A save refused while the server organizes the document rejects instead: the editor sends it again, with no message.
  const saveDoc = (file: DocFile, text: string, baseHash?: string, keepalive?: boolean): Promise<string | null> => (keepalive
    ? refineApi.saveDoc(projectId, specId, file, text, baseHash, true)
    : refineApi.saveDoc(projectId, specId, file, text, baseHash))
    .then((r) => {
      writes.current += 1;
      setSaveError(null);
      return r.hash;
    }, (e: Error) => {
      if (isOrganizingError(e)) throw e;
      setSaveError(e.message);
      return null;
    })
    .finally(load);
  // The document as the server holds it now: a save refused for the layout is sent again over its hash.
  const readDoc = (file: DocFile) => refineApi.snapshot(projectId, specId).then((s) => ({ text: s.docs[file], hash: s.hashes?.[file] }), (e: Error) => (setSaveError(e.message), null));
  // A repository session starts on the summary the owner read: its hash goes with the start, and the server refuses a stale one.
  const startWith = (summaryHash?: string) => act(() => {
    setStarting(true);
    return refineApi.start(projectId, specId, summaryHash).then(() => navigate(afterStartPath(projectId), { replace: true })).finally(() => setStarting(false));
  });
  const startRun = startWith();
  const repositorySession = snap.state.repositories === true;
  const openSummary = () => setClosingOpen(true);
  const executing = starting || (following && program?.status !== 'finished');
  const startLabel = { label: starting ? 'Iniciando…' : executing ? 'Em execução' : 'Iniciar análise', busy: executing };
  // The banner offers the start once the score is ready, so the review panel does not repeat it.
  const bannerStarts = scoresDocs(snap.state.mode ?? null) && snap.state.mode !== 'new-project' && !['evaluating', 'started'].includes(snap.state.status) && jevVerdict(snap.state.readiness) === 'scored';
  return (
    <main data-testid="refinement-main" className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <Breadcrumb testId="refinement-breadcrumb" trail={[{ label: projectId, to: projectPath(projectId), testId: 'refinement-breadcrumb-project' }, { label: snap?.state.extension ? snap.state.extension.requestId : `${specId} ${snap?.state.mode === 'new-spec' ? 'spec nova' : 'rascunho'}`, testId: 'refinement-breadcrumb-spec' }]} />
      <MoveNotice moves={snap.state.moves ?? []} onUndo={(moveId) => act(() => refineApi.undoMove(projectId, specId, moveId))()} onClose={(moveId) => act(() => refineApi.closeNotice(projectId, specId, moveId))()} docName={docName} />
      {closingOpen && snap.closing && (
        <ClosingDialog projectId={projectId} specId={specId} summary={snap.closing} busy={starting} onCancel={() => setClosingOpen(false)} onAuthorize={(hash) => { setClosingOpen(false); void startWith(hash)(); }} />
      )}
      <ReshapeNotice reshapes={snap.state.reshapes ?? []} docName={docName} />
      {scoresDocs(snap.state.mode ?? null) && snap.state.mode !== 'new-project' && !snap.state.extension && !['evaluating', 'started'].includes(snap.state.status) && (
        <ReadinessBanner readiness={snap.state.readiness} canStart={canStartRun(snap.state, false)} startState={startLabel} onScore={act(() => refineApi.score(projectId, specId))} onStart={repositorySession ? openSummary : startRun} />
      )}
      {(snap.state.status === 'evaluating' || evaluationOpen(snap.state)) && <ProcessingBanner backlog={snap.state.backlog} cycle={snap.state.cycle} stage={stageLine?.line ?? (snap.state.stages === true ? 'Preparando a revisão da etapa.' : now.stage)} jevDown={stageLine?.jevDown ?? now.jevDown} running={snap.running ?? now.running} since={snap.state.evaluation?.startedAt} title={snap.state.mode === 'new-project' ? stageTitle(snap.state, reviewing) : undefined} file={reviewing} info={reviewing ? stageInfo(reviewing, snap.state.confidential === false, reviewing === 'flow.md') : undefined} waiting={snap.waiting ?? null} cost={reviewing ? snap.stageCost?.[reviewing] ?? null : null} onStop={act(() => refineApi.stop(projectId, specId))} />}
      {snap.busy === true && !(snap.state.status === 'evaluating' || evaluationOpen(snap.state)) && !snap.state.graphing && (
        <ProcessBox title="O time está trabalhando" tone="good" testId="busy-process">
          <span className="text-[0.75rem] leading-[1.35]">Tem um processo em aberto. Os botões de aceitar e rejeitar ficam bloqueados até ele terminar, e liberam sozinhos.</span>
        </ProcessBox>
      )}
      {busyNotice && (snap.state.status === 'evaluating' || evaluationOpen(snap.state)) && (
        <ProcessBox title="Processando" since={snap.state.evaluation?.startedAt ?? null} tone="good" testId="busy-notice">
          <span data-testid="refinement-busy-notice-text" className="text-[0.75rem] leading-[1.35]">Já existe uma avaliação em andamento. Aguarde o fim dela para avaliar de novo.</span>
        </ProcessBox>
      )}
      {busyDialog && <BusyDialog onClose={() => setBusyDialog(false)} />}
      {snap.state.graphing && (
        <ProcessBox title={`Adicionando ${snap.state.graphing} ao Graphify`} since={snap.state.graphingSince ?? null} tone="accent" testId="graphing-box">
          <span className="text-[0.75rem] leading-[1.35]">Você pode seguir: responder, rejeitar e editar continuam disponíveis.</span>
        </ProcessBox>
      )}
      {following && <ProgramStatus program={program} titles={Object.fromEntries(snap.state.backlog!.items.map((i) => [i.key, i.title]))} phases={phases} link={executionPath(projectId)} />}
      {(error || snap.state.status === 'error') && (
        <div data-testid="refinement-error" className="error mx-auto w-[min(100%,48rem)] text-center" role="alert">
          <p data-testid="refinement-error-text">{errorText(error ?? snap.state.error)}</p>
          {(error ?? snap.state.error)?.startsWith('Jev indisponível') && <JevActions />}
        </div>
      )}
      <RefinementView
        snap={snap}
        busy={snap.state.status === 'evaluating' || evaluationOpen(snap.state)}
        onSaveDoc={saveDoc}
        onReadDoc={readDoc}
        saveError={saveError}
        onSuggestDoc={(f) => {
          setError(null);
          return refineApi.suggestDoc(projectId, specId, f).then((r) => r.text, (e: Error) => (refused(e), null));
        }}
        onDesignFromImages={(images) => {
          setError(null);
          return refineApi.suggestDesignFromImages(projectId, specId, images).then((r) => r.text, (e: Error) => (refused(e), null));
        }}
        onEvaluate={act(() => refineApi.evaluate(projectId, specId))}
        onResolveAll={act(() => refineApi.autopilot(projectId, specId))}
        agentsDecide={agentsDecide}
        onAcceptAll={act(() => refineApi.acceptAll(projectId, specId))}
        onApplyStage={(f) => act(() => refineApi.applyStage(projectId, specId, f))()}
        onProceedStage={(f) => act(() => refineApi.proceedStage(projectId, specId, f))()}
        onEnableBacklog={act(() => refineApi.enableBacklog(projectId, specId))}
        onPreparePlans={act(() => refineApi.plans(projectId, specId))}
        onResolveClosing={act(() => refineApi.resolve(projectId, specId))}
        onDecideArchitecture={act(() => refineApi.decideArchitecture(projectId, specId))}
        onContinueStage={(doc, confirmLowScore) => act(() => refineApi.continueStage(projectId, specId, doc, confirmLowScore))()}
        onAddToGraph={(doc) => act(() => refineApi.addToGraph(projectId, specId, doc))()}
        onNotApplicable={act(() => refineApi.notApplicable(projectId, specId))}
        onCloseReview={act(() => refineApi.closeReview(projectId, specId))}
        onScoreDoc={(f) => act(() => refineApi.scoreDoc(projectId, specId, f))()}
        onScoreAll={act(() => refineApi.score(projectId, specId))}
        onEvaluateStage={(f) => act(() => refineApi.evaluateStage(projectId, specId, f))()}
        onConfidential={(v) => act(() => refineApi.confidential(projectId, specId, v))()}
        onAnswer={(id, t, d) => act(() => refineApi.answer(projectId, specId, id, t, d))()}
        onSkip={(id) => act(() => refineApi.skip(projectId, specId, id))()}
        onReask={(id) => act(() => refineApi.reask(projectId, specId, id))()}
        onAccept={(id) => act(() => refineApi.accept(projectId, specId, id))()}
        onReject={(id, r) => act(() => refineApi.reject(projectId, specId, id, r))()}
        onUnqueue={(id) => act(() => refineApi.unqueue(projectId, specId, id))()}
        onSecret={(n, v) => act(() => refineApi.secret(projectId, specId, n, v))()}
        onStart={repositorySession ? openSummary : startRun}
        startState={startLabel}
        hideStart={bannerStarts}
        events={events}
      />
    </main>
  );
}
