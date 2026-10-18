import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../api.js';
import { runningStepLabel, runningSteps } from './running-steps.js';

const event = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq, at: '2026-10-18T00:00:00Z', runId: 'r', specHash: 'h', type, kind: 'fact', data } as unknown as StoredEvent);

describe('runningSteps', () => {
  it('lists the steps of the round that started and have no finish event', () => {
    const events = [
      event(1, 'STEP_STARTED', { stepId: 's1', kind: 'refine', role: 'po', model: 'claude-haiku-5-5', effort: 'medium', attempt: 2 }),
      event(2, 'STEP_STARTED', { stepId: 's2', kind: 'refine', role: 'sm', model: 'claude-haiku-5-5', effort: 'medium', attempt: 2 }),
      event(3, 'STEP_FINISHED', { stepId: 's1', attempt: 2 }),
    ];
    expect(runningSteps(events, 2)).toEqual([{ stepId: 's2', kind: 'refine', role: 'sm', model: 'claude-haiku-5-5', effort: 'medium' }]);
  });

  it('ignores the steps of other rounds', () => {
    const events = [event(1, 'STEP_STARTED', { stepId: 's1', kind: 'refine', role: 'po', model: 'claude-haiku-5-5', effort: 'medium', attempt: 1 })];
    expect(runningSteps(events, 2)).toEqual([]);
  });

  it('leaves the effort out when the event has none', () => {
    const events = [event(1, 'STEP_STARTED', { stepId: 's1', kind: 'refine', role: 'po', model: 'claude-haiku-5-5', attempt: 1 })];
    expect(runningSteps(events, 1)).toEqual([{ stepId: 's1', kind: 'refine', role: 'po', model: 'claude-haiku-5-5' }]);
  });
});

describe('runningStepLabel', () => {
  it('names the role, the model and the effort in Portuguese', () => {
    expect(runningStepLabel({ stepId: 's', kind: 'refine', role: 'front', model: 'claude-haiku-5-5', effort: 'max' })).toBe('Front · Haiku 5.5 · esforço máximo');
  });

  it('shows the model id and the effort as they are when they are unknown', () => {
    expect(runningStepLabel({ stepId: 's', kind: 'refine', role: 'qa', model: 'gpt-x', effort: 'turbo' })).toBe('qa · gpt-x · esforço turbo');
  });

  it('says so when the effort was not recorded', () => {
    expect(runningStepLabel({ stepId: 's', kind: 'refine', role: 'po', model: 'claude-sonnet-5-5' })).toBe('PO · Sonnet 5.5 · esforço não registrado');
  });
});
