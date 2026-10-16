import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';
import { licenseCodeFile } from './vault.js';

export interface Machine {
  fingerprint: string;
  hostname: string;
  user: string;
  os: string;
  cpu: string;
  cpus: number;
  memoryBytes: number;
  addresses: string[];
  macs: string[];
}

async function installId(home?: string): Promise<string> {
  const file = path.join(path.dirname(licenseCodeFile(home)), 'install-id');
  try {
    const id = (await fs.readFile(file, 'utf8')).trim();
    if (id) return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const id = randomUUID();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, id, { mode: 0o600 });
  return id;
}

export async function readMachine(home?: string, env: NodeJS.ProcessEnv = process.env): Promise<Machine> {
  const nics = Object.values(os.networkInterfaces()).flatMap((list) => list ?? []).filter((nic) => !nic.internal);
  const hostname = env.TEAMS_AI_HOST_NAME || os.hostname();
  const user = env.TEAMS_AI_HOST_USER || os.userInfo().username;
  const system = env.TEAMS_AI_HOST_OS || `${os.type()} ${os.release()}`;
  const cpu = os.cpus()[0]?.model.trim() ?? '';
  const id = await installId(home);
  return {
    fingerprint: createHash('sha256').update([id, hostname, user, system, cpu].join('\n')).digest('hex'),
    hostname,
    user,
    os: system,
    cpu,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    addresses: [...new Set(nics.map((nic) => nic.address))],
    macs: [...new Set(nics.map((nic) => nic.mac).filter((mac) => mac !== '00:00:00:00:00:00'))],
  };
}
