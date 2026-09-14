import Fastify, { LogController } from 'fastify';

export interface Database {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export function buildApp(database: Database, options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: true }) });

  app.addHook('onClose', async () => {
    await database.end();
  });

  // Operational probes only. Product routes require OAuth2 and scoped access.
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await database.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      app.log.warn('Primary database readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
