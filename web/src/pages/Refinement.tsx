import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { refineApi, type ChecklistItem, type Snapshot, type StoredEvent } from '../api.js';
import { applyToSnapshot, type LiveSnapshot } from '../refine/reducer.js';
import { useJournal } from '../useSse.js';

type DocFile = 'project.md' | 'brief.md' | 'stack.md' | 'flow.md';
const docLabel: Record<DocFile, string> = { 'project.md': 'project.md', 'brief.md': 'briefing.md', 'stack.md': 'stack.md', 'flow.md': 'flow.md' };
const questionText = (text: string) => text.startsWith('What counts as valid client data?')
  ? 'Quais dados um cliente precisa ter? Nome, e-mail, telefone e observações são obrigatórios? Quais formatos e limites devemos aceitar? O e-mail pode se repetir? Se algum dado for inválido, devemos mostrar o erro de cada campo e retornar HTTP 400?'
  : text;
const errorText = (text: string | null) => text
  ?.replace(/\binterrupted\b/gi, 'A avaliação foi interrompida. Clique em Reavaliar para tentar novamente.')
  .replaceAll('failed', 'falhou')
  .replaceAll('timeout', 'tempo limite excedido')
  .replaceAll('internal error', 'erro interno') ?? null;

function currentClaudeStage(events: StoredEvent[], cycle: number, jevEvent: StoredEvent | undefined, derived: boolean): string {
  if (!jevEvent) return 'Jev está validando project.md, briefing.md, stack.md e flow.md.';
  if (jevEvent.data.available === false) return 'Jev não está disponível; verifique OPENROUTER_API_KEY.';

  const cycleEvents = events.filter((e) => Number(e.data.attempt) === cycle || Number(e.data.cycle) === cycle);
  const started = new Map<string, { kind: string; role: string }>();
  for (const event of cycleEvents) {
    if (event.type === 'STEP_STARTED') started.set(String(event.data.stepId), { kind: String(event.data.kind), role: String(event.data.role) });
    if (event.type === 'STEP_FINISHED') started.delete(String(event.data.stepId));
  }
  const active = [...started.values()];
  if (active.some((step) => step.kind === 'derive')) return 'Claude está derivando project.json e spec.json a partir dos quatro documentos.';
  const roles = active.filter((step) => step.kind === 'refine').map((step) => step.role);
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
  onEvaluate(): void;
  onAnswer(id: string, text: string): void;
  onSkip(id: string): void;
  onAccept(id: string): void;
  onReject(id: string, reason: string | null): void;
  onSecret(name: string, value: string): void;
  onStart(): void;
  events?: StoredEvent[];
}

function Checklist({ items, role }: { items: ChecklistItem[]; role: 'po' | 'sm' }) {
  return (
    <ul className="checklist">
      {items
        .filter((i) => i.role === role)
        .map((i) => (
          <li key={i.id} className={i.passed ? 'pass' : 'fail'} title={i.detail}>
            {i.passed ? '✓' : '✗'} {i.id.slice(3)} <small>{i.detail}</small>
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
  const [answer, setAnswer] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  useEffect(() => setDocs(snap.docs), [snap.docs]);
  const locked = busy || st.status === 'evaluating' || st.status === 'started';
  const pending = [...st.questions.filter((q) => q.status === 'pending')].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const current = pending[0];
  const canStart = st.status === 'ready' && !st.stale && !busy;
  const derivedThisCycle = (p.events ?? []).some((e) => e.type === 'DERIVED' && Number(e.data.cycle) === st.cycle);
  const jevEvent = (p.events ?? []).find((e) => e.type === 'REFINE_DOCS_VALIDATED' && Number(e.data.cycle) === st.cycle);
  const claudeStage = currentClaudeStage(p.events ?? [], st.cycle, jevEvent, derivedThisCycle);
  const nextStep = pending.length > 0
    ? 'Responda as perguntas pendentes para continuar.'
    : st.stale
      ? 'Clique em Reavaliar para atualizar a checklist após suas respostas.'
      : st.patches.some((x) => x.status === 'pending')
        ? 'Revise as alterações sugeridas e aceite ou rejeite cada uma.'
        : canStart
          ? 'Tudo pronto. Clique em Iniciar para executar o projeto.'
          : 'Revise a checklist e corrija os itens pendentes.';
  return (
    <div className="refine">
      <section className="docs panel-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Área de trabalho</span>
            <h2>Documentos do projeto</h2>
          </div>
          <span className="doc-state">{locked ? 'Somente leitura' : 'Editável'}</span>
        </div>
        <div className="tabs" role="tablist" aria-label="Documentos do projeto">
          {(['project.md', 'brief.md', 'stack.md', 'flow.md'] as DocFile[]).map((f) => (
            <button key={f} className={tab === f ? 'active' : ''} onClick={() => setTab(f)}>
              {docLabel[f]}
            </button>
          ))}
        </div>
        <textarea
          aria-label={`${tab} editor`}
          data-testid={`doc-${tab}`}
          value={docs[tab] ?? ''}
          readOnly={locked}
          onChange={(e) => setDocs({ ...docs, [tab]: e.target.value })}
          onBlur={() => {
            if (!locked && docs[tab] !== snap.docs[tab]) p.onSaveDoc(tab, docs[tab] ?? '');
          }}
        />
        {st.stale && (
          <p data-testid="stale" className="notice">
            Lista desatualizada — reavalie
          </p>
        )}
        {st.status === 'error' && <p className="error">{errorText(st.error)}</p>}
        <div className="doc-actions">
          <span className="save-hint">As alterações são salvas ao sair do editor.</span>
          <button data-testid="evaluate" className="secondary" disabled={locked} onClick={p.onEvaluate}>
          {st.cycle === 0 ? 'Avaliar' : 'Reavaliar'}
          </button>
        </div>
        {st.status === 'evaluating' && <span className="spinner">avaliando…</span>}
      </section>
      <section className="conversation panel-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Refinamento</span>
            <h2>Área de revisão</h2>
          </div>
          <span className="count-pill">{pending.length} em aberto</span>
        </div>
        <p className="next-step"><b>Próximo passo:</b> {nextStep}</p>
        {busy && (
          <div className="claude-session" role="status" aria-live="polite">
            <span className="live-dot" aria-hidden="true" />
            <div>
              <b>Sessão Claude ativa</b>
              <span>Ciclo {st.cycle} · {claudeStage}</span>
            </div>
            <span className="session-spinner" aria-hidden="true">•••</span>
          </div>
        )}
        {current ? (
          <div className="question card-inner">
            <span className={`badge ${current.role}`}>{current.role.toUpperCase()}</span>
            {current.blocking && <span className="tag">bloqueante</span>}
            <p>{questionText(current.text)}</p>
            {current.relatedAcIds.length > 0 && <small>{current.relatedAcIds.join(', ')}</small>}
            <label className="field-label" htmlFor="refinement-answer">Sua resposta</label>
            <textarea id="refinement-answer" data-testid="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <button
              data-testid={`answer-${current.questionId}`}
              disabled={locked || answer.trim() === ''}
              onClick={() => {
                p.onAnswer(current.questionId, answer);
                setAnswer('');
              }}
            >
              Responder
            </button>
            {!current.blocking && (
              <button data-testid={`skip-${current.questionId}`} disabled={locked} onClick={() => p.onSkip(current.questionId)}>
                Ignorar
              </button>
            )}
            <small>{pending.length - 1} pendentes</small>
          </div>
        ) : (
          <p className="muted">Nenhuma pergunta em aberto.</p>
        )}
        {st.patches
          .filter((x) => x.status === 'pending')
          .map((x) => (
            <div key={x.patchId} className="patch">
              <span className={`badge ${x.role}`}>{x.role.toUpperCase()}</span> <b>{x.file}</b> — {x.reason}
              <pre className="diff">{x.diff}</pre>
              <button data-testid={`accept-${x.patchId}`} disabled={locked} onClick={() => p.onAccept(x.patchId)}>
                Aceitar
              </button>
              <input
                data-testid={`reject-reason-${x.patchId}`}
                placeholder="motivo (opcional)"
                value={reasons[x.patchId] ?? ''}
                onChange={(e) => setReasons({ ...reasons, [x.patchId]: e.target.value })}
              />
              <button data-testid={`reject-${x.patchId}`} disabled={locked} onClick={() => p.onReject(x.patchId, reasons[x.patchId] || null)}>
                Rejeitar
              </button>
            </div>
          ))}
        {st.discarded.map((d, i) => (
          <p key={i} className="warning">
            Alteração de {d.role} descartada em {d.file}: {d.reason}
          </p>
        ))}
        <h4>Histórico</h4>
        <ul className="history">
          {[...st.questions]
            .filter((q) => q.status !== 'pending')
            .reverse()
            .map((q) => (
              <li key={q.questionId}>
                <span className={`badge ${q.role}`}>{q.role}</span> {questionText(q.text)} → {q.status === 'skipped' ? <i>ignorada</i> : q.answer}
              </li>
            ))}
          {[...st.patches]
            .filter((x) => x.status !== 'pending')
            .reverse()
            .map((x) => (
              <li key={x.patchId}>
                alteração em {x.file} ({x.reason}) → {x.status === 'accepted' ? 'aceita' : x.status === 'rejected' ? 'rejeitada' : 'descartada'}
                {x.decision ? `: ${x.decision}` : ''}
              </li>
            ))}
        </ul>
      </section>
      <section className="panels panel-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Controle de qualidade</span>
            <h2>Lista de verificação</h2>
          </div>
          <span className={`status-dot ${st.stale ? 'warn' : 'ok'}`}>{st.stale ? 'Precisa revisar' : 'Atual'}</span>
        </div>
        <h5>PO</h5>
        <Checklist items={st.checklist} role="po" />
        <h5>SM</h5>
        <Checklist items={st.checklist} role="sm" />
        <h4>Arquivos gerados</h4>
        <details>
          <summary>spec.json</summary>
          <pre>{JSON.stringify(st.derived?.spec ?? null, null, 2)}</pre>
        </details>
        <details>
          <summary>project.json</summary>
          <pre>{JSON.stringify(st.derived?.project ?? null, null, 2)}</pre>
        </details>
        <h5>Tarefas</h5>
        <ul>
          {(st.derived?.spec.tasks ?? []).map((t, i) => (
            <li key={i}>
              <b>{t.title}</b>: {t.description}
            </li>
          ))}
        </ul>
        <h4>Segredos</h4>
        <ul>
          {snap.secrets.map((s) => (
            <li key={s.name}>
              {s.present ? '●' : '○'} {s.name} {s.hint && <code>…{s.hint}</code>}
              <input type="password" data-testid={`secret-${s.name}`} value={secretValues[s.name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [s.name]: e.target.value })} />
              <button
                data-testid={`save-secret-${s.name}`}
                disabled={locked || !(secretValues[s.name] ?? '')}
                onClick={() => {
                  p.onSecret(s.name, secretValues[s.name]!);
                  setSecretValues({ ...secretValues, [s.name]: '' });
                }}
              >
                Salvar
              </button>
            </li>
          ))}
        </ul>
        <p className="tokens">
          {snap.tokens.steps} etapas · {snap.tokens.inputTokens + snap.tokens.outputTokens} tokens · US$ {snap.tokens.costUsd.toFixed(2)}
        </p>
        <button data-testid="start" className="primary full-width" disabled={!canStart} onClick={p.onStart}>
          Iniciar
        </button>
      </section>
    </div>
  );
}

export function RefinementPage() {
  const { projectId = '', specId = '' } = useParams();
  const navigate = useNavigate();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  useEffect(() => {
    if (!snap) return;
    let next: LiveSnapshot = snap;
    for (const e of events) {
      if (e.seq <= applied.current) continue;
      applied.current = e.seq;
      next = applyToSnapshot(next, e);
      if (e.type === 'REFINE_STARTED_RUN') navigate(`/runs/${String(e.data.runId)}`);
    }
    if (next !== snap) {
      if (next.docsDirty) void load();
      else setSnap(next);
    }
  }, [events]);
  if (!snap) return (
    <main>
      <p>{error ?? 'carregando…'}</p>
    </main>
  );
  const act = (f: () => Promise<unknown>) => () => {
    setError(null);
    f().catch((e: Error) => setError(e.message));
  };
  return (
    <main>
      <header>
        <a href="/projects">Projetos</a> › {projectId} / {specId} <span className={`status ${snap.state.status}`}>{({ answering: 'respondendo', evaluating: 'avaliando', ready: 'pronto', error: 'erro', started: 'iniciado', drafting: 'rascunho' } as Record<string, string>)[snap.state.status] ?? snap.state.status}</span>
      </header>
      {error && <p className="error">{errorText(error)}</p>}
      <RefinementView
        snap={snap}
        busy={snap.state.status === 'evaluating'}
        onSaveDoc={(f, t) => act(() => refineApi.saveDoc(projectId, specId, f, t))()}
        onEvaluate={act(() => refineApi.evaluate(projectId, specId))}
        onAnswer={(id, t) => act(() => refineApi.answer(projectId, specId, id, t))()}
        onSkip={(id) => act(() => refineApi.skip(projectId, specId, id))()}
        onAccept={(id) => act(() => refineApi.accept(projectId, specId, id))()}
        onReject={(id, r) => act(() => refineApi.reject(projectId, specId, id, r))()}
        onSecret={(n, v) => act(() => refineApi.secret(projectId, specId, n, v).then(load))()}
        onStart={act(() => refineApi.start(projectId, specId).then(({ runId }) => navigate(`/runs/${runId}`)))}
        events={events}
      />
    </main>
  );
}
