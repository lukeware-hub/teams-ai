import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { chatApi, runApi, type ChatCorrection, type ChatMessage, type ProjectRow } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Bone, Loading, Skeleton } from '../components/Loading.js';
import { Markdown } from '../components/Markdown.js';
import { Select } from '../components/Select.js';
import { emptyState } from './project-shared.js';

const HELP = 'Aqui você só tira dúvidas. O chat não dá ordens aos agentes: eles seguem apenas as specs e o backlog. Se o chat achar algo sendo feito que não deveria, ele abre uma spec de correção para você revisar.';
const EXAMPLES = ['O que está sendo desenvolvido agora?', 'Quais tarefas estão bloqueadas e por quê?', 'Algo está sendo feito fora do que foi pedido?'];

// Same panel, heading and callout shapes as the refinement screen.
const panelCard = 'edge-lit grid min-w-0 gap-4 rounded-xl border border-line bg-surface p-5 shadow-card';
const headingTile = 'grid size-12 flex-[0_0_3rem] place-items-center rounded-tile text-[color:var(--tile-accent-ink)] shadow-tile [background:var(--tile-accent)]';
const eyebrow = 'text-[0.8125rem] font-semibold text-ink-soft';
const panelTitle = 'm-0 mt-[0.15rem] text-[1.0625rem] tracking-[-0.01em] text-ink';
const fieldLabel = 'text-[0.8125rem] font-semibold text-ink-soft';
interface Problem {
  title: string;
  message: string;
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

const bubble = 'max-w-[48rem] rounded-lg px-4 py-2.5 text-[0.9375rem] leading-[1.5] wrap-anywhere';
const notice = 'm-0 max-w-[48rem] rounded-md bg-warn-soft px-3 py-[0.65rem] text-[0.8125rem] text-warn';

function Correction({ projectId, correction }: { projectId: string; correction: ChatCorrection }) {
  return (
    <p className={notice}>
      {correction.specId ? (
        <>Abri uma spec de correção, “{correction.title}”. <Link to={`/refine/${projectId}/${correction.specId}`}>Abrir para revisar e iniciar</Link>.</>
      ) : (
        <>Não consegui abrir a spec de correção “{correction.title}”: {correction.error}</>
      )}
    </p>
  );
}

function Message({ projectId, message }: { projectId: string; message: ChatMessage }) {
  if (message.role === 'user') return <p className={`${bubble} m-0 justify-self-end bg-accent-soft text-ink`}>{message.text}</p>;
  return (
    <div className="grid justify-items-start gap-2">
      <div className={`${bubble} border border-line bg-surface text-ink`}><Markdown source={message.text} /></div>
      {message.correction ? <Correction projectId={projectId} correction={message.correction} /> : null}
    </div>
  );
}

export function ChatPage() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const current = useRef('');
  current.current = projectId;

  useEffect(() => {
    runApi.projects().then((p) => { setProjects(p); setProjectId(p[0]?.projectId ?? ''); }).catch((e: Error) => { setProjects([]); setProblem({ title: 'Não consegui carregar os projetos', message: plainError(e.message) }); });
  }, []);
  useEffect(() => {
    if (!projectId) return;
    let stale = false;
    setMessages(null);
    setProblem(null);
    chatApi.messages(projectId).then((r) => !stale && setMessages(r.messages)).catch((e: Error) => { if (!stale) { setMessages([]); setProblem({ title: 'Não consegui carregar a conversa', message: plainError(e.message) }); } });
    return () => { stale = true; };
  }, [projectId]);
  useEffect(() => {
    document.getElementById('chat-end')?.scrollIntoView?.({ block: 'end' });
  }, [messages, asking]);

  const send = async () => {
    const text = draft.trim();
    if (!text || asking) return;
    const asked = projectId;
    setProblem(null);
    setAsking(text);
    try {
      const { message } = await chatApi.ask(asked, text);
      if (current.current !== asked) return;
      setMessages((m) => [...(m ?? []), { role: 'user', text, at: message.at }, message]);
      setDraft('');
    } catch (e) {
      if (current.current === asked) setProblem({ title: 'Não consegui responder', message: plainError((e as Error).message), retry: send });
    } finally {
      setAsking(null);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };
  const clear = async () => {
    try {
      await chatApi.clear(projectId);
      setMessages([]);
    } catch (e) {
      setProblem({ title: 'Não consegui limpar a conversa', message: plainError((e as Error).message) });
    }
    setConfirmClear(false);
  };

  if (projects === null) return <main><Loading /></main>;
  const project = projects.find((p) => p.projectId === projectId);
  return (
    <main>
      <nav className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/" aria-label="Início">
          <Icon name="home" size={16} />
          <span>Início</span>
        </Link>
        <span aria-hidden="true">›</span>
        <strong>Chat de dúvidas</strong>
      </nav>
      <header className="min-w-0">
        <h1 className="m-0 text-ink">Chat de dúvidas</h1>
        <p className="mt-1 mb-0 text-[0.9375rem] text-ink-soft">Pergunte em palavras simples o que está sendo feito em cada projeto.</p>
      </header>
      {projects.length === 0 ? (
        <div className={emptyState}>
          <Icon name="folder" size={24} />
          <p>Nenhum projeto para perguntar ainda.</p>
          <p>Crie ou importe um projeto em Projetos e volte aqui.</p>
        </div>
      ) : (
        <section className={panelCard} aria-label="Conversa">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className={headingTile}><Icon name="chat" size={26} /></span>
              <div className="min-w-0">
                <span className={eyebrow}>Dúvidas sobre o projeto <InfoTip text={HELP} /></span>
                <h2 className={`${panelTitle} wrap-anywhere`}>{project?.name ?? projectId}</h2>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 max-md:w-full">
              <Select wrapperClassName="min-w-[14rem] max-md:flex-1" aria-label="Projeto" value={projectId} disabled={asking !== null} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
              </Select>
              <button type="button" className="secondary" disabled={!messages?.length || asking !== null} onClick={() => setConfirmClear(true)}>
                Limpar conversa
                <Icon name="trash" size={16} />
              </button>
            </div>
          </div>
          <div className="grid max-h-[min(32rem,calc(100dvh-30rem))] min-h-48 content-start gap-3 overflow-y-auto rounded-lg border border-line bg-surface-sunken p-4" aria-live="polite" aria-busy={messages === null || asking !== null}>
            {messages === null ? (
              <Skeleton>
                <Bone size="half" />
                <Bone />
                <Bone size="short" />
              </Skeleton>
            ) : null}
            {messages?.length === 0 && !asking ? (
              <div className={`${emptyState} border-0 bg-transparent`}>
                <Icon name="chat" size={24} />
                <p>Nenhuma pergunta feita ainda.</p>
                <p>Escreva abaixo ou comece por um destes exemplos.</p>
                {EXAMPLES.map((q) => <button key={q} type="button" className="secondary" onClick={() => setDraft(q)}>{q}</button>)}
              </div>
            ) : null}
            {messages?.map((m, i) => <Message key={`${m.at}-${i}`} projectId={projectId} message={m} />)}
            {asking ? (
              <>
                <p className={`${bubble} m-0 justify-self-end bg-accent-soft text-ink`}>{asking}</p>
                <p className={`${bubble} m-0 text-ink-soft`}>Respondendo… pode levar alguns instantes.</p>
              </>
            ) : null}
            <span id="chat-end" />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="chat-question" className={fieldLabel}>Sua pergunta</label>
            <div className="flex items-end gap-3 max-md:flex-wrap">
              <textarea
                id="chat-question"
                className="min-h-[var(--control-height)] w-full min-w-0 flex-1 resize-y px-4 py-3 text-[0.9375rem] leading-[1.5]"
                data-testid="chat-input"
                rows={2}
                maxLength={2000}
                placeholder="Ex.: o que está sendo desenvolvido agora?"
                value={draft}
                disabled={messages === null}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <ActionButton className="primary-button max-md:w-full" busy={asking !== null} disabled={draft.trim() === ''} onClick={send} icon={<Icon name="send" size={16} />}>
                Enviar
              </ActionButton>
            </div>
          </div>
          <p className="m-0 flex items-center gap-1.5 border-t border-line pt-4 text-[0.8125rem] text-ink-soft">
            <Icon name="info" size={16} />
            As conversas ficam salvas neste computador. Enter envia a pergunta e Shift+Enter quebra a linha.
          </p>
        </section>
      )}
      {problem ? (
        <Dialog title={problem.title} onClose={() => setProblem(null)}>
          <p className="m-0 text-[0.9375rem] text-ink">{problem.message}</p>
          {problem.retry ? <p className="mt-2 mb-0 text-[0.8125rem] text-ink-soft">Sua pergunta continua na caixa de texto.</p> : null}
          {problem.retry ? (
            <div className="mt-4 flex justify-end">
              <ActionButton className="primary-button" onClick={() => { const again = problem.retry; setProblem(null); return again?.(); }} icon={<Icon name="refresh" size={16} />}>Tentar de novo</ActionButton>
            </div>
          ) : null}
        </Dialog>
      ) : null}
      {confirmClear ? (
        <ConfirmDialog title="Limpar conversa" subject={project?.name} confirmLabel="Limpar" onConfirm={clear} onCancel={() => setConfirmClear(false)}>
          <p>As mensagens deste projeto serão apagadas. As specs de correção que o chat já abriu continuam existindo.</p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}
