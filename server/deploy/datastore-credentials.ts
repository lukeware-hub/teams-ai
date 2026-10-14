/**
 * Passwords a compose file asks of the environment for the datastore only its own service uses, which stays on the service's private network.
 * The platform makes each one up once per project (live: signature-approval-pattern, a compose with POSTGRES_PASSWORD and nobody to give it),
 * and a value the owner already provides wins.
 */
export const DATASTORE_CREDENTIALS: readonly string[] = [
  'POSTGRES_PASSWORD',
  'MYSQL_ROOT_PASSWORD',
  'MYSQL_PASSWORD',
  'MARIADB_ROOT_PASSWORD',
  'MARIADB_PASSWORD',
  'MONGO_INITDB_ROOT_PASSWORD',
  'REDIS_PASSWORD',
  'RABBITMQ_DEFAULT_PASS',
];

/** The datastore passwords, and the environment's own generated secrets, among a project's secrets, for the compose environment. */
export const datastoreCredentialsOf = (secrets: Readonly<Record<string, string>>, environmentNames: readonly string[] = []): Record<string, string> =>
  Object.fromEntries([...DATASTORE_CREDENTIALS, ...environmentNames].filter((n) => secrets[n] !== undefined).map((n) => [n, secrets[n]!]));
