export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
      throw new Error('Invalid database URL');
    }
  } catch {
    // Never include credentials from the supplied URL in configuration errors.
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }

  const portValue = env.PORT ?? '3000';
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const host = env.HOST ?? '0.0.0.0';
  if (!host.trim() || /\s|\//.test(host)) {
    throw new Error('HOST must be a hostname or IP address');
  }

  return { databaseUrl, host, port };
}
