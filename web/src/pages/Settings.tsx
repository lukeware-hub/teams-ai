import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_EFFORTS, AGENT_MODELS, api, runApi, settingsApi, type AgentChoice, type AgentEffort, type AgentModel, type AgentRow, type AgentSetting, type AutomaticModels, type Item, type ItemName, type ProjectRow, type Status } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { LoginCard } from '../components/LoginCard.js';
import { OwnerCard } from '../components/OwnerCard.js';
import { SecretCard } from '../components/SecretCard.js';
import { Select } from '../components/Select.js';
import { SettingsCollapse } from '../components/SettingsCollapse.js';
import { ClaudeUsagePanel } from './ClaudeUsage.js';
import { emptyState, panel, row, rowActions, rowId, rows, sectionTitle } from './project-shared.js';

const ROLE_LABELS: Record<string, string> = { sm: 'Scrum Master', po: 'Product Owner', front: 'Front-end', dev: 'Desenvolvedor', test: 'Testes', sec: 'Segurança', devops: 'DevOps', env: 'Ambiente', chat: 'Chat', graphify: 'Graphify' };
/** The chat and graphify settings: a model and effort fixed in Settings, never automatic. */
const SLOT_ROLES = ['chat', 'graphify'];
const MODEL_LABELS: Record<AgentModel, string> = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' };
const EFFORT_LABELS: Record<AgentEffort, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', max: 'Máximo' };
const DEFAULT_PICK: AgentSetting = { model: 'claude-haiku-5-5', effort: 'low' };
const SAVE_ERROR = 'Não foi possível salvar. Tente novamente.';
const HELP_AGENTS = 'Automático deixa o orquestrador escolher o modelo e o esforço de cada tarefa. Manual fixa os dois para o agente em todos os seus passos, inclusive os de arquitetura. Manual ignora o limite de esforço por modelo e pode gastar mais cota. Chat e Graphify sempre usam o modelo e o esforço escolhidos aqui.';
const HELP_ENV = 'Estas conexões valem para todo o Teams AI neste computador. Elas são as mesmas do status do ambiente.';
const HELP_TIMEOUT = 'Tempo máximo que cada passo de um agente pode levar neste projeto. Passado esse tempo, o passo para e a revisão pede para reavaliar. Vale para o refinamento e para as execuções.';
const TIMEOUT_LOAD_ERROR = 'Não foi possível carregar o tempo limite.';
const HELP_PLAN_AGENTS = 'Quantos agentes escrevem os planos dos itens do backlog ao mesmo tempo. Vale a partir da próxima preparação. Vai de 1 a 5.';
const PLAN_AGENTS_LOAD_ERROR = 'Não foi possível carregar os agentes em paralelo.';
const HELP_AGENTS_DECIDE = 'Não: uma tarefa bloqueada fica parada até você decidir. Sim: os agentes decidem sozinhos as escolhas técnicas e de negócio, pesquisam na internet e executam comandos de shell neste projeto, com rede no shell só para pacotes e pesquisa na web livre. Com Sim, o botão Reprocessar não aparece na execução.';
const AGENTS_DECIDE_LOAD_ERROR = 'Não foi possível carregar a autonomia dos agentes.';
const HELP_AUTOMATIC = 'Modelos que os papéis em Automático usam, em todos os projetos deste computador. Tarefa pequena, média e grande seguem o tamanho de cada tarefa. Arquitetura são os passos de tech-spec, plano e arquitetura. Refinamento, ciclos seguintes são os passos de refinamento a partir do segundo ciclo. Cada escolha salva ao mudar.';
const AUTOMATIC_LOAD_ERROR = 'Não foi possível carregar os modelos automáticos.';
type AutomaticKey = 'small' | 'medium' | 'large' | 'architecture' | 'laterCycle';
const AUTOMATIC_ROWS: Array<{ key: AutomaticKey; label: string }> = [
  { key: 'small', label: 'Tarefa pequena' },
  { key: 'medium', label: 'Tarefa média' },
  { key: 'large', label: 'Tarefa grande' },
  { key: 'architecture', label: 'Arquitetura' },
  { key: 'laterCycle', label: 'Refinamento, ciclos seguintes' },
];
const modelOfRow = (models: AutomaticModels, key: AutomaticKey): AgentModel => (key === 'architecture' || key === 'laterCycle' ? models[key] : models.tiers[key]);
const withModel = (models: AutomaticModels, key: AutomaticKey, model: AgentModel): AutomaticModels => {
  if (key === 'architecture') return { ...models, architecture: model };
  if (key === 'laterCycle') return { ...models, laterCycle: model };
  return { ...models, tiers: { ...models.tiers, [key]: model } };
};

function AgentLine({ projectId, row: agent, onFailed }: { projectId: string; row: AgentRow; onFailed: () => void }) {
  const label = ROLE_LABELS[agent.role] ?? agent.role;
  const hasAutomatic = !SLOT_ROLES.includes(agent.role);
  const settingText = (s: AgentSetting) => `${MODEL_LABELS[s.model]} · ${EFFORT_LABELS[s.effort]}`;
  const [manual, setManual] = useState(agent.setting !== null);
  const [pick, setPick] = useState<AgentSetting>(agent.setting ?? DEFAULT_PICK);
  const [inUse, setInUse] = useState<AgentSetting>(agent.inUse);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (choice: AgentChoice) => {
    queue.current = queue.current.then(() => settingsApi.setAgent(projectId, agent.role, choice)).then((r) => setInUse(r.inUse)).catch(onFailed);
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
    <li className={row} data-testid={`settings-agent-${agent.role}`}>
      <span className={rowId} data-testid={`settings-agent-label-${agent.role}`}>{label}</span>
      <div className="grid gap-0.5 text-[0.8125rem] text-ink-soft" data-testid={`settings-agent-details-${agent.role}`}>
        <span data-testid={`settings-agent-pick-${agent.role}`}>{manual ? settingText(pick) : 'Orquestrador escolhe'}</span>
        <span data-testid={`in-use-${agent.role}`}>{`Em uso agora: ${settingText(inUse)}`}</span>
      </div>
      <div className={`${rowActions} max-md:flex-col max-md:gap-3`} data-testid={`settings-agent-actions-${agent.role}`}>
        {manual ? (
          <>
            <Select wrapperClassName="w-full md:w-[8.5rem]" aria-label={`Modelo de ${label}`} value={pick.model} onChange={(e) => changePick({ ...pick, model: e.target.value as AgentModel })}>
              {AGENT_MODELS.map((m) => <option key={m} value={m} data-testid={`settings-agent-model-option-${agent.role}-${m}`}>{MODEL_LABELS[m]}</option>)}
            </Select>
            <Select wrapperClassName="w-full md:w-[8.5rem]" aria-label={`Esforço de ${label}`} value={pick.effort} onChange={(e) => changePick({ ...pick, effort: e.target.value as AgentEffort })}>
              {AGENT_EFFORTS.map((e) => <option key={e} value={e} data-testid={`settings-agent-effort-option-${agent.role}-${e}`}>{EFFORT_LABELS[e]}</option>)}
            </Select>
          </>
        ) : null}
        {hasAutomatic ? (
          <Select wrapperClassName="w-full md:w-[8.5rem]" aria-label={`Modo de ${label}`} value={manual ? 'manual' : 'auto'} onChange={(e) => changeMode(e.target.value)}>
            <option value="auto" data-testid={`settings-agent-mode-auto-${agent.role}`}>Automático</option>
            <option value="manual" data-testid={`settings-agent-mode-manual-${agent.role}`}>Manual</option>
          </Select>
        ) : (
          <span aria-hidden="true" className="hidden md:block md:w-[8.5rem]" data-testid={`settings-agent-spacer-${agent.role}`} />
        )}
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
    <section className={`${panel} gap-3`} aria-labelledby="env-title" data-testid="settings-env-section">
      <div className={sectionTitle} data-testid="settings-env-title-row">
        <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="env-title" data-testid="settings-env-title">Configuração Global do Ambiente</h2>
        <InfoTip label="Configuração Global do Ambiente" text={HELP_ENV} />
      </div>
      <p className="m-0 text-[0.875rem] text-ink-soft" data-testid="settings-env-hint">Conexões globais deste computador. Separadas das opções de cada projeto.</p>
      {error ? <p className="error" data-testid="settings-env-error">{error}</p> : null}
      {status === null && !error ? <Loading /> : null}
      {status ? (
        <div data-testid="settings-env-list">
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
      <SettingsCollapse title="Configura para Refinamento">
        <PlanAgentsPanel />
      </SettingsCollapse>
    </section>
  );
}

function StepTimeoutCard({ projectId }: { projectId: string }) {
  const [minutes, setMinutes] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    settingsApi.stepTimeout(projectId).then((r) => {
      if (!active) return;
      setSaved(r.timeoutMinutes);
      setMinutes(String(r.timeoutMinutes));
    }).catch(() => {
      if (active) setError(TIMEOUT_LOAD_ERROR);
    });
    return () => {
      active = false;
    };
  }, [projectId]);
  const value = Number(minutes);
  const valid = Number.isInteger(value) && value >= 1;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await settingsApi.setStepTimeout(projectId, value);
      setSaved(r.timeoutMinutes);
      setMinutes(String(r.timeoutMinutes));
    } catch {
      setError(SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className={`${sectionTitle} mb-3`} data-testid="settings-timeout-title-row">
        <h3 className="m-0 flex-[0_1_auto] text-[1rem] font-semibold leading-[1.3]" data-testid="settings-timeout-title">Minutos por passo</h3>
        <InfoTip label="Tempo limite" text={HELP_TIMEOUT} />
      </div>
      <form
        className="grid max-w-[24rem] grid-cols-[minmax(0,1fr)_auto] items-end gap-[0.7rem]"
        data-testid="settings-timeout-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input className="w-full min-w-0" data-testid="settings-timeout-input" aria-label="Minutos por passo" type="number" min={1} step={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <ActionButton type="submit" className="primary-button" busy={busy} disabled={!valid || value === saved} icon={<Icon name="check" size={16} />}>
          Salvar
        </ActionButton>
      </form>
      {error ? <p className="error" data-testid="settings-timeout-error">{error}</p> : null}
    </>
  );
}

function AgentsDecideCard({ projectId }: { projectId: string }) {
  const [decide, setDecide] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    settingsApi.agentsDecide(projectId).then((r) => {
      if (active) setDecide(r.agentsDecide);
    }).catch(() => {
      if (active) setError(AGENTS_DECIDE_LOAD_ERROR);
    });
    return () => {
      active = false;
    };
  }, [projectId]);
  const save = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await settingsApi.setAgentsDecide(projectId, next);
      setDecide(r.agentsDecide);
    } catch {
      setError(SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  };
  if (decide === null) return error ? <p className="error" data-testid="settings-decide-load-error">{error}</p> : <Loading />;
  return (
    <>
      <div className={`${sectionTitle} mb-3`} data-testid="settings-decide-title-row">
        <h3 className="m-0 flex-[0_1_auto] text-[1rem] font-semibold leading-[1.3]" data-testid="settings-decide-title">Autorizo os agentes a tomar decisões?</h3>
        <InfoTip label="Autonomia dos agentes" text={HELP_AGENTS_DECIDE} />
      </div>
      <Select wrapperClassName="w-full max-w-[12rem]" aria-label="Autorizo os agentes a tomar decisões?" value={decide ? 'yes' : 'no'} disabled={busy} onChange={(e) => void save(e.target.value === 'yes')}>
        <option value="no" data-testid="settings-decide-option-no">Não</option>
        <option value="yes" data-testid="settings-decide-option-yes">Sim</option>
      </Select>
      {error ? <p className="error" data-testid="settings-decide-error">{error}</p> : null}
    </>
  );
}

function PlanAgentsPanel() {
  const [minAgents, setMinAgents] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    settingsApi.planAgents().then((r) => {
      if (!active) return;
      setSaved(r.agents);
      setMinAgents(String(r.agents));
    }).catch(() => {
      if (active) setError(PLAN_AGENTS_LOAD_ERROR);
    });
    return () => {
      active = false;
    };
  }, []);
  const value = Number(minAgents);
  const valid = Number.isInteger(value) && value >= 1 && value <= 5;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await settingsApi.setPlanAgents(value);
      setSaved(r.agents);
      setMinAgents(String(r.agents));
    } catch {
      setError(SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className={`${sectionTitle} mb-3`} data-testid="settings-plan-title-row">
        <h3 className="m-0 flex-[0_1_auto] text-[1rem] font-semibold leading-[1.3]" data-testid="settings-plan-title">Agentes em paralelo</h3>
        <InfoTip label="Agentes em paralelo" text={HELP_PLAN_AGENTS} />
      </div>
      <form
        className="grid max-w-[24rem] grid-cols-[minmax(0,1fr)_auto] items-end gap-[0.7rem]"
        data-testid="settings-plan-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="grid gap-1.5" data-testid="settings-plan-field">
          <span className="text-[0.8125rem] font-semibold text-ink-soft" data-testid="settings-plan-label">Quantidade de agentes</span>
          <input className="w-full min-w-0" data-testid="settings-plan-input" type="number" min={1} max={5} step={1} value={minAgents} onChange={(e) => setMinAgents(e.target.value)} />
        </label>
        <ActionButton type="submit" className="primary-button" busy={busy} disabled={!valid || value === saved} icon={<Icon name="check" size={16} />}>
          Salvar
        </ActionButton>
      </form>
      {error ? <p className="error" data-testid="settings-plan-error">{error}</p> : null}
    </>
  );
}

function AutomaticModelsCard() {
  const [models, setModels] = useState<AutomaticModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    settingsApi.automatic().then((r) => {
      if (active) setModels(r);
    }).catch(() => {
      if (active) setError(AUTOMATIC_LOAD_ERROR);
    });
    return () => {
      active = false;
    };
  }, []);
  const change = (key: AutomaticKey, model: AgentModel) => {
    if (!models) return;
    const next = withModel(models, key, model);
    setModels(next);
    setError(null);
    queue.current = queue.current.then(() => settingsApi.setAutomatic(next)).then(setModels).catch(() => {
      setError(SAVE_ERROR);
      void settingsApi.automatic().then(setModels).catch(() => undefined);
    });
  };
  return (
    <section className={`${panel} gap-3`} aria-labelledby="automatic-title" data-testid="settings-automatic-section">
      <div className={sectionTitle} data-testid="settings-automatic-title-row">
        <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="automatic-title" data-testid="settings-automatic-title">Modelos automáticos</h2>
        <InfoTip label="Modelos automáticos" text={HELP_AUTOMATIC} />
      </div>
      {error ? <p className="error" data-testid="settings-automatic-error">{error}</p> : null}
      {models === null && !error ? <Loading /> : null}
      {models ? (
        <ul className={`${rows} [&>li]:border-accent-line`} data-testid="settings-automatic-list">
          {AUTOMATIC_ROWS.map(({ key, label }) => (
            <li key={key} className={row} data-testid={`settings-automatic-${key}`}>
              <span className={rowId}>{label}</span>
              <div className={rowActions}>
                <Select wrapperClassName="w-full md:w-[10rem]" aria-label={label} value={modelOfRow(models, key)} onChange={(e) => change(key, e.target.value as AgentModel)}>
                  {AGENT_MODELS.map((m) => <option key={m} value={m}>{MODEL_LABELS[m]}</option>)}
                </Select>
              </div>
            </li>
          ))}
        </ul>
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
    <main className="grid gap-8" data-testid="settings-main">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4" data-testid="settings-header">
        <div className="min-w-0 flex-[1_1_20rem]" data-testid="settings-title-block">
          <h1 className="m-0 text-ink" data-testid="settings-title">Configurações</h1>
          <p className="mt-1 mb-0 text-[0.9375rem] text-ink-soft" data-testid="settings-subtitle">Ajuste o ambiente global e o modelo de cada agente por projeto.</p>
        </div>
      </header>
      <ClaudeUsagePanel />
      {error ? <p className="error" data-testid="settings-error">{error}</p> : null}
      {projects === null && !error ? <Loading /> : null}
      {projects?.length === 0 ? (
        <section className={panel} aria-labelledby="agents-title" data-testid="settings-empty-section">
          <div className={sectionTitle} data-testid="settings-empty-title-row">
            <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="agents-title" data-testid="settings-empty-title">Configurações por Projetos</h2>
          </div>
          <div className={emptyState} data-testid="settings-empty">
            <p data-testid="settings-empty-text">Nenhum projeto cadastrado.</p>
            <p data-testid="settings-empty-hint">Cadastre um projeto para escolher os agentes.</p>
          </div>
        </section>
      ) : null}
      {projects && projects.length > 0 ? (
        <section className={`${panel} gap-3`} aria-labelledby="project-title" data-testid="settings-project-section">
          <div className={sectionTitle} data-testid="settings-project-title-row">
            <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="project-title" data-testid="settings-project-title">Configurações por Projetos</h2>
          </div>
          <label className="grid max-w-[24rem] gap-1.5" data-testid="settings-project-field">
            <span className="text-[0.8125rem] font-semibold text-ink-soft" data-testid="settings-project-label">Projeto</span>
            <Select value={projectId} onChange={(e) => {
              setError(null);
              setProjectId(e.target.value);
            }}>
              {projects.map((p) => <option key={p.projectId} value={p.projectId} data-testid={`settings-project-option-${p.projectId}`}>{p.name || p.projectId}</option>)}
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
              <div className={`${sectionTitle} mb-3`} data-testid="settings-agents-title-row">
                <h3 className="m-0 flex-[0_1_auto] text-[1rem] font-semibold leading-[1.3]" data-testid="settings-agents-title">Agentes</h3>
                <InfoTip label="Agentes" text={HELP_AGENTS} />
              </div>
              <ul className={`${rows} [&>li]:border-accent-line`} data-testid="settings-agents-list">{agents.map((agent) => <AgentLine key={`${projectId}/${agent.role}`} projectId={projectId} row={agent} onFailed={saveFailed} />)}</ul>
            </SettingsCollapse>
          )}
          <SettingsCollapse title="Tempo limite">
            <StepTimeoutCard key={projectId} projectId={projectId} />
          </SettingsCollapse>
          <SettingsCollapse title="Autonomia dos agentes">
            <AgentsDecideCard key={projectId} projectId={projectId} />
          </SettingsCollapse>
        </section>
      ) : null}
      <AutomaticModelsCard />
      <EnvironmentSettings />
    </main>
  );
}
