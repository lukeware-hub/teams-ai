import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { refineApi } from '../api.js';
import { Icon } from '../components/Icons.js';
import { ProgramPanel, ProgramStatus, useProgram } from '../refine/ProgramPanel.js';
import './refine.css';

/** The execution of a started backlog: what runs now, the progress, and every spec with its run. */
export function ProgramPage() {
  const { projectId = '', specId = '' } = useParams();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const { program, phases, setProgram } = useProgram(projectId, specId, true);
  const [error, setError] = useState<string | null>(null);
  const prioritize = (itemSpecId: string) => {
    setError(null);
    refineApi.prioritize(projectId, specId, itemSpecId).then((r) => setProgram(r.program), (e: Error) => setError(e.message));
  };
  useEffect(() => {
    refineApi.snapshot(projectId, specId).then((s) => setTitles(Object.fromEntries((s.state.backlog?.items ?? []).map((i) => [i.key, i.title])))).catch(() => undefined);
  }, [projectId, specId]);
  return (
    <main className="refine-page">
      <header className="refine-breadcrumb"><a href="/projects" aria-label="Voltar para projetos"><Icon name="home" size={18} /><span>Projetos</span></a><span>›</span><strong>{projectId}</strong><span>›</span><Link to={`/refine/${projectId}/${specId}`}>{specId}</Link><span>›</span><span>Execução do backlog</span></header>
      <ProgramStatus program={program} titles={titles} phases={phases} />
      {error && <p className="error" role="alert">{error}</p>}
      {program && <section className="panel-card"><ProgramPanel program={program} titles={titles} onPrioritize={prioritize} /></section>}
    </main>
  );
}
