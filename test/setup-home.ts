import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test worker gets its own home, so no suite writes to the real ~/.teams-ai of the machine.
const home = mkdtempSync(path.join(os.tmpdir(), 'teams-ai-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
