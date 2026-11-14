import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { runApi, type RepoDashboard, type ServiceStatus } from '../api.js';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { projectPath, repoPath } from '../routes.js';
import { usePolling } from '../usePolling.js';
import { GrpcPanel } from './repository/GrpcPanel.js';
import { addressOf } from './repository/labels.js';
import { panel } from './project-shared.js';

const PROBE_MS = 5000;

/** The gRPC methods of a repository's deployed service, to read and to call: the screen "Abrir gRPC" opens. */
export function GrpcPage() {
  const { projectId = '', repoId = '' } = useParams<{ projectId: string; repoId: string }>();
  const [dashboard, setDashboard] = useState<RepoDashboard | null | undefined>(undefined);
  const [probe, setProbe] = useState<ServiceStatus | null>(null);

  useEffect(() => {
    setDashboard(undefined);
    runApi.repositoryDashboard(projectId, repoId).then(setDashboard, () => setDashboard(null));
  }, [projectId, repoId]);

  const runId = dashboard?.lastDeploy?.runId ?? null;
  const checkProbe = useCallback(() => (runId ? runApi.serviceStatus(runId).then(setProbe, () => setProbe(null)) : Promise.resolve()), [runId]);
  useEffect(() => {
    setProbe(null);
    void checkProbe();
  }, [checkProbe]);
  usePolling(checkProbe, PROBE_MS);

  const url = dashboard?.lastDeploy ? addressOf(repoId, dashboard.lastDeploy).url : null;
  const target = url ? url.replace(/^https?:\/\//, '') : null;

  return (
    <div className="grid min-w-0 gap-4" data-testid="grpc-page">
      <Breadcrumb
        testId="grpc-breadcrumb"
        trail={[
          { label: projectId, to: projectPath(projectId), testId: 'grpc-breadcrumb-project' },
          { label: repoId, to: repoPath(projectId, repoId), testId: 'grpc-breadcrumb-repo' },
          { label: 'gRPC', testId: 'grpc-breadcrumb-current' },
        ]}
      />
      {dashboard === undefined && <p data-testid="grpc-loading" className="hint" role="status">Carregando o repositório…</p>}
      {dashboard !== undefined && !target && (
        <section className={panel} data-testid="grpc-no-deploy">
          <h1 className="m-0 text-[1.25rem] font-semibold">Endpoints gRPC</h1>
          <p className="hint">{dashboard === null ? 'sem dados: o repositório não pôde ser lido.' : 'Este repositório ainda não tem um deploy verificado com endereço publicado.'}</p>
          <Link to={repoPath(projectId, repoId)}>Voltar ao repositório</Link>
        </section>
      )}
      {target && (
        <>
          <header data-testid="grpc-header" className={`${panel} gap-2 max-md:px-3 max-md:py-3`}>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="m-0 text-[1.25rem] font-semibold wrap-anywhere max-md:text-[1.0625rem]">Endpoints gRPC</h1>
              <span className="count-pill">{repoId}</span>
              {probe && <span data-testid="grpc-status" className={`status-pill tone-${probe.online ? 'good' : 'bad'} md:ml-auto`}>{probe.online ? 'No ar' : 'Fora do ar'}</span>}
            </div>
            <p className="hint m-0 text-[0.875rem] hyphens-none max-md:text-[0.8125rem]">
              <span className="max-md:hidden">Lista os métodos do serviço e chama cada um. </span>Destino <code data-testid="grpc-target">{target}</code>
              {probe && !probe.online ? '. Use Iniciar no painel do repositório.' : ''}
            </p>
          </header>
          <GrpcPanel projectId={projectId} repo={repoId} target={target} />
        </>
      )}
    </div>
  );
}
