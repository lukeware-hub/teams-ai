import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';

export const DeployTarget = z.enum(['docker-local']);
export type DeployTarget = z.infer<typeof DeployTarget>;

export const Persona = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

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
});
export type Project = z.infer<typeof Project>;
