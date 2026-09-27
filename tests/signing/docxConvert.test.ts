import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { docxToHtml, formatNumber, mapSymbol } from '@/lib/signing/docx/convert';
import { fontImports, fontStack } from '@/lib/signing/docx/fonts';
import { documentPageGeometry } from '@/lib/documents/browser-pdf';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const STYLES = `<?xml version="1.0"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:b/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="List"><w:basedOn w:val="Normal"/><w:pPr><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#xF0B7;"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function makeDocx(body: string, opts: { styles?: boolean; sect?: string; rels?: string; extra?: Record<string, string | Buffer> } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const sect = opts.sect ?? '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}${sect}</w:body></w:document>`);
  if (opts.styles !== false) {
    zip.file('word/styles.xml', STYLES);
    zip.file('word/numbering.xml', NUMBERING);
  }
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${opts.rels ?? ''}</Relationships>`);
  for (const [k, v] of Object.entries(opts.extra ?? {})) zip.file(k, v);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const p = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const r = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;

describe('docxToHtml: document setup', () => {
  it('uses the document font, size and page width; carries page geometry for the PDF', async () => {
    const out = await docxToHtml(await makeDocx(p(r('Hello'))));
    expect(out.html).toContain("font-family:'Calibri','Carlito',sans-serif");
    expect(out.html).toContain('font-size:11pt');
    // A4 with 1" margins → 11906 - 2880 twips = 601.73px of text width.
    expect(out.html).toContain('max-width:601.73px');
    expect(out.page).toMatchObject({ top: 96, left: 96, right: 96, bottom: 96 });
    expect(out.html).toMatch(/data-mf-page="794 1123 96 96 96 96"/);
    expect(out.html).toContain("@import url('https://fonts.googleapis.com/css2?family=Carlito");
  });

  it('keeps Word spacing: before/after as padding, line spacing as a multiple', async () => {
    const out = await docxToHtml(await makeDocx(p(r('Body'))));
    expect(out.html).toContain('padding-bottom:10.67px'); // 160 twips
    expect(out.html).toContain(`line-height:${Math.round((259 / 240) * 1.22 * 100) / 100}`);
  });

  it('treats zero or inherited tiny line values as single spacing', async () => {
    const out = await docxToHtml(await makeDocx(p(r('x'), '<w:spacing w:line="1" w:lineRule="atLeast"/>') + p(r('y'), '<w:spacing w:line="1" w:lineRule="auto"/>') + p(r('z'), '<w:spacing w:line="0"/>')));
    expect(out.html).not.toMatch(/line-height:0[;"]/);
  });

  it('works without styles.xml', async () => {
    const out = await docxToHtml(await makeDocx(p(r('Plain')), { styles: false }));
    expect(out.html).toContain('Plain');
  });

  it('rejects files that are not Word documents', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    await expect(docxToHtml(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/Not a Word document/);
  });
});

describe('docxToHtml: text formatting', () => {
  it('applies heading styles through basedOn, and run formatting', async () => {
    const out = await docxToHtml(await makeDocx(
      p(r('Title'), '<w:pStyle w:val="Heading1"/>') +
      p(r('bold', '<w:b/>') + r(' italic', '<w:i/>') + r(' under', '<w:u w:val="single"/>') + r(' red', '<w:color w:val="FF0000"/>') + r(' hl', '<w:highlight w:val="yellow"/>') + r(' big', '<w:sz w:val="28"/>')),
    ));
    expect(out.html).toMatch(/font-family:'Cambria','Caladea',serif;font-size:16pt/);
    expect(out.html).toContain('font-weight:700;color:#2f5496">Title');
    expect(out.html).toContain('<span style="font-weight:700">bold</span>');
    expect(out.html).toContain('font-style:italic">');
    expect(out.html).toContain('text-decoration:underline">');
    expect(out.html).toContain('color:#ff0000">');
    expect(out.html).toContain('background-color:#ffff00">');
    expect(out.html).toContain('font-size:14pt">');
  });

  it('a run set back to normal size inside a heading keeps its own size', async () => {
    const out = await docxToHtml(await makeDocx(p(r('Small', '<w:sz w:val="22"/>'), '<w:pStyle w:val="Heading1"/>')));
    expect(out.html).toContain('font-size:11pt');
  });

  it('merges runs Word split with identical formatting, keeping {{fields}} whole', async () => {
    const out = await docxToHtml(await makeDocx(p(r('Dear {{stu') + '<w:proofErr w:type="spellStart"/>' + r('dent_na') + r('me}},'))));
    expect(out.html).toContain('Dear {{student_name}},');
  });

  it('alignment, indents and paragraph borders', async () => {
    const out = await docxToHtml(await makeDocx(p(r('c'), '<w:jc w:val="both"/><w:ind w:left="720" w:firstLine="360"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="4472C4"/></w:pBdr>')));
    expect(out.html).toContain('text-align:justify');
    expect(out.html).toContain('margin-left:48px');
    expect(out.html).toContain('text-indent:24px');
    expect(out.html).toContain('border-bottom:1.5pt solid #4472c4');
  });

  it('escapes document text and never emits unsafe links', async () => {
    const out = await docxToHtml(await makeDocx(
      // Word stores text XML-escaped; after parsing it is literal "<script>…" text.
      p(r('&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q"')) +
      p('<w:hyperlink r:id="rId1">' + r('bad') + '</w:hyperlink><w:hyperlink r:id="rId2">' + r('good') + '</w:hyperlink>'),
      { rels: '<Relationship Id="rId1" Type="hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="rId2" Type="hyperlink" Target="https://masaischool.com" TargetMode="External"/>' },
    ));
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
    expect(out.html).not.toContain('<script');
    expect(out.html).not.toContain('javascript:');
    expect(out.html).toContain('<a href="https://masaischool.com"');
  });

  it('cleans font names that could break out of CSS', async () => {
    expect(fontStack("Evil';}body{x:1")).toBe("'Evilbodyx1',sans-serif");
  });

  it('skips hidden and deleted text and field codes, keeps field results', async () => {
    const out = await docxToHtml(await makeDocx(p(
      r('shown') + r('hidden', '<w:vanish/>') + '<w:del><w:r><w:delText>gone</w:delText></w:r></w:del>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + r('27-09-2026') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
    )));
    expect(out.html).toContain('shown27-09-2026');
    expect(out.html).not.toContain('hidden');
    expect(out.html).not.toContain('gone');
    expect(out.html).not.toContain('DATE');
  });
});

describe('docxToHtml: lists, tabs, tables, images', () => {
  it('numbers lists with nested levels and hanging indents, and maps Symbol bullets', async () => {
    const li = (t: string, id: string, lvl = 0) => p(r(t), `<w:pStyle w:val="List"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${id}"/></w:numPr>`);
    const out = await docxToHtml(await makeDocx(li('one', '1') + li('sub a', '1', 1) + li('sub b', '1', 1) + li('two', '1') + li('sub again', '1', 1) + li('dot', '2')));
    const labels = [...out.html.matchAll(/min-width:24px;text-indent:0[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(['1.', 'a)', 'b)', '2.', 'a)', '•']);
    expect(out.html).toContain('margin-left:48px');
    expect(out.html).toContain('text-indent:-24px');
    // Contextual spacing: no gap between list items of the same style.
    expect(out.html.match(/padding-bottom:10.67px/g)?.length ?? 0).toBe(1);
  });

  it('custom left tab stops align text; a right tab stop makes a two-sided line', async () => {
    const tabs = '<w:tabs><w:tab w:val="left" w:pos="2160"/></w:tabs>';
    const right = '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9026"/></w:tabs>';
    const out = await docxToHtml(await makeDocx(p(r('Name:') + '<w:r><w:tab/></w:r>' + r('{{name}}'), tabs) + p(r('Signature') + '<w:r><w:tab/></w:r>' + r('Date'), right)));
    expect(out.html).toContain('<span style="display:inline-block;min-width:144px;text-indent:0">Name:</span>{{name}}');
    expect(out.html).toMatch(/display:flex;align-items:baseline;max-width:601.73px[^>]*><span>Signature<\/span><span style="flex:1 1 auto;[^"]*dotted[^"]*"><\/span><span>Date<\/span>/);
  });

  it('tables keep column widths, borders from the table style, spans and merges', async () => {
    const tc = (t: string, pr = '') => `<w:tc><w:tcPr>${pr}</w:tcPr>${p(r(t))}</w:tc>`;
    const tbl = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
      <w:tr>${tc('A', '<w:gridSpan w:val="2"/>')}${tc('C', '<w:vMerge w:val="restart"/><w:shd w:fill="D9E2F3"/>')}</w:tr>
      <w:tr>${tc('D')}${tc('E')}${tc('', '<w:vMerge/>')}</w:tr></w:tbl>`;
    const out = await docxToHtml(await makeDocx(tbl));
    expect(out.html).toContain('<col style="width:200px">');
    expect(out.html).toContain('table-layout:fixed;width:600px');
    expect(out.html).toContain('colspan="2"');
    expect(out.html).toContain('rowspan="2"');
    expect(out.html).toContain('background-color:#d9e2f3');
    expect(out.html).toContain('border-top:0.5pt solid #000000');
    expect(out.html.match(/<td/g)?.length).toBe(4);
  });

  it('embeds images at their Word size and reports formats a browser can’t show', async () => {
    const drawing = (id: string) => `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Logo" descr="Masai logo"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const out = await docxToHtml(await makeDocx(p(drawing('rImg')) + p(drawing('rEmf')), {
      rels: '<Relationship Id="rImg" Type="image" Target="media/logo.png"/><Relationship Id="rEmf" Type="image" Target="media/chart.emf"/>',
      extra: { 'word/media/logo.png': Buffer.from(PNG_1PX, 'base64'), 'word/media/chart.emf': Buffer.from('x') },
    }));
    expect(out.html).toContain(`<img src="data:image/png;base64,${PNG_1PX}" alt="Masai logo" style="display:inline-block;width:100px;height:50px`);
    expect(out.warnings.join(' ')).toMatch(/EMF/);
  });

  it('renders the default header once at the top', async () => {
    const out = await docxToHtml(await makeDocx(p(r('Body text')), {
      sect: '<w:sectPr><w:headerReference w:type="default" r:id="rH"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
      rels: '<Relationship Id="rH" Type="header" Target="header1.xml"/>',
      extra: { 'word/header1.xml': `<?xml version="1.0"?><w:hdr ${W}>${p(r('Masai School letterhead'))}</w:hdr>` },
    }));
    expect(out.html.indexOf('Masai School letterhead')).toBeLessThan(out.html.indexOf('Body text'));
    expect(out.html).toContain('class="mf-docx-header"');
    expect(out.page.width).toBe(816); // US Letter
  });
});

describe('helpers', () => {
  it('list number formats', () => {
    expect(['decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman', 'decimalZero'].map((f) => formatNumber(4, f))).toEqual(['4', 'd', 'D', 'iv', 'IV', '04']);
    expect(formatNumber(27, 'lowerLetter')).toBe('aa');
    expect(formatNumber(2, 'ordinal')).toBe('2nd');
    expect(formatNumber(12, 'ordinal')).toBe('12th');
  });

  it('Symbol / Wingdings characters', () => {
    expect(mapSymbol('  ')).toBe('• ☑ ☐');
  });

  it('one font import per family, Word fonts via their metric twins', () => {
    const css = fontImports(['Calibri', 'Times New Roman', 'Roboto', 'Some Custom Font']);
    expect(css.match(/@import/g)?.length).toBe(3);
    expect(css).toContain('family=Carlito:ital');
    expect(css).toContain('family=Tinos:ital');
    expect(css).toContain('family=Roboto:ital');
  });

  it('PDF page geometry from the template, bounded', () => {
    expect(documentPageGeometry('<div data-mf-page="816 1056 96 120 96 120">')).toEqual({ width: 816, height: 1056, margins: { top: 96, bottom: 96, left: 120, right: 120 } });
    expect(documentPageGeometry('<div data-mf-page="816 1056 0 0 0 0">')?.margins.top).toBe(18);
    expect(documentPageGeometry('<div data-mf-page="99999 1056 96 96 96 96">')).toBeNull();
    expect(documentPageGeometry('<p>plain template</p>')).toBeNull();
  });
});
