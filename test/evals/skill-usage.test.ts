import { describe, expect, it } from 'vitest';
import { skillUsage } from '../../scripts/evals/skill-usage.js';
import { skillClause } from '../../server/refine/superpowers-pack.js';

const finished = (kind: string, skills?: Record<string, number>) => ({ type: 'STEP_FINISHED', data: { kind, ...(skills === undefined ? {} : { profile: { skills } }) } });

describe('skill usage report', () => {
  it('counts per kind the steps that called the skill, a failed call included', () => {
    const report = skillUsage(
      [finished('speckit', { 'impeccable': 1 }), finished('speckit', {}), finished('speckit'), finished('review', { impeccable: 2 }), { type: 'OTHER', data: {} }],
      'impeccable',
    );
    expect(report).toEqual({
      speckit: { steps: 3, loaded: 1, rate: 1 / 3 },
      review: { steps: 1, loaded: 1, rate: 1 },
    });
  });

  it('reports no rate for a kind that had no step', () => {
    expect(skillUsage([], 'impeccable')).toEqual({});
  });
});

describe('skill clause', () => {
  it('tells the step to load the skill and never to stop to ask', () => {
    const clause = skillClause('superpowers:writing-plans');
    expect(clause).toContain('Load the skill superpowers:writing-plans with the Skill tool');
    expect(clause).toContain('never stop to ask a question');
  });
});
