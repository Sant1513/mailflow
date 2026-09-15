import { isSystemVariable, variablesIn } from './values';
import type { DocumentField, DocumentInspection, DocumentIssue } from './types';

/**
 * Configuration checks for a document against its PDF (and, when known, the
 * dataset it will be filled from). Errors block a campaign send; warnings
 * are shown but do not block. The editor shows the same list on save.
 */
export function checkDocumentConfig(
  config: { fields: DocumentField[]; fileNamePattern: string },
  inspection: DocumentInspection,
  availableColumns?: string[] | null
): DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  const error = (message: string, fieldId?: string) => issues.push({ level: 'error', message, fieldId });
  const warn = (message: string, fieldId?: string) => issues.push({ level: 'warning', message, fieldId });

  const formByName = new Map(inspection.formFields.map((f) => [f.name, f]));
  const ids = new Set<string>();
  const formUse = new Map<string, string>();

  const unknownVariables = (text: string) =>
    availableColumns ? variablesIn(text).filter((v) => !availableColumns.includes(v) && !isSystemVariable(v)) : [];

  for (const field of config.fields) {
    if (ids.has(field.id)) error(`Two fields share the id "${field.id}".`, field.id);
    ids.add(field.id);

    if (field.target.kind === 'form') {
      const name = field.target.fieldName;
      const detected = formByName.get(name);
      if (!detected) {
        error(`"${field.label}" fills the form field "${name}", which is not in this PDF.`, field.id);
      } else {
        if (detected.type === 'button' || detected.type === 'signature' || detected.type === 'unknown') {
          error(`"${field.label}" targets "${name}", a ${detected.type} field MailFlow cannot fill.`, field.id);
        }
        const fixed = field.value.trim();
        if (
          (detected.type === 'dropdown' || detected.type === 'radio' || detected.type === 'optionList') &&
          fixed &&
          variablesIn(field.value).length === 0 &&
          detected.options &&
          !detected.options.some((o) => o.toLowerCase() === fixed.toLowerCase())
        ) {
          error(`"${field.label}" sets "${fixed}", which is not one of the options: ${detected.options.join(', ')}.`, field.id);
        }
      }
      const previous = formUse.get(name);
      if (previous) warn(`"${field.label}" and "${previous}" both fill "${name}"; the later one wins.`, field.id);
      else formUse.set(name, field.label);
    } else {
      const t = field.target;
      const page = inspection.pages[t.page];
      if (!page) {
        error(`"${field.label}" is on page ${t.page + 1}, but the PDF has ${inspection.pageCount} page(s).`, field.id);
      } else {
        if (page.rotation !== 0) {
          error(
            `"${field.label}" is a text box on page ${t.page + 1}, which is rotated. Text boxes are not supported on rotated pages; use a form field there.`,
            field.id
          );
        }
        if (t.x + t.width > page.width + 1 || t.y + t.height > page.height + 1) {
          warn(`"${field.label}" extends past the edge of page ${t.page + 1}; anything outside the page is cut off.`, field.id);
        }
      }
    }

    if (!field.value.trim()) warn(`"${field.label}" has no value, so it will be left blank.`, field.id);

    const unknown = unknownVariables(field.value);
    if (unknown.length > 0) {
      error(`"${field.label}" uses ${unknown.map((v) => `{{${v}}}`).join(', ')}, which the dataset does not have.`, field.id);
    }
  }

  if (!config.fileNamePattern.trim()) error('The output file name is empty.');
  const unknownInName = unknownVariables(config.fileNamePattern);
  if (unknownInName.length > 0) {
    error(`The file name uses ${unknownInName.map((v) => `{{${v}}}`).join(', ')}, which the dataset does not have.`);
  }

  if (inspection.hasXfa) {
    warn('This PDF contains a dynamic (XFA) form. MailFlow fills its standard form fields and removes the XFA layer, so every PDF reader shows the values.');
  }

  return issues;
}
