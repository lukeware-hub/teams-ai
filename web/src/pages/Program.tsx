import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { refineApi } from '../api.js';
import { Icon } from '../components/Icons.js';
import { DecisionTimeline, useDecisions } from '../refine/DecisionTimeline.js';
import { ProgramPanel, ProgramStatus, useBacklogTitles, useProgram } from '../refine/ProgramPanel.js';

/** The execution of a started backlog: what runs now, the progress, and every spec with its run. */
export function ProgramPage() {
  const { projectId = '', specId = '' } = useParams();
  const titles = useBacklogTitles(projectId, specId);
  const { program, phases, setProgram } = useProgram(projectId, specId, true);
  const { decisions, unanswered } = useDecisions(projectId, specId, program?.status !== 'finished');
  const [error, setError] = useState<string | null>(null);
  const prioritize = (itemSpecId: string) => {
    setError(null);
    return refineApi.prioritize(projectId, specId, itemSpecId).then((r) => setProgram(r.program), (e: Error) => setError(e.message));
  };
  return (
    <main className="flex flex-col gap-5" data-testid="program-page">
      <header className="refine-breadcrumb" data-testid="program-breadcrumb"><Link to="/projects" aria-label="Voltar para projetos"><Icon name="home" size={18} /><span data-testid="program-breadcrumb-home-label">Projetos</span></Link><span data-testid="program-breadcrumb-separator-projects">›</span><strong data-testid="program-breadcrumb-project">{projectId}</strong><span data-testid="program-breadcrumb-separator-project">›</span><Link to={`/refine/${projectId}/${specId}`}>{specId}</Link><span data-testid="program-breadcrumb-separator-spec">›</span><span data-testid="program-breadcrumb-current">Execução do backlog</span></header>
      <ProgramStatus program={program} titles={titles} phases={phases} />
      {error && <p className="error" role="alert" data-testid="program-error">{error}</p>}
      {program && <ProgramPanel program={program} titles={titles} onPrioritize={prioritize} />}
      {program && <DecisionTimeline decisions={decisions} unanswered={unanswered} titles={titles} />}
    </main>
  );
}
