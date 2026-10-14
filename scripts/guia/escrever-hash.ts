import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GUIDE_HASH, guideHash } from '../../server/chat/guide.js';

const dir = path.resolve('docs/guia');
await fs.writeFile(path.join(dir, GUIDE_HASH), `${await guideHash(dir)}\n`);
