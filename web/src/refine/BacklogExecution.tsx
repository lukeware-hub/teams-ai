import { useEffect, useState } from 'react';
import { refineApi, runApi } from '../api.js';
import { DecisionTimeline, useDecisions } from './DecisionTimeline.js';
import { ProgramPanel, useBacklogTitles, useProgram } from './ProgramPanel.js';

/** A running backlog followed on the project page: status, every spec with its run, and the decisions; nothing once it finished. */
export function BacklogExecution({ projectId, specId, onRunning }: { projectId: string; specId: string; /** Told when this backlog starts or stops showing, so the page can drop what the panel already lists. */ onRunning?: (specId: string, running: boolean) => void }) {
  const titles = useBacklogTitles(projectId, specId);
  const { program, phases, setProgram } = useProgram(projectId, specId, true);
  const { decisions, unanswered } = useDecisions(projectId, specId, program?.status !== 'finished');
  const [error, setError] = useState<string | null>(null);
  const shown = program !== null && program.status !== 'finished';
  useEffect(() => {
    onRunning?.(specId, shown);
    return () => onRunning?.(specId, false);
  }, [shown, specId]);
  if (!program || !shown) return null;
  const prioritize = (itemSpecId: string) => {
    setError(null);
    return refineApi.prioritize(projectId, specId, itemSpecId).then((r) => setProgram(r.program), (e: Error) => setError(e.message));
  };
  // The next poll shows the outcome; a refused action says why.
  const onRun = (go: (runId: string) => Promise<unknown>) => (runId: string) => {
    setError(null);
    return go(runId).then(() => refineApi.program(projectId, specId)).then((r) => setProgram(r.program), (e: Error) => setError(e.message));
  };
  const stoppedRun = { resume: onRun(runApi.resumeRun), restart: onRun(runApi.restartRun), cancel: onRun(runApi.cancelRun) };
  return (
    <div className="grid gap-5" data-testid={`backlog-execution-${specId}`}>
      {error && <p className="error" role="alert" data-testid="program-error">{error}</p>}
      <ProgramPanel program={program} titles={titles} phases={phases} unanswered={unanswered} onPrioritize={prioritize} onStoppedRun={stoppedRun} />
      {decisions.length > 0 && <DecisionTimeline decisions={decisions} titles={titles} />}
    </div>
  );
}
