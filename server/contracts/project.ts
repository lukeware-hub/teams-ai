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
});
export type Project = z.infer<typeof Project>;
