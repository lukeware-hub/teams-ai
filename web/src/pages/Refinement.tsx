import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { refineApi, type AcceptanceCriterion, type ChecklistItem, type Snapshot, type StoredEvent } from '../api.js';
import { applyToSnapshot, type LiveSnapshot } from '../refine/reducer.js';
import { useJournal } from '../useSse.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
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
};
/** The server writes these details itself; details written by the agents pass through unchanged. */
const checkDetail = (detail: string) => {
  if (detail === 'not reported') return 'O agente não avaliou este item.';
  if (detail === 'every listed secret is present') return 'Todos os segredos necessários estão salvos.';
  if (detail === 'no blocking question open') return 'Nenhuma pergunta obrigatória em aberto.';
  const missing = /^missing secrets: (.+)$/.exec(detail);
  if (missing) return `Faltam segredos: ${missing[1]}.`;
  const open = /^(\d+) blocking question\(s\) open$/.exec(detail);
  if (open) return open[1] === '1' ? '1 pergunta obrigatória em aberto.' : `${open[1]} perguntas obrigatórias em aberto.`;
  return detail;
};
const criterionText = (c: AcceptanceCriterion) => `${c.id}: dado ${c.given}, quando ${c.when}, então ${c.then}`;
const startInfo = 'Os agentes passam a planejar, implementar, testar e publicar o projeto com base nestes documentos. Fica disponível com a lista atualizada e atendida, sem perguntas obrigatórias ou sugestões pendentes.';
const jevInfo = 'O Jev é um assistente de IA que confere se os cinco documentos estão consistentes entre si. Os apontamentos dele orientam a revisão: ajuste o que fizer sentido e reavalie.';
const evaluationInfo = 'Cada clique em Avaliar abre uma rodada: o Jev confere a consistência dos documentos, o Claude gera o spec.json e o project.json, e os agentes PO, SM e Front revisam e sugerem ajustes.';
const patchInfo = 'Mudança proposta por um agente: linhas com - saem e linhas com + entram. Aceitar aplica a mudança no documento; Rejeitar a descarta, e o motivo opcional fica no histórico.';
const jsonDownload = (value: unknown) => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value, null, 2))}`;

function currentClaudeStage(events: StoredEvent[], cycle: number, jevEvent: StoredEvent | undefined, derived: boolean): string {
  if (!jevEvent) return 'Jev está validando os cinco documentos do projeto.';
  if (jevEvent.data.available === false) return 'Jev indisponível: confira a chave do OpenRouter. A avaliação continua sem ele.';
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
  const [answer, setAnswer] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [newSecrets, setNewSecrets] = useState<Array<{ id: number; name: string; value: string }>>([]);
  useEffect(() => setDocs(snap.docs), [snap.docs]);
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
  const canStart = st.status === 'ready' && !st.stale && !busy;
  const derivedThisCycle = (p.events ?? []).some((e) => e.type === 'DERIVED' && Number(e.data.cycle) === st.cycle);
  const jevEvent = (p.events ?? []).find((e) => e.type === 'REFINE_DOCS_VALIDATED' && Number(e.data.cycle) === st.cycle);
  const claudeStage = currentClaudeStage(p.events ?? [], st.cycle, jevEvent, derivedThisCycle);
  const criteria = st.derived?.spec.acceptanceCriteria ?? [];
  const listState = st.status === 'evaluating'
    ? { label: 'Avaliando', tone: 'tone-neutral' }
    : st.cycle === 0
      ? { label: 'Não avaliada', tone: '' }
      : st.stale
        ? { label: 'Desatualizada', tone: 'warn' }
        : { label: 'Atual', tone: 'ok' };
  const nextStep = st.status === 'evaluating'
    ? 'Aguarde o fim da avaliação; o andamento aparece logo abaixo.'
    : jevAdvisory
    ? 'O Jev apontou pontos nos documentos. Ajuste o que fizer sentido e clique em Reavaliar.'
    : pending.length > 0
    ? 'Responda às perguntas em aberto para continuar.'
    : st.stale
      ? 'Clique em Reavaliar para atualizar a lista de verificação com as últimas mudanças.'
      : st.patches.some((x) => x.status === 'pending')
        ? 'Revise as sugestões de alteração abaixo e aceite ou rejeite cada uma.'
        : canStart
          ? 'Tudo pronto. Clique em Iniciar análise para os agentes desenvolverem o projeto.'
          : st.cycle === 0
            ? 'Revise os documentos e clique em Avaliar. Os agentes vão revisar a demanda e preencher a lista de verificação.'
            : 'Corrija nos documentos os itens não atendidos da lista de verificação e clique em Reavaliar.';
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
          <button type="button" className="editor-copy" aria-label="Copiar documento" onClick={() => copyDoc(docs[tab] ?? '')}><Icon name="copy" size={19} /></button>
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
            A lista de verificação está desatualizada: houve mudanças depois da última avaliação.
          </p>
        )}
        {jevAdvisory && <p className="notice">O Jev atua como auxiliar: seus apontamentos serão considerados por Claude, PO e SM. <InfoTip text={jevInfo} /></p>}
        <div className="doc-actions">
          <span className="save-hint"><Icon name="info" size={18} />As alterações são salvas automaticamente ao sair do editor.</span>
          <button data-testid="evaluate" className="primary refine-action" disabled={locked} onClick={p.onEvaluate}>
          <Icon name="check" size={18} />{st.cycle === 0 ? 'Avaliar' : 'Reavaliar'}
          </button>
        </div>
        {st.status === 'evaluating' && <span className="spinner">Avaliando…</span>}
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
          <div className="claude-session" role="status" aria-live="polite">
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
            <small>{pending.length === 1 ? 'Esta é a última pergunta em aberto.' : pending.length === 2 ? 'Mais 1 pergunta depois desta.' : `Mais ${pending.length - 1} perguntas depois desta.`}</small>
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
                <span className={`badge ${q.role}`}>{q.role.toUpperCase()}</span> {questionText(q.text)} → {q.status === 'skipped' ? <i>ignorada</i> : q.answer}
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
        <h4><Icon name="file" size={20} />Arquivos gerados<InfoTip text="Versão estruturada dos documentos, gerada pelo Claude a cada avaliação. O project.json descreve o projeto; o spec.json, esta demanda, com tarefas e critérios de aceite." /></h4>
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
        <details>
          <summary><span>project.json</span>{st.derived ? <a data-testid="download-project-json" href={jsonDownload(st.derived.project)} download="project.json" aria-label="Baixar project.json" onClick={(e) => e.stopPropagation()}><Icon name="download" size={18} /></a> : <span className="file-status">Aguardando avaliação</span>}</summary>
          {st.derived ? <pre>{JSON.stringify(st.derived.project, null, 2)}</pre> : <p className="file-empty">Será gerado após a avaliação.</p>}
        </details>
        <h4><Icon name="list" size={20} />Tarefas<InfoTip text="Tarefas descritas no briefing, extraídas a cada avaliação. Na execução, o SM as usa para montar o plano de trabalho." /></h4>
        <ul className="quality-tasks">
          {(st.derived?.spec.tasks ?? []).map((t, i) => (
            <li key={i}>
              <b>{t.title}</b>: {t.description}
            </li>
          ))}
        </ul>
        {(st.derived?.spec.tasks ?? []).length === 0 && <div className="quality-empty"><Icon name="clipboard" size={26} /><strong>Nenhuma tarefa gerada ainda.</strong><span>As tarefas aparecerão aqui após a avaliação.</span></div>}
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
      <header className="refine-breadcrumb"><a href="/projects" aria-label="Voltar para projetos"><Icon name="home" size={18} /><span>Projetos</span></a><span>›</span><strong>{projectId}</strong><span>›</span><span>{specId} rascunho</span>
        <span className="refine-start-group">
          <button data-testid="start" className="primary refine-start refine-top-action" disabled={snap.state.status !== 'ready' || snap.state.stale} onClick={act(() => refineApi.start(projectId, specId).then(({ runId }) => navigate(`/runs/${runId}`)))}>
            <Icon name="play" size={18} />Iniciar análise
          </button>
          <InfoTip text={startInfo} />
        </span>
      </header>
      {(error || snap.state.status === 'error') && <p className="error refine-page-error" role="alert">{errorText(error ?? snap.state.error)}</p>}
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
