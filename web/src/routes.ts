const id = encodeURIComponent;

export const PROJECTS = '/projects';
export const projectPath = (projectId: string) => `${PROJECTS}/${id(projectId)}`;
export const executionPath = (projectId: string) => `${projectPath(projectId)}#execucao`;
export const repoPath = (projectId: string, repoId: string) => `${projectPath(projectId)}/${id(repoId)}`;
export const refinePath = (projectId: string, specId: string) => `/refine/${id(projectId)}/${id(specId)}`;
export const graphPath = (projectId: string) => `/graph/${id(projectId)}`;
export const BRAIN = '/brain';
export const runPath = (runId: string) => `/runs/${id(runId)}`;
export const validationPath = (runId: string) => `${runPath(runId)}/validation`;
const COSTS = '/costs';
export const costsProjectPath = (projectId: string) => `${COSTS}/${id(projectId)}`;

/** Starting an execution always lands on the project, which follows it. */
export const afterStartPath = executionPath;
