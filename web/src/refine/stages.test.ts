import { describe, expect, it } from 'vitest';
import { stageAction, stageOf, stageTitle, type StageInput } from './stages.js';

const base: StageInput = { status: 'drafting', stale: false, backlog: null };
const outline = { enabled: true, detail: false, items: [{}] };
const detailed = { enabled: true, detail: true, items: [{}] };
const blocking = { status: 'pending', blocking: true };
const optional = { status: 'pending', blocking: false };
const states = (input: StageInput) => stageOf(input).map((s) => s.state);

describe('stageOf', () => {
  it('starts on the documents while they are not ready', () => {
    expect(states(base)).toEqual(['active', 'todo', 'todo']);
  });

  it('asks for the backlog once the documents are ready and nothing is stale', () => {
    expect(states({ ...base, status: 'ready' })).toEqual(['done', 'active', 'todo']);
  });

  it('keeps the backlog active while it is outlined, detailed or waits for an answer', () => {
    expect(states({ status: 'ready', stale: false, backlog: outline })).toEqual(['done', 'active', 'todo']);
    expect(states({ status: 'drafting', stale: false, backlog: detailed })).toEqual(['done', 'active', 'todo']);
    expect(states({ status: 'answering', stale: false, backlog: outline })).toEqual(['done', 'active', 'todo']);
  });

  it('keeps the backlog active after the documents changed under it', () => {
    expect(states({ status: 'ready', stale: true, backlog: detailed })).toEqual(['done', 'active', 'todo']);
  });

  it('completes the backlog when every item is detailed and covered, and then execution is next', () => {
    expect(states({ status: 'ready', stale: false, backlog: detailed })).toEqual(['done', 'done', 'active']);
  });

  it('marks execution done once the program has started', () => {
    expect(states({ status: 'started', stale: false, backlog: detailed })).toEqual(['done', 'done', 'done']);
  });
});

describe('stageAction', () => {
  it('evaluates the documents until they are ready and fresh', () => {
    expect(stageAction(base)).toBe('evaluate');
    expect(stageAction({ ...base, status: 'error' })).toBe('evaluate');
    expect(stageAction({ ...base, status: 'evaluating' })).toBe('evaluate');
    expect(stageAction({ ...base, status: 'ready', stale: true })).toBe('evaluate');
  });

  it('evaluates again while the documents are ready but the backlog is not detailed yet', () => {
    expect(stageAction({ ...base, status: 'ready' })).toBe('evaluate');
    expect(stageAction({ status: 'ready', stale: false, backlog: outline })).toBe('evaluate');
  });

  it('evaluates again while the backlog is outlined or detailed, and after it stopped', () => {
    expect(stageAction({ status: 'evaluating', stale: false, backlog: detailed })).toBe('evaluate');
    expect(stageAction({ status: 'ready', stale: true, backlog: detailed })).toBe('evaluate');
    expect(stageAction({ status: 'error', stale: false, backlog: outline })).toBe('evaluate');
    expect(stageAction({ status: 'answering', stale: false, backlog: outline, questions: [optional] })).toBe('evaluate');
    expect(stageAction({ status: 'answering', stale: false, backlog: outline, questions: [{ status: 'answered', blocking: true }] })).toBe('evaluate');
  });

  it('waits for the owner while a blocking question is pending', () => {
    expect(stageAction({ status: 'answering', stale: false, backlog: outline, questions: [blocking] })).toBe('answer');
  });

  it('starts the program once the backlog is detailed and covered', () => {
    expect(stageAction({ status: 'ready', stale: false, backlog: detailed })).toBe('start');
  });

  it('shows only the locked start once the program has started', () => {
    expect(stageAction({ status: 'started', stale: false, backlog: detailed })).toBe('started');
  });
});

describe('stageTitle', () => {
  it('names what a running evaluation is doing', () => {
    expect(stageTitle({ ...base, status: 'evaluating' })).toBe('Avaliando os documentos');
    expect(stageTitle({ status: 'evaluating', stale: false, backlog: outline })).toBe('Avaliando o backlog');
  });
});

describe('released stages', () => {
  it('a released spec with checks failing offers the start and marks documents done', () => {
    const st: StageInput = { status: 'answering', stale: false, released: true, backlog: { enabled: true, detail: true, items: [] } };
    expect(stageAction(st)).toBe('start');
    expect(stageOf(st).map((s) => s.state)).toEqual(['done', 'done', 'active']);
  });
});
