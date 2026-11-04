import { useState } from 'react';
import { refineApi } from '../api.js';
import { DecisionTimeline, useDecisions } from './DecisionTimeline.js';
import { ProgramPanel, useBacklogTitles, useProgram } from './ProgramPanel.js';

/** A running backlog followed on the project page: status, every spec with its run, and the decisions; nothing once it finished. */
export function BacklogExecution({ projectId, specId }: { projectId: string; specId: string }) {
  const titles = useBacklogTitles(projectId, specId);
  const { program, phases, setProgram } = useProgram(projectId, specId, true);
  const { decisions, unanswered } = useDecisions(projectId, specId, program?.status !== 'finished');
  const [error, setError] = useState<string | null>(null);
  if (!program || program.status === 'finished') return null;
  const prioritize = (itemSpecId: string) => {
    setError(null);
    return refineApi.prioritize(projectId, specId, itemSpecId).then((r) => setProgram(r.program), (e: Error) => setError(e.message));
  };
  return (
    <div className="grid gap-5" data-testid={`backlog-execution-${specId}`}>
      {error && <p className="error" role="alert" data-testid="program-error">{error}</p>}
      <ProgramPanel program={program} titles={titles} phases={phases} onPrioritize={prioritize} />
      <DecisionTimeline decisions={decisions} unanswered={unanswered} titles={titles} />
    </div>
  );
}
