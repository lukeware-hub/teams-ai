# Plan 111: test services on demand

FEATURES item 6, part b. The unit-test gate can run against Redis, MySQL, MongoDB, RabbitMQ or PostgreSQL, started for that gate only.

## Decisions

1. The plan field `testServices` lists service names. The names are an enum in `server/contracts/plan.ts`; any other name fails the plan parse, and a duplicate name is refused.
2. Each name maps to one pinned image in `server/exec/test-services.ts`. The agent never chooses an image, so the plan cannot pull an arbitrary one.
3. Credentials are generated per run, one random password per service. They reach the containers through the environment (`docker run -e NAME` with the value in the process environment), never on a command line and never in a log.
4. The services run on a network created with `--internal`, so they have no route out. Only the unit-test gate joins it; the other gates keep `--network none`.
5. The unit-test gate receives the conventional URL variables: `REDIS_URL`, `MYSQL_URL`, `MONGODB_URL`, `RABBITMQ_URL`, `POSTGRES_URL`. The gate reads them from its environment; their values are redacted from logs like any secret.
6. Start order: create the network, start each service, wait until its health check reports healthy (up to 180 seconds), run the gates, then remove the containers and the network. Removal also runs when a gate or a start fails.
7. A service that fails to start fails the gate as an infrastructure failure, and its message names no value.
8. A plan without `testServices` takes the same path as before: no network, no containers, no extra variables.

## Open for the owner

- The image tags (`redis:7.4.1-alpine`, `mysql:8.4.3`, `mongo:7.0.14`, `rabbitmq:3.13.7-alpine`, `postgres:16-bookworm`) were chosen without a registry check. Confirm they exist before the first live run.
- The services are not tied to the e2e and smoke gates, which still run without them.
