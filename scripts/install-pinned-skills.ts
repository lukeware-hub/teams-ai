import { execCommand } from '../server/exec/command.js';
import { buildRolePlugins, prunePinnedSkills } from '../server/skills/plugins.js';
import { pinnedSkillsReady, syncPinnedSkills } from '../server/skills/store.js';

const root = process.argv[2] ?? '/opt/teams-ai/skills';
const plugins = process.argv[3] ?? '/opt/teams-ai/agent-plugins';
await syncPinnedSkills(root, execCommand);
if (!(await pinnedSkillsReady(root))) throw new Error(`pinned skills missing under ${root}`);
await buildRolePlugins(root, plugins);
await prunePinnedSkills(root);
