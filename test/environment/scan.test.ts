import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRepository, unknownVariables } from '../../server/environment/scan.js';

const f = (p: string, text: string) => ({ path: p, text });

describe('unknownVariables', () => {
  it('reads what a compose file asks of its caller, never what it sets or defaults', () => {
    const compose = [
      'services:',
      '  app:',
      '    environment:',
      '      - POSTGRES_PASSWORD',
      '      - DATABASE_URL=postgres://u:${POSTGRES_PASSWORD}@db/x',
      '      - LOG_LEVEL=${LOG_LEVEL:-info}',
      '      HTTP_ADDR: ":8080"',
      '      API_KEY: ${API_KEY:?defina API_KEY}',
    ].join('\n');
    expect(unknownVariables([f('docker-compose.yml', compose)], [])).toEqual(['POSTGRES_PASSWORD', 'API_KEY']);
  });

  it('reads the empty assignments of an env template and the env reads of Go, Node, Python and Rust suites', () => {
    const files = [
      f('.env.example', 'HTTP_ADDR=:8080\nPLATFORM_ADMIN_TOKEN=\nSMTP_PASSWORD=\n'),
      f('e2e/a_test.go', 'os.Getenv("E2E_AUTHORIZATION")\nenvOr("ADMIN_TOKEN", d)\nos.LookupEnv("SERVICE_URL")'),
      f('e2e/b.test.ts', 'process.env.TENANT_TOKEN; process.env["OTHER_KEY"]'),
      f('smoke/c.py', 'os.environ["PY_SECRET"]; os.environ.get("PY_OTHER"); os.getenv("PY_THIRD")'),
      f('smoke/d.rs', 'std::env::var("RUST_KEY")'),
    ];
    expect(unknownVariables(files, [])).toEqual(['PLATFORM_ADMIN_TOKEN', 'SMTP_PASSWORD', 'E2E_AUTHORIZATION', 'ADMIN_TOKEN', 'TENANT_TOKEN', 'OTHER_KEY', 'PY_SECRET', 'PY_OTHER', 'PY_THIRD', 'RUST_KEY']);
  });

  it('drops what the platform provides and what already exists', () => {
    const files = [f('e2e/a_test.go', 'os.Getenv("SERVICE_URL"); os.Getenv("SERVICE_URL_IDENTITY_SERVICE"); os.Getenv("PLATFORM_ADMIN_TOKEN"); os.Getenv("PORT")')];
    expect(unknownVariables(files, ['PLATFORM_ADMIN_TOKEN'])).toEqual([]);
    expect(unknownVariables(files, [])).toEqual(['PLATFORM_ADMIN_TOKEN']);
  });
});

describe('scanRepository', () => {
  it('reads the compose, the env template and the suites, and nothing else', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-scan-'));
    await mkdir(path.join(root, 'e2e'), { recursive: true });
    await mkdir(path.join(root, 'internal'), { recursive: true });
    await writeFile(path.join(root, 'docker-compose.yml'), '- POSTGRES_PASSWORD\n');
    await writeFile(path.join(root, '.env.example'), 'TOKEN=\n');
    await writeFile(path.join(root, 'e2e', 'a_test.go'), 'os.Getenv("E2E_X")');
    await writeFile(path.join(root, 'internal', 'main.go'), 'os.Getenv("NOT_A_SUITE")');
    const files = await scanRepository(root, { compose: 'docker-compose.yml', e2eSuite: 'e2e/' });
    expect(files.map((x) => x.path).sort()).toEqual(['.env.example', 'docker-compose.yml', 'e2e/a_test.go']);
    expect(unknownVariables(files, [])).toEqual(['POSTGRES_PASSWORD', 'TOKEN', 'E2E_X']);
  });
});
