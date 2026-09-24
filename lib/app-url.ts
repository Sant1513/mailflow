/**
 * The public address of the app, for links that leave it (emails, tracking,
 * unsubscribe). NEXTAUTH_URL comes first because it's the setting already used
 * for signing links and sign-in; the Vercel-provided domains are a safety net so
 * links never point at localhost in production.
 */
export function appBaseUrl(): string {
  const vercelProduction = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const vercelDeployment = process.env.VERCEL_URL;
  const base =
    process.env.NEXTAUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (vercelProduction ? `https://${vercelProduction}` : '') ||
    (vercelDeployment ? `https://${vercelDeployment}` : '') ||
    'http://localhost:3000';
  return base.replace(/\/+$/, '');
}
