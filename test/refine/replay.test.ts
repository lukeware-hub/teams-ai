import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEvents } from '../../server/store/event-store.js';
import { reduceRefineEvents } from '../../server/refine/state.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'refine', 'live-journal.ndjson');

describe('replay of a live refinement journal', () => {
  it('reduces a journal written by a live run to the same state it had when recorded', async () => {
    const state = reduceRefineEvents(await loadEvents(FIXTURE));
    expect({
      status: state.status,
      mode: state.mode,
      cycle: state.cycle,
      stages: state.stages,
      repositories: state.repositories ?? null,
      doneStages: state.doneStages,
      graphed: state.graphed,
      backlogEnabled: state.backlog?.enabled ?? null,
      architectureStyle: state.architecture?.decision.style ?? null,
      pendingBlocking: state.questions.filter((q) => q.status === 'pending' && q.blocking).length,
    }).toMatchSnapshot();
  });
});
