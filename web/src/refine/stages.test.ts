import { describe, expect, it } from 'vitest';
import { stageOf, type StageInput } from './stages.js';

const base: StageInput = { status: 'drafting', stale: false, backlog: null };
const states = (input: StageInput, busy = false) => stageOf(input, busy).map((s) => s.state);
const notes = (input: StageInput, busy = false) => stageOf(input, busy).map((s) => s.note);

describe('stageOf', () => {
  it('starts on the documents while they are not ready', () => {
    expect(states(base)).toEqual(['active', 'todo', 'todo']);
    expect(notes(base)[0]).toBe('Revise os documentos e avalie até ficar pronto.');
  });

  it('asks for the backlog once the documents are ready and nothing is stale', () => {
    const ready: StageInput = { ...base, status: 'ready' };
    expect(states(ready)).toEqual(['done', 'active', 'todo']);
    expect(notes(ready)[1]).toBe('Clique em Quebrar o backlog para começar.');
  });

  it('keeps the backlog active while the outline is drafted and while it is detailed', () => {
    const outline: StageInput = { status: 'ready', stale: false, backlog: { enabled: true, detail: false, items: [{}] } };
    expect(states(outline)).toEqual(['done', 'active', 'todo']);
    expect(notes(outline)[1]).toBe('Esboçando o backlog.');
    const detailing: StageInput = { status: 'drafting', stale: false, backlog: { enabled: true, detail: true, items: [{}] } };
    expect(notes(detailing)[1]).toBe('Detalhando as specs.');
    expect(notes(detailing, true)[1]).toBe('Em andamento.');
  });

  it('asks for an answer while the stage stops on a question, and to continue after the documents changed', () => {
    const asked: StageInput = { status: 'answering', stale: false, backlog: { enabled: true, detail: false, items: [{}] } };
    expect(notes(asked)[1]).toBe('Responda às perguntas em aberto para continuar.');
    const changed: StageInput = { status: 'ready', stale: true, backlog: { enabled: true, detail: true, items: [{}] } };
    expect(states(changed)).toEqual(['done', 'active', 'todo']);
    expect(notes(changed)[1]).toBe('Os documentos mudaram: clique em Continuar etapa 2.');
  });

  it('completes the backlog when every item is detailed and covered, and then execution is next', () => {
    const done: StageInput = { status: 'ready', stale: false, backlog: { enabled: true, detail: true, items: [{}] } };
    expect(states(done)).toEqual(['done', 'done', 'active']);
    expect(notes(done)[2]).toBe('Clique em Iniciar análise para começar.');
  });

  it('marks execution done once the program has started', () => {
    const started: StageInput = { status: 'started', stale: false, backlog: { enabled: true, detail: true, items: [{}] } };
    expect(states(started)).toEqual(['done', 'done', 'done']);
  });
});
