import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { refineApi, type ChecklistItem, type Snapshot, type StoredEvent } from '../api.js';
import { applyToSnapshot, type LiveSnapshot } from '../refine/reducer.js';
import { useJournal } from '../useSse.js';
import { Icon } from '../components/Icons.js';

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
  'project.md': 'Deriva project.json e influencia todas as especificações do projeto.',
  'brief.md': 'Deriva spec.json e define o escopo desta demanda.',
  'stack.md': 'Influencia o tech-spec, o plano técnico e a implementação.',
  'flow.md': 'Influencia os critérios de aceitação, testes e validação.',
  'design.md': 'Define o contrato visual usado pelo Front.',
};
const jsonDownload = (value: unknown) => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value, null, 2))}`;

function currentClaudeStage(events: StoredEvent[], cycle: number, jevEvent: StoredEvent | undefined, derived: boolean): string {
  if (!jevEvent) return 'Jev está validando os cinco documentos do projeto.';
  if (jevEvent.data.available === false) return 'Jev não está disponível; verifique OPENROUTER_API_KEY.';
  if (jevEvent.data.decision === 'blocked') return 'Jev encontrou pontos importantes para revisão; PO e SM vão avaliá-los.';
  if (jevEvent.data.decision === 'review') return 'Jev encontrou pontos para revisão; Claude está analisando os documentos.';

  const cycleEvents = events.filter((e) => Number(e.data.attempt) === cycle || Number(e.data.cycle) === cycle);
  const started = new Map<string, { kind: string; role: string }>();
  for (const event of cycleEvents) {
    if (event.type === 'STEP_STARTED') started.set(String(event.data.stepId), { kind: String(event.data.kind), role: String(event.data.role) });
    if (event.type === 'STEP_FINISHED') started.delete(String(event.data.stepId));
  }
  const active = [...started.values()];
  if (active.some((step) => step.kind === 'derive')) return 'Claude está derivando project.json e spec.json a partir dos cinco documentos.';
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
  onEvaluate(): void;
  onAnswer(id: string, text: string): void;
  onSkip(id: string): void;
  onAccept(id: string): void;
  onReject(id: string, reason: string | null): void;
  onSecret(name: string, value: string): void;
  onStart(): void;
  startInHeader?: boolean;
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
  const [newSecrets, setNewSecrets] = useState<Array<{ id: number; name: string; value: string }>>([]);
  useEffect(() => setDocs(snap.docs), [snap.docs]);
  const locked = busy || st.status === 'evaluating' || st.status === 'started';
  const jevAdvisory = st.error?.startsWith('Jev bloqueou') ?? false;
  const pending = [...st.questions.filter((q) => q.status === 'pending')].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const current = pending[0];
  const canStart = st.status === 'ready' && !st.stale && !busy;
  const derivedThisCycle = (p.events ?? []).some((e) => e.type === 'DERIVED' && Number(e.data.cycle) === st.cycle);
  const jevEvent = (p.events ?? []).find((e) => e.type === 'REFINE_DOCS_VALIDATED' && Number(e.data.cycle) === st.cycle);
  const claudeStage = currentClaudeStage(p.events ?? [], st.cycle, jevEvent, derivedThisCycle);
  const nextStep = jevAdvisory
    ? 'O Jev encontrou pontos para revisão. PO e SM devem confirmar as regras durante a análise.'
    : pending.length > 0
    ? 'Responda as perguntas pendentes para continuar.'
    : st.stale
      ? 'Clique em Reavaliar para atualizar a checklist após suas respostas.'
      : st.patches.some((x) => x.status === 'pending')
        ? 'Revise as alterações sugeridas e aceite ou rejeite cada uma.'
        : canStart
          ? 'Tudo pronto. Clique em Iniciar para executar o projeto.'
          : 'Revise a checklist e corrija os itens pendentes.';
  return (
    <div className="refine refine-workspace">
      <section className="docs panel-card">
        <div className="section-heading">
          <div>
            <span className="refine-heading-icon refine-heading-icon-docs"><Icon name="file" size={26} /></span>
            <div><span className="eyebrow">Área de trabalho</span>
            <h2>Documentos do projeto</h2>
            </div>
          </div>
          <span className="doc-state">{locked ? 'Somente leitura' : 'Editável'}</span>
        </div>
        <div className="tabs" role="tablist" aria-label="Documentos do projeto">
          {(['project.md', 'brief.md', 'stack.md', 'flow.md', 'design.md'] as DocFile[]).map((f) => (
            <button key={f} className={tab === f ? 'active' : ''} onClick={() => setTab(f)}>
              {docLabel[f]}
            </button>
          ))}
        </div>
        <p data-testid="doc-impact" className="hint">{docImpact[tab]}</p>
        <div className="document-editor">
          <button type="button" className="editor-copy" aria-label="Copiar documento" onClick={() => void navigator.clipboard?.writeText(docs[tab] ?? '')}><Icon name="copy" size={19} /></button>
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
        </div>
        {st.stale && (
          <p data-testid="stale" className="notice">
            Lista desatualizada — reavalie
          </p>
        )}
        {st.status === 'error' && <p className="error">{errorText(st.error)}</p>}
        {jevAdvisory && <p className="notice">O Jev atua como auxiliar: seus apontamentos serão considerados por Claude, PO e SM.</p>}
        <div className="doc-actions">
          <span className="save-hint"><Icon name="info" size={18} />As alterações são salvas automaticamente ao sair do editor.</span>
          <button data-testid="evaluate" className="primary refine-action" disabled={locked} onClick={p.onEvaluate}>
          <Icon name="check" size={18} />{st.cycle === 0 ? 'Avaliar' : 'Reavaliar'}
          </button>
        </div>
        {st.status === 'evaluating' && <span className="spinner">avaliando…</span>}
      </section>
      <section className="conversation panel-card">
        <div className="section-heading">
          <div>
            <span className="refine-heading-icon refine-heading-icon-review"><Icon name="clipboard" size={26} /></span>
            <div><span className="eyebrow">Refinamento</span>
            <h2>Área de revisão</h2>
            </div>
          </div>
          <span className="count-pill">{pending.length} em aberto</span>
        </div>
        <p className="next-step"><Icon name="lightbulb" size={20} /><span><b>Próximo passo:</b> {nextStep}</span></p>
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
              <div className="patch-heading">
                <span className={`badge ${x.role}`}>{x.role === 'front' ? 'FRONT' : x.role.toUpperCase()}</span>
                <b>{x.file}</b>
                <span className="patch-reason">{x.reason}</span>
              </div>
              <pre className="diff">{x.diff}</pre>
              <div className="patch-actions">
              <button type="button" className="patch-accept" data-testid={`accept-${x.patchId}`} onClick={() => p.onAccept(x.patchId)}>
                Aceitar
              </button>
              <input
                data-testid={`reject-reason-${x.patchId}`}
                placeholder="motivo (opcional)"
                value={reasons[x.patchId] ?? ''}
                onChange={(e) => setReasons({ ...reasons, [x.patchId]: e.target.value })}
              />
              <button type="button" className="patch-reject" data-testid={`reject-${x.patchId}`} onClick={() => p.onReject(x.patchId, reasons[x.patchId] || null)}>
                Rejeitar
              </button>
              </div>
            </div>
          ))}
        {st.discarded.map((d, i) => (
          <p key={i} className="warning">
            Alteração de {d.role} descartada em {d.file}: {d.reason}
          </p>
        ))}
        <h4><Icon name="clock" size={20} />Histórico</h4>
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
        {!p.startInHeader && <button data-testid="start" className="primary full-width refine-start" disabled={!canStart} onClick={p.onStart}>
          <Icon name="play" size={18} />Iniciar análise
        </button>}
      </section>
      <section className="panels panel-card">
        <div className="section-heading">
          <div>
            <span className="refine-heading-icon refine-heading-icon-quality"><Icon name="shield" size={26} /></span>
            <div><span className="eyebrow">Controle de qualidade</span>
            <h2>Lista de verificação</h2>
            </div>
          </div>
          <span className={`status-dot ${st.stale ? 'warn' : 'ok'}`}>{st.stale ? 'Precisa revisar' : 'Atual'}</span>
        </div>
        <p className="cost-summary"><span>Custo desta análise</span><strong>{snap.tokens.steps} etapas · {snap.tokens.inputTokens + snap.tokens.outputTokens} tokens · US$ {snap.tokens.costUsd.toFixed(2)}</strong></p>
        <div className="quality-checks"><h5>Checklist PO</h5><Checklist items={st.checklist} role="po" /><h5>Checklist SM</h5><Checklist items={st.checklist} role="sm" /></div>
        <h4><Icon name="file" size={20} />Arquivos gerados</h4>
        {st.derived?.spec && <p data-testid="spec-type">Tipo da demanda: <strong>{typeLabel[st.derived.spec.type] ?? st.derived.spec.type}</strong></p>}
        {st.derived?.spec.type === 'bug' && st.derived.spec.bug && (
          <div data-testid="bug-details" className="notice">
            <strong>Bug</strong>: atual {st.derived.spec.bug.actual}; esperado {st.derived.spec.bug.expected}; reprodução {st.derived.spec.bug.reproduction}
          </div>
        )}
        <details>
          <summary><span>spec.json</span>{st.derived ? <a data-testid="download-spec-json" href={jsonDownload(st.derived.spec)} download="spec.json" onClick={(e) => e.stopPropagation()}><Icon name="download" size={18} /></a> : <span className="file-status">Aguardando análise</span>}</summary>
          {st.derived ? <pre>{JSON.stringify(st.derived.spec, null, 2)}</pre> : <p className="file-empty">Será gerado após a análise.</p>}
        </details>
        <details>
          <summary><span>project.json</span>{st.derived ? <a data-testid="download-project-json" href={jsonDownload(st.derived.project)} download="project.json" onClick={(e) => e.stopPropagation()}><Icon name="download" size={18} /></a> : <span className="file-status">Aguardando análise</span>}</summary>
          {st.derived ? <pre>{JSON.stringify(st.derived.project, null, 2)}</pre> : <p className="file-empty">Será gerado após a análise.</p>}
        </details>
        <h4><Icon name="list" size={20} />Tarefas</h4>
        <ul className="quality-tasks">
          {(st.derived?.spec.tasks ?? []).map((t, i) => (
            <li key={i}>
              <b>{t.title}</b>: {t.description}
            </li>
          ))}
        </ul>
        {(st.derived?.spec.tasks ?? []).length === 0 && <div className="quality-empty"><Icon name="clipboard" size={26} /><strong>Nenhuma tarefa gerada ainda.</strong><span>As tarefas aparecerão aqui após a análise.</span></div>}
        <div className="secrets-heading"><h4><Icon name="lock" size={20} />Segredos</h4><button type="button" className="secondary add-secret" onClick={() => setNewSecrets((rows) => [...rows, { id: Date.now(), name: '', value: '' }])}>+ Adicionar segredo</button></div>
        <ul className="quality-secrets">
          {snap.secrets.map((s) => (
            <li key={s.name} className="secret-row">
              <div className="secret-label"><span className={s.present ? 'secret-state present' : 'secret-state'}>{s.present ? '●' : '○'}</span><code>{s.name}</code>{s.hint && <small>final …{s.hint}</small>}</div>
              <div className="secret-entry"><input type="password" data-testid={`secret-${s.name}`} placeholder={s.present ? 'Digite um novo valor para substituir' : 'Cole o valor da chave'} value={secretValues[s.name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [s.name]: e.target.value })} /><button data-testid={`save-secret-${s.name}`} disabled={locked || !(secretValues[s.name] ?? '')} onClick={() => { p.onSecret(s.name, secretValues[s.name]!); setSecretValues({ ...secretValues, [s.name]: '' }); }}>Salvar</button></div>
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
    <main className="refine-page">
      <header className="refine-breadcrumb"><a href="/projects" aria-label="Voltar para projetos"><Icon name="home" size={18} /><span>Projetos</span></a><span>›</span><strong>{projectId}</strong><span>›</span><span>{specId} rascunho</span><span className={`status ${snap.state.status}`}>{({ answering: 'respondendo', evaluating: 'avaliando', ready: 'pronto', error: 'erro', started: 'iniciado', drafting: 'rascunho' } as Record<string, string>)[snap.state.status] ?? snap.state.status}</span>
        <button data-testid="start" className="primary refine-start refine-top-action" disabled={snap.state.status !== 'ready' || snap.state.stale} onClick={act(() => refineApi.start(projectId, specId).then(({ runId }) => navigate(`/runs/${runId}`)))}>
          <Icon name="play" size={18} />Iniciar análise
        </button>
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
        startInHeader
        events={events}
      />
    </main>
  );
}
