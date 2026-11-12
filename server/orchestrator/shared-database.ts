import type { PlatformService, Project } from '../contracts/project.js';

const NAME = 'postgres';
const USER = 'app';
const DB = 'app';

/**
 * A system of services that needs a DATABASE_URL (`needed`: a spec names the secret, or a service reads it) gets one PostgreSQL on the
 * project's shared network, reached by the name `postgres`, with the datastore password the platform already made up. Returns null
 * when nothing needs it: a single application keeps its database in its own compose file, the project declares its own postgres,
 * or there is no password yet.
 */
export function sharedDatabase(project: Project, needed: boolean, password: string | undefined): { project: Project; url: string } | null {
  const platform = project.platform ?? [];
  // A postgres the project declares itself has credentials this code does not know.
  if (!needed || !password || (project.services ?? []).length === 0 || platform.some((p) => p.name === NAME)) return null;
  const container: PlatformService = { name: NAME, image: 'postgres:17-bookworm', environment: { POSTGRES_USER: USER, POSTGRES_PASSWORD: password, POSTGRES_DB: DB }, healthcheck: ['CMD-SHELL', `pg_isready -U ${USER} -d ${DB}`] };
  return { project: { ...project, platform: [...platform, container] }, url: `postgres://${USER}:${password}@${NAME}:5432/${DB}` };
}
