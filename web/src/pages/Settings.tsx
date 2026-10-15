import { useEffect, useRef, useState } from 'react';
import { AGENT_EFFORTS, AGENT_MODELS, runApi, settingsApi, type AgentChoice, type AgentEffort, type AgentModel, type AgentRow, type AgentSetting, type ProjectRow } from '../api.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { Select } from '../components/Select.js';
import { emptyState, panel, row, rowActions, rowId, rows, sectionTitle } from './project-shared.js';

const ROLE_LABELS: Record<string, string> = { sm: 'Scrum Master', po: 'Product Owner', front: 'Front-end', dev: 'Desenvolvedor', test: 'Testes', sec: 'Segurança', devops: 'DevOps', env: 'Ambiente' };
const MODEL_LABELS: Record<AgentModel, string> = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' };
const EFFORT_LABELS: Record<AgentEffort, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', max: 'Máximo' };
const DEFAULT_PICK: AgentSetting = { model: 'claude-sonnet-5-5', effort: 'medium' };
const SAVE_ERROR = 'Não foi possível salvar. Tente novamente.';
const HELP_AGENTS = 'Automático deixa o orquestrador escolher o modelo e o esforço de cada tarefa. Manual fixa os dois para o agente em todos os seus passos, inclusive os de arquitetura. Manual ignora o limite de esforço por modelo e pode gastar mais cota.';

function AgentLine({ projectId, row: agent, onFailed }: { projectId: string; row: AgentRow; onFailed: () => void }) {
  const label = ROLE_LABELS[agent.role] ?? agent.role;
  const [manual, setManual] = useState(agent.setting !== null);
  const [pick, setPick] = useState<AgentSetting>(agent.setting ?? DEFAULT_PICK);
  // One save after another, so the last choice on screen is the last one the server receives.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (choice: AgentChoice) => {
    queue.current = queue.current.then(() => settingsApi.setAgent(projectId, agent.role, choice)).catch(onFailed);
  };
  const changeMode = (value: string) => {
    const next = value === 'manual';
    setManual(next);
    save(next ? { mode: 'manual', ...pick } : { mode: 'auto' });
  };
  const changePick = (next: AgentSetting) => {
    setPick(next);
    save({ mode: 'manual', ...next });
  };
  return (
    <li className={row}>
      <span className={rowId}>{label}</span>
      <span className="text-[0.8125rem] text-ink-soft">{manual ? `${MODEL_LABELS[pick.model]} · ${EFFORT_LABELS[pick.effort]}` : 'Orquestrador escolhe'}</span>
      <div className={rowActions}>
        {manual ? (
          <>
            <Select wrapperClassName="w-[8.5rem]" aria-label={`Modelo de ${label}`} value={pick.model} onChange={(e) => changePick({ ...pick, model: e.target.value as AgentModel })}>
              {AGENT_MODELS.map((m) => <option key={m} value={m}>{MODEL_LABELS[m]}</option>)}
            </Select>
            <Select wrapperClassName="w-[8.5rem]" aria-label={`Esforço de ${label}`} value={pick.effort} onChange={(e) => changePick({ ...pick, effort: e.target.value as AgentEffort })}>
              {AGENT_EFFORTS.map((e) => <option key={e} value={e}>{EFFORT_LABELS[e]}</option>)}
            </Select>
          </>
        ) : null}
        {/* The mode stays last so it keeps its place when the model and effort appear beside it. */}
        <Select wrapperClassName="w-[10rem]" aria-label={`Modo de ${label}`} value={manual ? 'manual' : 'auto'} onChange={(e) => changeMode(e.target.value)}>
          <option value="auto">Automático</option>
          <option value="manual">Manual</option>
        </Select>
      </div>
    </li>
  );
}

export function SettingsPage() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a save fails, so the agents are read again from the server instead of showing the unsaved choice.
  const [version, setVersion] = useState(0);
  // The error sits on the page, not the row: reloading the agents unmounts the rows.
  const saveFailed = () => {
    setError(SAVE_ERROR);
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    runApi.projects().then((list) => {
      setProjects(list);
      setProjectId(list[0]?.projectId ?? '');
    }).catch(() => setError('Não foi possível carregar os projetos.'));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setAgents(null);
    settingsApi.agents(projectId).then((r) => {
      if (active) setAgents(r.agents);
    }).catch(() => {
      if (active) setError('Não foi possível carregar as configurações do projeto.');
    });
    return () => {
      active = false;
    };
  }, [projectId, version]);

  return (
    <main>
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="m-0 text-ink">Configurações</h1>
          <p className="mt-1 mb-0 text-[0.9375rem] text-ink-soft">Escolha o modelo e o esforço de cada agente, em cada projeto.</p>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {projects === null && !error ? <Loading /> : null}
      {projects?.length === 0 ? (
        <section className={panel}>
          <div className={emptyState}>
            <p>Nenhum projeto cadastrado.</p>
            <p>Cadastre um projeto para escolher os agentes.</p>
          </div>
        </section>
      ) : null}
      {projects && projects.length > 0 ? (
        <section className={`${panel} gap-3`} aria-labelledby="agents-title">
          <label className="grid max-w-[24rem] gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-ink-soft">Projeto</span>
            <Select value={projectId} onChange={(e) => {
              setError(null);
              setProjectId(e.target.value);
            }}>
              {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name || p.projectId}</option>)}
            </Select>
          </label>
          <div className={sectionTitle}>
            <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="agents-title">Agentes</h2>
            <InfoTip label="Agentes" text={HELP_AGENTS} />
          </div>
          {agents ? <ul className={`${rows} [&>li]:border-accent-line`}>{agents.map((agent) => <AgentLine key={`${projectId}/${agent.role}`} projectId={projectId} row={agent} onFailed={saveFailed} />)}</ul> : <Loading />}
        </section>
      ) : null}
    </main>
  );
}
