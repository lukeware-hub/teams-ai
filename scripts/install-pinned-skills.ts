import { execCommand } from '../server/exec/command.js';
import { pinnedSkillsReady, syncPinnedSkills } from '../server/skills/store.js';

const root = process.argv[2] ?? '/opt/teams-ai/skills';
await syncPinnedSkills(root, execCommand);
if (!(await pinnedSkillsReady(root))) throw new Error(`pinned skills missing under ${root}`);
