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
};

export default nextConfig;
