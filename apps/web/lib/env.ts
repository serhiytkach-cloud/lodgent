import 'server-only';

/** Server-side configuration for the web app. Read at request time so containers can be reconfigured. */
export function webEnv() {
  const authProvider = process.env.AUTH_PROVIDER === 'cognito' ? 'cognito' : 'dev';
  return {
    isProduction: process.env.APP_ENV === 'production',
    /** Where the web server reaches the API (internal network in AWS). */
    apiUrl: (process.env.API_INTERNAL_URL ?? process.env.API_BASE_URL ?? 'http://localhost:4000').replace(
      /\/+$/,
      '',
    ),
    /** Public API URL shown to hotels and agents (MCP endpoint, OpenAPI). */
    publicApiUrl: (process.env.API_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
    webBaseUrl: (process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    authProvider,
    cognito: {
      domain: process.env.COGNITO_DOMAIN ?? '',
      clientId: process.env.COGNITO_CLIENT_ID ?? '',
      clientSecret: process.env.COGNITO_CLIENT_SECRET ?? '',
    },
  } as const;
}
