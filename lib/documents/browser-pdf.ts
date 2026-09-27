import { existsSync } from 'node:fs';
import type { Browser } from 'puppeteer-core';
import { PRINT_MARGINS, printFooterTemplate } from '@/lib/documents/printable';

/**
 * Prints HTML to PDF with headless Chromium, so signing PDFs look exactly like
 * the HTML the signer reviewed. On Vercel/Lambda it uses @sparticuz/chromium;
 * locally it uses an installed Chrome/Edge (or CHROME_PATH).
 */

const LOCAL_BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function isServerless(): boolean {
  return !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/** Browser printing is used everywhere except unit tests, or when switched off explicitly. */
export function browserPdfEnabled(): boolean {
  if (process.env.SIGNING_PDF_RENDERER === 'pdf-lib') return false;
  if (process.env.SIGNING_PDF_RENDERER === 'browser') return true;
  return !process.env.VITEST;
}

async function launch(): Promise<Browser> {
  const puppeteer = (await import('puppeteer-core')).default;
  if (isServerless()) {
    const chromium = (await import('@sparticuz/chromium')).default;
    chromium.setGraphicsMode = false;
    return puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    });
  }
  const executablePath = LOCAL_BROWSERS.find((p): p is string => !!p && existsSync(p));
  if (!executablePath) throw new Error('No local Chrome/Edge found; set CHROME_PATH');
  return puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
}

// One browser per warm server instance; relaunched if it has gone away.
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing?.connected) return existing;
  }
  browserPromise = launch();
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }
}

/**
 * Page size and margins declared by an imported Word template
 * (data-mf-page="width height top right bottom left", CSS px). Values are
 * bounded so a hand-edited template can't produce an unusable page.
 */
export function documentPageGeometry(html: string) {
  const m = /data-mf-page="(\d+) (\d+) (\d+) (\d+) (\d+) (\d+)"/.exec(html);
  if (!m) return null;
  const [width, height, top, right, bottom, left] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (width < 300 || width > 2000 || height < 300 || height > 3000) return null;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 18), max);
  const margins = {
    top: clamp(top, height / 3),
    bottom: clamp(bottom, height / 3),
    left: clamp(left, width / 3),
    right: clamp(right, width / 3),
  };
  return { width, height, margins };
}

export async function renderHtmlToPdf(html: string, opts: { footerLabel: string }): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Templates are rendered as documents, never run as programs.
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Templates imported from Word carry the document's own page size and margins, so the
    // PDF paginates like Word; everything else uses the standard A4 page.
    const geometry = documentPageGeometry(html);
    const margins = geometry?.margins ?? PRINT_MARGINS;
    const pdf = await page.pdf({
      ...(geometry ? { width: `${geometry.width}px`, height: `${geometry.height}px` } : { format: 'A4' as const }),
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: printFooterTemplate(opts.footerLabel, margins),
      margin: {
        top: `${margins.top}px`,
        bottom: `${margins.bottom}px`,
        left: `${margins.left}px`,
        right: `${margins.right}px`,
      },
      timeout: 30_000,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
