import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  anchorPlacement,
  parsePlacements,
  placedSignerIndices,
  placementsOf,
  resolvePlacement,
  type AnchorPosition,
} from '@/lib/signing/placements';
import { anchorIdFromUri, withAnchorMarkers } from '@/lib/documents/printable';
import { stripSignatureTokens } from '@/lib/signing/signature-tokens';
import { generateSignedPdfDetailed } from '@/lib/documents/pdf';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const BOX = { signerIndex: 1, page: 0, x: 60, y: 600, width: 170, height: 50 };

describe('signature placements', () => {
  it('accepts valid boxes and rejects anything malformed', () => {
    expect(parsePlacements([BOX])).toEqual([BOX]);
    expect(parsePlacements([{ ...BOX, signerIndex: 4 }])).toEqual([]);
    expect(parsePlacements([{ ...BOX, width: 2 }])).toEqual([]);
    expect(parsePlacements('nope')).toEqual([]);
  });

  it('reads placements stored in request metadata', () => {
    expect(placementsOf({ name: 'x', __signaturePlacements: [BOX] })).toEqual([BOX]);
    expect(placementsOf({ name: 'x' })).toEqual([]);
  });

  it('drops inline tokens only for signers placed by position', () => {
    const content = '<p>[[signature]]</p><p>[[signature:2:right]]</p>';
    expect(placedSignerIndices([BOX, { ...BOX, page: 1 }])).toEqual([1]);
    expect(stripSignatureTokens(content, [1])).toBe('<p></p><p>[[signature:2:right]]</p>');
  });
});

describe('anchoring boxes to the text they sit in', () => {
  // A table row of three "Signature:" cells at y=400, with the heading above it.
  const anchors: AnchorPosition[] = [
    { id: 0, page: 1, x: 55, y: 120 },
    { id: 8, page: 1, x: 55, y: 400 },
    { id: 9, page: 1, x: 220, y: 400 },
    { id: 10, page: 1, x: 385, y: 400 },
    { id: 11, page: 1, x: 55, y: 470 },
  ];

  it('anchors to the cell the box is in, measured from that cell', () => {
    const placed = anchorPlacement({ ...BOX, page: 1, x: 230, y: 420 }, anchors);
    expect(placed.anchor).toEqual({ id: 9, dy: 20 });
  });

  it('follows the cell when the text above pushes it down or onto another page', () => {
    const placed = anchorPlacement({ ...BOX, page: 1, x: 230, y: 420 }, anchors);
    const moved = new Map<number, AnchorPosition>([[9, { id: 9, page: 2, x: 220, y: 90 }]]);
    expect(resolvePlacement(placed, moved)).toEqual({ page: 2, x: 230, y: 110 });
  });

  it('falls back to the stored position when the block is missing', () => {
    const placed = anchorPlacement({ ...BOX, page: 1, x: 230, y: 420 }, anchors);
    expect(resolvePlacement(placed, new Map())).toEqual({ page: 1, x: 230, y: 420 });
    expect(anchorPlacement({ ...BOX, page: 5 }, anchors).anchor).toBeUndefined();
  });

  it('marks every block start and nothing else', () => {
    const html = withAnchorMarkers('<style>.a p{x}</style><p>a</p><table><tr><td>b</td></tr></table><span>c</span>');
    expect(html.match(/mf-anchor"/g)).toHaveLength(2);
    expect(html).toContain('<tr><td><a class="mf-anchor"');
    expect(anchorIdFromUri('https://mf-anchor.invalid/12')).toBe(12);
    expect(anchorIdFromUri('https://example.com/12')).toBeNull();
  });
});

describe('PDF with placed signatures', () => {
  const base = {
    title: 'Agreement',
    content: '<p>Student: {{student_name}}</p>',
    recipientName: 'Rahul Sharma',
    recipientEmail: 'rahul@example.com',
    fieldValues: { student_name: 'Rahul' },
    signatureImage: PNG,
    signedAt: new Date('2026-09-23T10:00:00Z'),
    signerIp: '127.0.0.1',
  };

  it('draws the signature inside its box on a signed copy', async () => {
    const res = await generateSignedPdfDetailed({
      ...base,
      placements: [BOX, { ...BOX, signerIndex: 2, x: 360 }],
      signatureSlots: [{ signerIndex: 1, role: 'Student', name: 'Rahul', image: PNG, signedAt: new Date() }],
    });
    expect(res.contentPageCount).toBe(1);
    expect(res.pageCount).toBe(2); // content + completion certificate
    const doc = await PDFDocument.load(res.pdf);
    expect(doc.getPageCount()).toBe(2);
  });

  it('puts a box aimed past the last page on the last content page', async () => {
    const res = await generateSignedPdfDetailed({
      ...base,
      placements: [{ ...BOX, page: 7 }],
      signatureSlots: [{ signerIndex: 1, role: 'Student', image: PNG }],
    });
    expect(res.contentPageCount).toBe(1);
  });

  it('keeps the header one line tall so previews and signed copies line up', async () => {
    // Find the most paragraphs that still fit on one page with a short header;
    // any extra header line would then push content onto a second page.
    const pages = async (n: number, extra: Partial<typeof base> & { preview?: boolean } = {}) =>
      (await generateSignedPdfDetailed({ ...base, content: '<p>line</p>'.repeat(n), ...extra })).contentPageCount;
    let fits = 1;
    while ((await pages(fits + 1)) === 1) fits++;

    const longName = { recipientName: 'Very Long Signer Name '.repeat(20), recipientEmail: 'x'.repeat(80) + '@example.com' };
    expect(await pages(fits, longName)).toBe(1);
    expect(await pages(fits, { ...longName, preview: true, signatureImage: '' })).toBe(1);
    expect(await pages(fits + 1, longName)).toBe(2);
  });
});
