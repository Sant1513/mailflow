// Copies pdf.js's worker next to the app so the document editor can load it
// from /pdf.worker.min.mjs. Runs on install (locally and on Vercel), so the
// worker always matches the installed pdfjs-dist version.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const source = 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
if (existsSync(source)) {
  mkdirSync('public', { recursive: true });
  copyFileSync(source, 'public/pdf.worker.min.mjs');
  console.log('pdf.js worker copied to public/pdf.worker.min.mjs');
} else {
  console.warn('pdfjs-dist is not installed; skipped copying the pdf.js worker');
}
