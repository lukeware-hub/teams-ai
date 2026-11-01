import { z } from 'zod';
import { SERVICE_SUFFIXES } from '../core/ids.js';

export const ArchitectureStyle = z.enum(['monolith', 'microservices']);
export type ArchitectureStyle = z.infer<typeof ArchitectureStyle>;

export const Repository = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  responsibility: z.string().min(1),
  /** A quote copied from one of the project's documents, proving the repository exists. */
  evidence: z.object({
    doc: z.enum(['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md']),
    quote: z.string().min(1),
  }),
});
export type Repository = z.infer<typeof Repository>;

export const Integration = z.object({
  consumer: z.string().min(1),
  provider: z.string().min(1),
  contract: z.string().min(1),
});
export type Integration = z.infer<typeof Integration>;

export const Architecture = z.object({
  style: ArchitectureStyle,
  rationale: z.string().min(1),
  repositories: z.array(Repository).min(1),
  integrations: z.array(Integration),
});
export type Architecture = z.infer<typeof Architecture>;

export type RepoKind = (typeof SERVICE_SUFFIXES)[number] | 'monolith';

/** A monolith is one repository; a microservice takes the suffix of its name, or null when it has none. */
export function repoKind(name: string, style: ArchitectureStyle): RepoKind | null {
  if (style === 'monolith') return 'monolith';
  const suffix = /-([a-z]+)$/.exec(name)?.[1];
  return SERVICE_SUFFIXES.find((kind) => kind === suffix) ?? null;
}
