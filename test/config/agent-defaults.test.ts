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
    expect(out.po).toEqual(DEFAULT_AGENT_SETTING);
  });
});
