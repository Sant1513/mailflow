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

export async function renderHtmlToPdf(html: string, opts: { footerLabel: string }): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Templates are rendered as documents, never run as programs.
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: printFooterTemplate(opts.footerLabel),
      margin: {
        top: `${PRINT_MARGINS.top}px`,
        bottom: `${PRINT_MARGINS.bottom}px`,
        left: `${PRINT_MARGINS.left}px`,
        right: `${PRINT_MARGINS.right}px`,
      },
      timeout: 30_000,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
