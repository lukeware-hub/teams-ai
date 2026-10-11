import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';

export const DeployTarget = z.enum(['docker-local']);
export type DeployTarget = z.infer<typeof DeployTarget>;

export const Persona = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

/** A service of a system split into services; its repository is `<projectId>-<name>`. */
export const ServiceName = z.string().regex(ID_PATTERNS.SLUG).max(40);

/** A shared container the docs declare for every service (a message broker, a shared database), reached on the project's network by its name. */
export const PlatformService = z.object({
  name: ServiceName,
  image: z.string().min(1).refine((image) => /[:@]/.test(image.split('/').at(-1) ?? '') && !/:latest$/.test(image), { message: 'pin the image to a version: a tag other than latest, or a digest' }),
  command: z.array(z.string()).optional(),
  environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).optional(),
  /** A compose healthcheck test, e.g. ["CMD", "wget", "-q", "--spider", "http://localhost:8222/healthz"]. */
  healthcheck: z.array(z.string().min(1)).min(1).optional(),
});
export type PlatformService = z.infer<typeof PlatformService>;

export const Project = z.object({
  projectId: z.string().regex(ID_PATTERNS.SLUG),
  name: z.string().min(1),
  vision: z.string().min(1),
  personas: z.array(Persona).min(1),
  constraints: z.array(z.string().min(1)),
  stack: z.string().min(1).optional(),
  principles: z.array(z.string().min(1)),
  deploy: z.object({ target: DeployTarget }),
  github: z.object({ owner: z.string().min(1).optional() }).default({}),
  confidential: z.boolean().default(false),
  /** The services the docs split the system into, one repository each; absent when the project repository holds the code. */
  services: z.array(ServiceName).refine((names) => new Set(names).size === names.length, { message: 'service names must be unique' }).optional(),
  /** The shared containers every service reaches by name; absent when the services need none. */
  platform: z.array(PlatformService).refine((list) => new Set(list.map((p) => p.name)).size === list.length, { message: 'platform names must be unique' }).optional(),
});
export type Project = z.infer<typeof Project>;
