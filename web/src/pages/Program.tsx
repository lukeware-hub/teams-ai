import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { refineApi } from '../api.js';
import { Icon } from '../components/Icons.js';
import { ProgramPanel, ProgramStatus, useBacklogTitles, useProgram } from '../refine/ProgramPanel.js';

/** The execution of a started backlog: what runs now, the progress, and every spec with its run. */
export function ProgramPage() {
  const { projectId = '', specId = '' } = useParams();
  const titles = useBacklogTitles(projectId, specId);
  const { program, phases, setProgram } = useProgram(projectId, specId, true);
  const [error, setError] = useState<string | null>(null);
  const prioritize = (itemSpecId: string) => {
    setError(null);
    refineApi.prioritize(projectId, specId, itemSpecId).then((r) => setProgram(r.program), (e: Error) => setError(e.message));
  };
  return (
    <main className="flex flex-col gap-5">
      <header className="refine-breadcrumb"><a href="/projects" aria-label="Voltar para projetos"><Icon name="home" size={18} /><span>Projetos</span></a><span>›</span><strong>{projectId}</strong><span>›</span><Link to={`/refine/${projectId}/${specId}`}>{specId}</Link><span>›</span><span>Execução do backlog</span></header>
      <ProgramStatus program={program} titles={titles} phases={phases} />
      {error && <p className="error" role="alert">{error}</p>}
      {program && <ProgramPanel program={program} titles={titles} onPrioritize={prioritize} />}
    </main>
  );
}
