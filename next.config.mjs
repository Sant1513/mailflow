/** @type {import('next').NextConfig} */
const nextConfig = {
  // `next build` and `next dev` share .next by default, so running a
  // verification build while the dev server is up wipes the dev chunks the
  // browser is still requesting. The page then renders unstyled with every
  // JS bundle 404ing — which looks like "the button does nothing", because
  // React never hydrates and the click handler is never attached.
  //
  // Setting NEXT_DIST_DIR lets a verification build write somewhere else
  // and leave a running dev server untouched. See the `verify` script.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  experimental: {
    serverActions: { bodySizeLimit: '5mb' },
    // Signing PDFs are printed with headless Chromium. Keep these out of the
    // bundle and ship Chromium's compressed binary with the routes that print.
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
    outputFileTracingIncludes: {
      '/api/sign/[token]': ['./node_modules/@sparticuz/chromium/bin/**'],
      '/api/sign/[token]/preview': ['./node_modules/@sparticuz/chromium/bin/**'],
      '/api/e-sign/preview': ['./node_modules/@sparticuz/chromium/bin/**'],
    },
  },
  // Basic hardening on every response. Framing is limited to our own pages (the app's PDF
  // previews are same-origin), so another site can't load MailFlow in a hidden frame and
  // trick an admin into clicking. No script CSP: Next.js and the theme script use inline code.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
