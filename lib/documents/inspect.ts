import {
  EncryptedPDFError,
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFTextField,
  type PDFField,
  type PDFWidgetAnnotation,
} from 'pdf-lib';
import { MAX_PAGES, MAX_UPLOAD_BYTES, type DetectedFormField, type DocumentInspection, type FormFieldType, type PageInfo } from './types';

/** A problem with the uploaded file itself — always safe to show the user. */
export class DocumentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentFileError';
  }
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  // The header is allowed to follow a little junk (some generators add a BOM).
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString('latin1');
  return head.includes('%PDF-');
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (!looksLikePdf(bytes)) throw new DocumentFileError('This file is not a PDF.');
  try {
    // updateMetadata:false keeps load side-effect free, so generation is deterministic.
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      throw new DocumentFileError(
        'This PDF is password-protected or encrypted, so MailFlow cannot fill it. Remove the protection (for example, open it and use "Print to PDF") and upload it again.'
      );
    }
    throw new DocumentFileError(
      `MailFlow could not read this PDF (${(err as Error).message ?? 'unknown error'}). Try re-saving it as a standard PDF.`
    );
  }
}

export function normaliseRotation(angle: number): number {
  return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function fieldType(field: PDFField): FormFieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFOptionList) return 'optionList';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'unknown';
}

function sameRef(a: PDFRef, b: PDFRef): boolean {
  return a === b || (a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber);
}

/** Which page a widget sits on: its /P entry when present, otherwise the page whose /Annots lists it. */
export function pageIndexOfWidget(doc: PDFDocument, widget: PDFWidgetAnnotation): number {
  const pages = doc.getPages();
  const pRef = widget.P();
  if (pRef instanceof PDFRef) {
    const index = pages.findIndex((p) => sameRef(p.ref, pRef));
    if (index >= 0) return index;
  }
  const widgetRef = doc.context.getObjectRef(widget.dict);
  if (!widgetRef) return -1;
  return pages.findIndex((p) => {
    const annots = p.node.Annots();
    if (!annots) return false;
    for (let i = 0; i < annots.size(); i += 1) {
      const entry = annots.get(i);
      if (entry instanceof PDFRef && sameRef(entry, widgetRef)) return true;
    }
    return false;
  });
}

/**
 * Reads what the editor needs from an uploaded PDF: pages (size, rotation)
 * and every AcroForm field with its type, options and on-page rectangle.
 * Rectangles are converted to top-left-origin points relative to the page's
 * visible (crop) box, the same space the editor and text boxes use.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<DocumentInspection> {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new DocumentFileError(`The PDF is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 4 MB.`);
  }
  const doc = await loadPdf(bytes);
  const pdfPages = doc.getPages();
  if (pdfPages.length === 0) throw new DocumentFileError('This PDF has no pages.');
  if (pdfPages.length > MAX_PAGES) {
    throw new DocumentFileError(`This PDF has ${pdfPages.length} pages; the limit is ${MAX_PAGES}.`);
  }

  const pages: PageInfo[] = pdfPages.map((p) => {
    const box = p.getCropBox();
    return { width: round2(box.width), height: round2(box.height), rotation: normaliseRotation(p.getRotation().angle) };
  });

  const formFields: DetectedFormField[] = [];
  let hasXfa = false;
  if (doc.catalog.getAcroForm()) {
    const form = doc.getForm();
    try {
      hasXfa = form.hasXFA();
    } catch {
      hasXfa = false;
    }
    let fields: PDFField[] = [];
    try {
      fields = form.getFields();
    } catch {
      fields = [];
    }
    for (const field of fields) {
      const detected: DetectedFormField = {
        name: field.getName(),
        type: fieldType(field),
        page: null,
        rect: null,
        readOnly: field.isReadOnly(),
      };
      if (field instanceof PDFTextField) {
        detected.maxLength = field.getMaxLength() ?? null;
        detected.multiline = field.isMultiline();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
        detected.options = field.getOptions();
      }

      const widget = field.acroField.getWidgets()[0];
      if (widget) {
        const index = pageIndexOfWidget(doc, widget);
        const page = index >= 0 ? pdfPages[index] : undefined;
        const info = index >= 0 ? pages[index] : undefined;
        if (page && info) {
          detected.page = index;
          if (info.rotation === 0) {
            const box = page.getCropBox();
            const r = widget.getRectangle();
            detected.rect = {
              x: round2(r.x - box.x),
              y: round2(box.y + box.height - (r.y + r.height)),
              width: round2(r.width),
              height: round2(r.height),
            };
          }
        }
      }
      formFields.push(detected);
    }
  }

  return { pageCount: pages.length, pages, formFields, hasXfa };
}
