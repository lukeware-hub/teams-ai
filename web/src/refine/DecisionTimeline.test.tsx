import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProgramDecision } from '../api.js';
import { DecisionTimeline } from './DecisionTimeline.js';

const d = (over: Partial<ProgramDecision>): ProgramDecision => ({ at: '2026-10-13T12:00:00.000Z', key: 'a', runId: 'r1', decisionId: 'model-tier', backend: 'jev', escalated: false, answers: [], ...over });

describe('DecisionTimeline', () => {
  it('says who answered, whether it escalated, and each question with its value and confidence', () => {
    render(<DecisionTimeline titles={{ a: 'Cadastro' }} decisions={[
      d({ answers: [{ question: 'tier', value: 'large', confidence: 0.91 }] }),
      d({ decisionId: 'failure-cause', backend: 'claude', escalated: true, answers: [{ question: 'cause', value: 'code', confidence: null }, { question: 'effort', value: 1.2345, confidence: 0.5 }] }),
      d({ decisionId: 'pr-risk', backend: null }),
    ]} />);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toMatch(/model-tier.*Jev.*Cadastro.*tier: large \(91%\)/);
    expect(items[1]).toMatch(/failure-cause.*Claude \(escalada\).*cause: code · effort: 1\.23 \(50%\)/);
    expect(items[2]).toMatch(/pr-risk.*sem resposta/);
  });

  it('says so when no decision was recorded', () => {
    render(<DecisionTimeline titles={{}} decisions={[]} />);
    expect(screen.getByText('Nenhuma decisão registrada ainda.')).toBeTruthy();
  });
});
