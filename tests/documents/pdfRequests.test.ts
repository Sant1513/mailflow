import { describe, expect, it } from 'vitest';
import { pdfRequestAllowed } from '@/lib/documents/browser-pdf';

describe('what the PDF renderer may load', () => {
  it('allows inline data and public https (web fonts, hosted images)', () => {
    expect(pdfRequestAllowed('data:image/png;base64,AAAA')).toBe(true);
    expect(pdfRequestAllowed('about:blank')).toBe(true);
    expect(pdfRequestAllowed('https://fonts.googleapis.com/css2?family=Inter')).toBe(true);
    expect(pdfRequestAllowed('https://fonts.gstatic.com/s/inter/v1/a.woff2')).toBe(true);
    expect(pdfRequestAllowed('https://masaischool.com/logo.png')).toBe(true);
  });

  it('blocks plain http, localhost, private networks, metadata and LAN names', () => {
    for (const url of [
      'http://example.com/x.png',
      'https://localhost/x',
      'https://localhost:3200/api',
      'https://app.localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://172.16.3.4/x',
      'https://192.168.1.10:3000/x',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/x',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://printer/x',
      'https://nas.local/x',
      'file:///C:/Users/secret.txt',
      'ftp://example.com/x',
      'not a url',
    ]) {
      expect(pdfRequestAllowed(url), url).toBe(false);
    }
  });
});
