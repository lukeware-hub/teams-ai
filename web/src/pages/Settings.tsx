import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_EFFORTS, AGENT_MODELS, api, refineApi, runApi, settingsApi, type AgentChoice, type AgentEffort, type AgentModel, type AgentRow, type AgentSetting, type Item, type ItemName, type ProjectRow, type Status } from '../api.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { LoginCard } from '../components/LoginCard.js';
import { OwnerCard } from '../components/OwnerCard.js';
import { SecretCard } from '../components/SecretCard.js';
import { Select } from '../components/Select.js';
import { SettingsCollapse } from '../components/SettingsCollapse.js';
import { ClaudeUsagePanel } from './ClaudeUsage.js';
import { emptyState, panel, row, rowActions, rowId, rows, sectionTitle } from './project-shared.js';

const ROLE_LABELS: Record<string, string> = { sm: 'Scrum Master', po: 'Product Owner', front: 'Front-end', dev: 'Desenvolvedor', test: 'Testes', sec: 'Segurança', devops: 'DevOps', env: 'Ambiente' };
const MODEL_LABELS: Record<AgentModel, string> = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' };
const EFFORT_LABELS: Record<AgentEffort, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', max: 'Máximo' };
const DEFAULT_PICK: AgentSetting = { model: 'claude-sonnet-5-5', effort: 'medium' };
const SAVE_ERROR = 'Não foi possível salvar. Tente novamente.';
const HELP_AGENTS = 'Automático deixa o orquestrador escolher o modelo e o esforço de cada tarefa. Manual fixa os dois para o agente em todos os seus passos, inclusive os de arquitetura. Manual ignora o limite de esforço por modelo e pode gastar mais cota.';
const HELP_ENV = 'Estas conexões valem para todo o Teams AI neste computador. Elas são as mesmas do status do ambiente.';

function AgentLine({ projectId, row: agent, onFailed }: { projectId: string; row: AgentRow; onFailed: () => void }) {
  const label = ROLE_LABELS[agent.role] ?? agent.role;
  const [manual, setManual] = useState(agent.setting !== null);
  const [pick, setPick] = useState<AgentSetting>(agent.setting ?? DEFAULT_PICK);
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
        <Select wrapperClassName="w-[10rem]" aria-label={`Modo de ${label}`} value={manual ? 'manual' : 'auto'} onChange={(e) => changeMode(e.target.value)}>
          <option value="auto">Automático</option>
          <option value="manual">Manual</option>
        </Select>
      </div>
    </li>
  );
}

function EnvironmentSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [organizationOwner, setOrganizationOwner] = useState<string | null>(null);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void api.status().then(setStatus).catch(() => setError('Não foi possível carregar o ambiente.'));
  }, []);
  useEffect(refresh, [refresh]);
  const item = (n: ItemName): Item | null => status?.items[n] ?? null;
  const patch = (n: ItemName) => (it: Item) => {
    setStatus((s) => (s ? { ...s, items: { ...s.items, [n]: it }, allOk: Object.values({ ...s.items, [n]: it }).every((v) => v.ok) } : s));
  };
  const githubLoggedIn = status?.items.ghLogin.ok === true;
  useEffect(() => {
    if (!githubLoggedIn) {
      setOrganizations([]);
      setOrganizationOwner(null);
      setOrganizationsError(null);
      return;
    }
    let active = true;
    setOrganizationsLoading(true);
    setOrganizationsError(null);
    void api.organizations().then((result) => {
      if (!active) return;
      setOrganizations(result.organizations);
      setOrganizationOwner(result.owner);
    }).catch(() => {
      if (active) setOrganizationsError('Não foi possível carregar suas organizações do GitHub.');
    }).finally(() => {
      if (active) setOrganizationsLoading(false);
    });
    return () => { active = false; };
  }, [githubLoggedIn]);

  return (
    <section className={`${panel} gap-3`} aria-labelledby="env-title">
      <div className={sectionTitle}>
        <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="env-title">Ambiente</h2>
        <InfoTip label="Ambiente" text={HELP_ENV} />
      </div>
      <p className="m-0 text-[0.875rem] text-ink-soft">Conexões globais deste computador. Separadas das opções de cada projeto.</p>
      {error ? <p className="error">{error}</p> : null}
      {status === null && !error ? <Loading /> : null}
      {status ? (
        <div>
          <SettingsCollapse title="Login do GitHub CLI" item={item('ghLogin')}>
            <LoginCard cli="gh" title="Login do GitHub CLI" item={item('ghLogin')} onDone={refresh} />
          </SettingsCollapse>
          <SettingsCollapse title="Token do GitHub" item={item('githubToken')}>
            <SecretCard name="GITHUB_TOKEN" title="Token do GitHub" item={item('githubToken')} onSaved={patch('githubToken')} />
          </SettingsCollapse>
          <SettingsCollapse title="Organização do GitHub" item={item('githubOwner')}>
            <OwnerCard organizations={organizations} initialOwner={organizationOwner} loading={organizationsLoading} loadError={organizationsError} item={item('githubOwner')} onSaved={patch('githubOwner')} />
          </SettingsCollapse>
          <SettingsCollapse title="Login do Claude" item={item('claude')}>
            <LoginCard cli="claude" title="Login do Claude" item={item('claude')} onDone={refresh} />
          </SettingsCollapse>
          <SettingsCollapse title="Chave do OpenRouter (Jev)" item={item('openrouterKey')}>
            <SecretCard name="OPENROUTER_API_KEY" title="Chave do OpenRouter (Jev)" item={item('openrouterKey')} onSaved={patch('openrouterKey')} />
          </SettingsCollapse>
        </div>
      ) : null}
    </section>
  );
}

export function SettingsPage() {
  const [projects, setProjects] = useState<Array<Pick<ProjectRow, 'projectId' | 'name'>> | null>(null);
  const [projectId, setProjectId] = useState('');
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const saveFailed = () => {
    setError(SAVE_ERROR);
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    // A project in refinement is listed too, so its agents can be set before it is registered.
    Promise.all([runApi.projects(), refineApi.list().catch(() => [])]).then(([list, drafts]) => {
      const registered = new Set(list.map((p) => p.projectId));
      const inRefinement = [...new Set(drafts.map((d) => d.projectId))].filter((id) => !registered.has(id)).map((projectId) => ({ projectId, name: projectId }));
      const all = [...list, ...inRefinement];
      setProjects(all);
      setProjectId(all[0]?.projectId ?? '');
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
    <main className="grid gap-8">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="m-0 text-ink">Configurações</h1>
          <p className="mt-1 mb-0 text-[0.9375rem] text-ink-soft">Ajuste o ambiente global e o modelo de cada agente por projeto.</p>
        </div>
      </header>
      <EnvironmentSettings />
      <ClaudeUsagePanel />
      {error ? <p className="error">{error}</p> : null}
      {projects === null && !error ? <Loading /> : null}
      {projects?.length === 0 ? (
        <section className={panel} aria-labelledby="agents-title">
          <div className={sectionTitle}>
            <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="agents-title">Projeto</h2>
          </div>
          <div className={emptyState}>
            <p>Nenhum projeto cadastrado.</p>
            <p>Cadastre um projeto para escolher os agentes.</p>
          </div>
        </section>
      ) : null}
      {projects && projects.length > 0 ? (
        <section className={`${panel} gap-3`} aria-labelledby="project-title">
          <div className={sectionTitle}>
            <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="project-title">Projeto</h2>
          </div>
          <label className="grid max-w-[24rem] gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-ink-soft">Projeto</span>
            <Select value={projectId} onChange={(e) => {
              setError(null);
              setProjectId(e.target.value);
            }}>
              {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name || p.projectId}</option>)}
            </Select>
          </label>
          {agents === null ? <Loading /> : (
            <SettingsCollapse
              title="Modelos e esforço"
              meta={(() => {
                const manual = agents.filter((a) => a.setting !== null).length;
                return manual === 0 ? `${agents.length} agentes` : `${manual} ${manual === 1 ? 'manual' : 'manuais'} · ${agents.length} agentes`;
              })()}
            >
              <div className={`${sectionTitle} mb-3`}>
                <h3 className="m-0 flex-[0_1_auto] text-[1rem] font-semibold leading-[1.3]">Agentes</h3>
                <InfoTip label="Agentes" text={HELP_AGENTS} />
              </div>
              <ul className={`${rows} [&>li]:border-accent-line`}>{agents.map((agent) => <AgentLine key={`${projectId}/${agent.role}`} projectId={projectId} row={agent} onFailed={saveFailed} />)}</ul>
            </SettingsCollapse>
          )}
        </section>
      ) : null}
    </main>
  );
}
