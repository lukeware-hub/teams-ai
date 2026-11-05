import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTING, manualAgentSettings } from '../../server/config/config.js';

describe('the agent setting of a role', () => {
  it('is manual Haiku at low effort when the project never set it', () => {
    expect(DEFAULT_AGENT_SETTING).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(manualAgentSettings(undefined).dev).toEqual(DEFAULT_AGENT_SETTING);
  });

  it('keeps a stored setting, and a role stored as null (automatic) has none', () => {
    const out = manualAgentSettings({ dev: { model: 'claude-opus-5-5', effort: 'high' }, sm: null });
    expect(out.dev).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    expect(out.sm).toBeUndefined();
    expect(out.test).toEqual(DEFAULT_AGENT_SETTING);
  });

  it('gives the product owner and the scrum master Sonnet, since they review the documents', () => {
    const out = manualAgentSettings(undefined);
    expect(out.po).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(out.sm).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(out.dev).toEqual(DEFAULT_AGENT_SETTING);
  });
});

describe('the chat and graphify settings of a project', () => {
  it('take Haiku for the chat and Sonnet for graphify when the project never set them, and a stored null takes the default too', () => {
    const out = manualAgentSettings({ chat: null, graphify: null });
    expect(out.chat).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(out.graphify).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it('keep the model the project stored', () => {
    const out = manualAgentSettings({ chat: { model: 'claude-opus-5-5', effort: 'high' }, graphify: { model: 'claude-haiku-5-5', effort: 'low' } });
    expect(out.chat).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    expect(out.graphify).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
  });
});
