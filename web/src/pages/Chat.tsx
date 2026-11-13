import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { refinePath } from '../routes.js';
import { NewSpecDialog } from '../components/NewSpecDialog.js';
import { Link } from 'react-router-dom';
import { chatApi, runApi, type ChatCorrection, type ChatMessage, type ChatUsage, type ProjectRow } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Bone, Loading, Skeleton } from '../components/Loading.js';
import { Markdown } from '../components/Markdown.js';
import { Select } from '../components/Select.js';
import { emptyState, grouped } from './project-shared.js';
import { money } from './costs/format.js';

const price = money;

const HELP = 'Aqui você tira dúvidas sobre o projeto. O chat lê os registros das execuções: o que bloqueia uma spec, por quê, quem precisa agir e o próximo passo. Para explicar um erro registrado, ele pode pesquisar na internet uma vez por pergunta, exceto em projetos confidenciais. Ele não dá ordens aos agentes: eles seguem apenas as specs e o backlog. Se achar algo sendo feito que contraria a spec, abre uma spec de correção para você revisar.';
const EXAMPLES = ['Como crio uma nova spec?', 'O que está sendo desenvolvido agora?', 'Quais tarefas estão bloqueadas e por quê?', 'Algo está sendo feito fora do que foi pedido?'];

// Same panel, heading and callout shapes as the refinement screen.
const panelCard = 'edge-lit grid min-w-0 gap-4 rounded-xl border border-line bg-surface p-5 shadow-card';
const headingTile = 'grid size-12 flex-[0_0_3rem] place-items-center rounded-tile text-[color:var(--tile-accent-ink)] shadow-tile [background:var(--tile-accent)]';
const eyebrow = 'text-[0.8125rem] font-semibold text-ink-soft';
const panelTitle = 'm-0 mt-[0.15rem] text-[1.0625rem] tracking-[-0.01em] text-ink';
const fieldLabel = 'text-[0.8125rem] font-semibold text-ink-soft';
interface Problem {
  title: string;
  message: string;
  /** A connection or internal failure, shown in the red tone. */
  unexpected?: boolean;
  /** Offered when sending the same question again can work. */
  retry?: () => unknown;
}

const OFFLINE = /failed to fetch|networkerror|load failed|network request failed/i;
const TECHNICAL = /^(internal error|HTTP \d+|text must be|projectId must be)/i;

/** The server speaks Portuguese for what the person can act on; anything technical becomes a plain sentence. */
export function plainError(message: string): string {
  if (OFFLINE.test(message)) return 'Não consegui falar com o Teams AI. Veja se ele continua rodando e tente de novo.';
  if (TECHNICAL.test(message)) return 'Algo deu errado do nosso lado e a resposta não saiu. Tente de novo em instantes.';
  return message;
}

/** A connection or internal failure: the only errors the chat shows in red. */
export function isUnexpected(message: string): boolean {
  return OFFLINE.test(message) || TECHNICAL.test(message);
}

const bubble = 'max-w-[48rem] rounded-lg px-4 py-2.5 text-[0.9375rem] leading-[1.5] wrap-anywhere';
const notice = 'm-0 max-w-[48rem] rounded-md bg-warn-soft px-3 py-[0.65rem] text-[0.8125rem] text-warn';

const USAGE_HELP = 'Lidos: tudo que o Claude leu para responder (contexto do projeto, conversa e guia). Escritos: o que ele escreveu. O custo é uma estimativa nos preços da API; na assinatura ele conta como uso do seu limite.';

/** What one answer cost, as one meta line (design.md §11.12). */
export function usageLine(u: ChatUsage): string {
  const read = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return [u.costUsd === null ? null : `Custo estimado ${price(u.costUsd)}`, `${grouped(read)} tokens lidos`, `${grouped(u.outputTokens)} escritos`, u.searches === undefined ? null : `${u.searches} ${u.searches === 1 ? 'busca' : 'buscas'} na web`, u.graphQueries === undefined ? null : `${u.graphQueries} ${u.graphQueries === 1 ? 'consulta' : 'consultas'} ao grafo`, u.seconds < 1 ? 'menos de 1 s' : `${u.seconds} s`].filter(Boolean).join(' · ');
}

function Correction({ projectId, correction }: { projectId: string; correction: ChatCorrection }) {
  return (
    <p data-testid="chat-correction" className={notice}>
      {correction.specId ? (
        <>Abri uma spec de correção, “{correction.title}”. <Link to={refinePath(projectId, correction.specId)}>Abrir para revisar e iniciar</Link>.</>
      ) : (
        <>Não consegui abrir a spec de correção “{correction.title}”: {correction.error}</>
      )}
    </p>
  );
}

// Typing in the draft re-renders the page; memo keeps the answers from rendering again.
const Message = memo(function Message({ projectId, message }: { projectId: string; message: ChatMessage }) {
  if (message.role === 'user') return <p data-testid="chat-message-user" className={`${bubble} m-0 justify-self-end bg-accent-soft text-ink`}>{message.text}</p>;
  return (
    <div data-testid="chat-message" className="grid justify-items-start gap-2">
      <div data-testid="chat-message-answer" className={`${bubble} border border-line bg-surface text-ink text-justify`}><Markdown source={message.text} /></div>
      {message.usage ? <p className="m-0 flex items-center gap-1 text-[0.75rem] text-ink-soft tabular-nums" data-testid="usage">{usageLine(message.usage)}<InfoTip text={USAGE_HELP} /></p> : null}
      {message.correction ? <Correction projectId={projectId} correction={message.correction} /> : null}
    </div>
  );
});

export function ChatPage() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** Browsing the earlier questions with the arrow keys: where it is, and the text that was being typed. */
  const [recall, setRecall] = useState<{ index: number; draft: string } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [newSpec, setNewSpec] = useState(false);
  const current = useRef('');
  current.current = projectId;

  useEffect(() => {
    runApi.projects().then((p) => { setProjects(p); setProjectId(p[0]?.projectId ?? ''); }).catch((e: Error) => { setProjects([]); setProblem({ title: 'Não consegui carregar os projetos', message: plainError(e.message), unexpected: isUnexpected(e.message) }); });
  }, []);
  useEffect(() => {
    if (!projectId) return;
    let stale = false;
    setMessages(null);
    setProblem(null);
    chatApi.messages(projectId).then((r) => !stale && setMessages(r.messages)).catch((e: Error) => { if (!stale) { setMessages([]); setProblem({ title: 'Não consegui carregar a conversa', message: plainError(e.message), unexpected: isUnexpected(e.message) }); } });
    return () => { stale = true; };
  }, [projectId]);
  useEffect(() => {
    document.getElementById('chat-end')?.scrollIntoView?.({ block: 'end' });
  }, [messages, asking]);

  const send = async (question = draft.trim()) => {
    if (!question || asking) return;
    const asked = projectId;
    setProblem(null);
    setAsking(question);
    // The box is free for the next question at once; it is emptied only while it still holds this question.
    setDraft((d) => (d.trim() === question ? '' : d));
    setRecall(null);
    try {
      const { message } = await chatApi.ask(asked, question);
      // A question cleared while it was coming has no answer, and nothing to show.
      if (!message || current.current !== asked) return;
      setMessages((m) => [...(m ?? []), { role: 'user', text: question, at: message.at }, message]);
    } catch (e) {
      if (current.current === asked) {
        // The question goes back to the box unless the person has already started the next one.
        setDraft((d) => (d.trim() === '' ? question : d));
        setProblem({ title: 'Não consegui responder', message: plainError((e as Error).message), unexpected: isUnexpected((e as Error).message), retry: () => send(question) });
      }
    } finally {
      setAsking(null);
    }
  };
  // The questions of the chosen project, newest first, each text once; rebuilt only when the messages change.
  const questions = useMemo(() => [...new Set((messages ?? []).filter((m) => m.role === 'user').map((m) => m.text).reverse())], [messages]);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
    // Up recalls only from an empty box or the start of the text, so arrows still move the caret inside a text being edited.
    const atStart = e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0;
    if (e.key === 'ArrowUp' && questions.length > 0 && (recall !== null || draft === '' || atStart)) {
      e.preventDefault();
      const index = recall === null ? 0 : Math.min(recall.index + 1, questions.length - 1);
      setRecall({ index, draft: recall?.draft ?? draft });
      setDraft(questions[index]!);
    }
    if (e.key === 'ArrowDown' && recall !== null) {
      e.preventDefault();
      if (recall.index === 0) {
        setDraft(recall.draft);
        setRecall(null);
      } else {
        setRecall({ ...recall, index: recall.index - 1 });
        setDraft(questions[recall.index - 1]!);
      }
    }
  };
  const clear = async () => {
    try {
      await chatApi.clear(projectId);
      setMessages([]);
    } catch (e) {
      setProblem({ title: 'Não consegui limpar a conversa', message: plainError((e as Error).message), unexpected: isUnexpected((e as Error).message) });
    }
    setConfirmClear(false);
  };

  if (projects === null) return <main data-testid="chat-page-loading"><Loading /></main>;
  const project = projects.find((p) => p.projectId === projectId);
  return (
    <main data-testid="chat-page">
      <nav data-testid="chat-breadcrumb" className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/" aria-label="Início">
          <Icon name="home" size={16} />
          <span data-testid="chat-breadcrumb-home-label">Início</span>
        </Link>
        <span data-testid="chat-breadcrumb-separator" aria-hidden="true">›</span>
        <strong data-testid="chat-breadcrumb-current">Chat de dúvidas</strong>
      </nav>
      <header data-testid="chat-header" className="min-w-0">
        <h1 data-testid="chat-title" className="m-0 text-ink">Chat de dúvidas</h1>
        <p data-testid="chat-subtitle" className="mt-1 mb-0 text-[0.9375rem] text-ink-soft">Pergunte em palavras simples o que está sendo feito em cada projeto.</p>
      </header>
      {projects.length === 0 ? (
        <div data-testid="chat-empty-projects" className={emptyState}>
          <Icon name="folder" size={24} />
          <p data-testid="chat-empty-projects-text">Nenhum projeto para perguntar ainda.</p>
          <p data-testid="chat-empty-projects-hint">Crie ou importe um projeto em Projetos e volte aqui.</p>
        </div>
      ) : (
        <section data-testid="chat-panel" className={panelCard} aria-label="Conversa">
          <div data-testid="chat-panel-toolbar" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div data-testid="chat-panel-project" className="flex min-w-0 items-center gap-3">
              <span data-testid="chat-panel-icon" className={headingTile}><Icon name="chat" size={26} /></span>
              <div data-testid="chat-panel-title-block" className="min-w-0">
                <span data-testid="chat-panel-eyebrow" className={eyebrow}>Dúvidas sobre o projeto <InfoTip text={HELP} /></span>
                <h2 data-testid="chat-panel-project-name" className={`${panelTitle} wrap-anywhere`}>{project?.name ?? projectId}</h2>
              </div>
            </div>
            <div data-testid="chat-panel-actions" className="flex flex-wrap items-center gap-2 max-md:w-full">
              <Select wrapperClassName="min-w-[14rem] max-md:flex-1" aria-label="Projeto" value={projectId} disabled={asking !== null} onChange={(e) => { setProjectId(e.target.value); setRecall(null); }}>
                {projects.map((p) => <option data-testid={`chat-project-option-${p.projectId}`} key={p.projectId} value={p.projectId}>{p.name}</option>)}
              </Select>
              <button data-testid="chat-new-spec" type="button" className="secondary" disabled={!projectId} onClick={() => setNewSpec(true)}>
                Nova spec
                <Icon name="plus" size={16} />
              </button>
              <button data-testid="chat-clear-conversation" type="button" className="secondary" disabled={asking === null && !messages?.length} onClick={() => setConfirmClear(true)}>
                Limpar conversa
                <Icon name="trash" size={16} />
              </button>
            </div>
          </div>
          <div data-testid="chat-messages" className="grid max-h-[min(32rem,calc(100dvh-30rem))] min-h-48 content-start gap-3 overflow-y-auto rounded-lg border border-line bg-surface-sunken p-4" aria-live="polite" aria-busy={messages === null || asking !== null}>
            {messages === null ? (
              <Skeleton>
                <Bone size="half" />
                <Bone />
                <Bone size="short" />
              </Skeleton>
            ) : null}
            {messages?.length === 0 && !asking ? (
              <div data-testid="chat-empty" className={`${emptyState} border-0 bg-transparent`}>
                <Icon name="chat" size={24} />
                <p data-testid="chat-empty-text">Nenhuma pergunta feita ainda.</p>
                <p data-testid="chat-empty-hint">Escreva abaixo ou comece por um destes exemplos.</p>
                {EXAMPLES.map((q) => <button data-testid="chat-example" key={q} type="button" className="secondary" onClick={() => setDraft(q)}>{q}</button>)}
              </div>
            ) : null}
            {messages?.map((m, i) => <Message key={`${m.at}-${i}`} projectId={projectId} message={m} />)}
            {asking ? (
              <>
                <p data-testid="chat-pending-question" className={`${bubble} m-0 justify-self-end bg-accent-soft text-ink`}>{asking}</p>
                <p data-testid="chat-pending-status" className={`${bubble} m-0 text-ink-soft`}>Respondendo… pode levar alguns instantes.</p>
              </>
            ) : null}
            <span data-testid="chat-scroll-anchor" id="chat-end" />
          </div>
          <div data-testid="chat-composer" className="grid gap-1.5">
            <label data-testid="chat-question-label" htmlFor="chat-question" className={fieldLabel}>Sua pergunta</label>
            <div data-testid="chat-composer-row" className="flex items-end gap-3 max-md:flex-wrap">
              <textarea
                id="chat-question"
                className="min-h-[var(--control-height)] w-full min-w-0 flex-1 resize-y px-4 py-3 text-[0.9375rem] leading-[1.5]"
                data-testid="chat-input"
                rows={2}
                maxLength={2000}
                placeholder="Ex.: o que está sendo desenvolvido agora?"
                value={draft}
                disabled={messages === null}
                onChange={(e) => { setDraft(e.target.value); setRecall(null); }}
                onKeyDown={onKeyDown}
              />
              <ActionButton className="primary-button max-md:w-full" busy={asking !== null} disabled={draft.trim() === ''} onClick={() => send()} icon={<Icon name="send" size={16} />}>
                Enviar
              </ActionButton>
            </div>
          </div>
          <p data-testid="chat-hint" className="m-0 flex items-center gap-1.5 border-t border-line pt-4 text-[0.8125rem] text-ink-soft">
            <Icon name="info" size={16} />
            As conversas ficam salvas neste computador. Enter envia a pergunta, Shift+Enter quebra a linha e a seta para cima traz as perguntas anteriores.
          </p>
        </section>
      )}
      {problem ? (
        <Dialog title={problem.title} onClose={() => setProblem(null)}>
          <p data-testid="chat-problem-message" className={`m-0 text-[0.9375rem] ${problem.unexpected ? 'text-bad' : 'text-ink'}`}>{problem.message}</p>
          {problem.retry ? <p data-testid="chat-problem-retry-note" className="mt-2 mb-0 text-[0.8125rem] text-ink-soft">Sua pergunta não foi respondida. Tentar de novo envia ela outra vez.</p> : null}
          {problem.retry ? (
            <div data-testid="chat-problem-actions" className="mt-4 flex justify-end">
              <ActionButton className="primary-button" onClick={() => { const again = problem.retry; setProblem(null); return again?.(); }} icon={<Icon name="refresh" size={16} />}>Tentar de novo</ActionButton>
            </div>
          ) : null}
        </Dialog>
      ) : null}
      {newSpec ? <NewSpecDialog projectId={projectId} onClose={() => setNewSpec(false)} /> : null}
      {confirmClear ? (
        <ConfirmDialog title="Limpar conversa" subject={project?.name} confirmLabel="Limpar" onConfirm={clear} onCancel={() => setConfirmClear(false)}>
          <p data-testid="chat-clear-note">As mensagens deste projeto serão apagadas. As specs de correção que o chat já abriu continuam existindo.{asking !== null ? " A resposta que está sendo preparada será cancelada." : ""}</p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}
