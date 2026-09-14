import { Pool } from 'pg';
import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 3_000,
  query_timeout: 3_000,
  statement_timeout: 3_000,
  idleTimeoutMillis: 30_000,
  max: 10,
});
const app = buildApp(pool, { logger: true });

// pg emits errors from idle connections outside a request's promise chain.
pool.on('error', () => {
  app.log.error('An idle database connection failed');
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } catch {
    app.log.error('API shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error('API failed to start');
  process.exitCode = 1;
  await shutdown();
}
