import type { Project } from '../contracts/project.js';

/** The project's own description as Markdown: graphify turns each heading into a node, so the chat finds every service. */
export function projectInfoMarkdown(project: Project): string {
  const services = project.services ?? [];
  const sections = [
    `# ${project.name}`,
    `## Visão\n${project.vision}`,
    ...(services.length ? [`## Serviços do projeto\nEste projeto tem ${services.length} serviços.\n${services.map((s) => `### ${s}\n`).join('\n')}`] : []),
    `## Personas\n${project.personas.map((p) => `### ${p.name}\n${p.description}\n`).join('\n')}`,
    ...(project.constraints.length ? [`## Restrições\n${project.constraints.map((c) => `- ${c}`).join('\n')}`] : []),
  ];
  return `${sections.join('\n\n')}\n`;
}
