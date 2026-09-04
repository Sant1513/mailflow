export { default } from 'next-auth/middleware';

// Protects app pages only. API routes are intentionally excluded: they
// enforce auth themselves via requireSession() (lib/auth/session.ts) so an
// unauthenticated call gets a proper 401 JSON response instead of an HTML
// redirect to the login page.
export const config = {
  matcher: [
    '/((?!api|login|_next/static|_next/image|favicon.ico).*)',
  ],
};
