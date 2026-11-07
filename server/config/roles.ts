/** The roles of the delivery team. No imports: the skill build copies this file alone into the image. */
export const ROLES = ['sm', 'po', 'front', 'dev', 'test', 'sec', 'devops', 'env', 'docs'] as const;
export type Role = (typeof ROLES)[number];
