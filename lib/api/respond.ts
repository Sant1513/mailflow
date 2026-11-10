import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/session';

const GENERIC_ERROR = 'Something went wrong on our side. Please try again; if it keeps happening, tell an admin.';

/**
 * What a 500 may tell the browser. Our own errors carry messages written for people (e.g. "Gmail
 * needs reconnecting") and are kept; database and library errors can carry table names, queries
 * and connection details, so those are replaced (the full error is in the server log).
 */
export function publicErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return GENERIC_ERROR;
  const name = err.name || err.constructor?.name || '';
  if (/^Prisma/.test(name) || /prisma|invalid `|SELECT |INSERT |UPDATE |postgres(ql)?:\/\//i.test(err.message)) return GENERIC_ERROR;
  if (err.message.length > 300 || err.message.includes('\n')) return GENERIC_ERROR;
  return err.message || GENERIC_ERROR;
}

/**
 * Wraps an API route handler so auth/validation errors map to the right
 * HTTP status instead of leaking a 500 or, worse, a fake 200. Never used to
 * mask a real failure — see spec §117 ("Never fake success").
 */
export function withErrorHandling(
  handler: (req: Request, ctx: any) => Promise<NextResponse>
) {
  return async (req: Request, ctx: any) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return NextResponse.json({ error: err.message }, { status: 401 });
      }
      if (err instanceof ForbiddenError) {
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      if (err instanceof ZodError) {
        return NextResponse.json(
          { error: 'Validation failed', issues: err.issues },
          { status: 400 }
        );
      }
      console.error('[api]', err);
      return NextResponse.json({ error: publicErrorMessage(err) }, { status: 500 });
    }
  };
}
