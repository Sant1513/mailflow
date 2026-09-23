'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { defaultBulkSigners, mergeSigningFieldDefs, normalizeBulkSigners, type BulkSignerConfig, type SigningOrderType } from '@/lib/signing/fields';
import { renderSignatureTokensHtml } from '@/lib/signing/signature-tokens';
import { SigningPreviewModal } from '@/components/documents/SigningDocPreview';
import { SignaturePlacementEditor, signerColor } from '@/components/documents/SignaturePlacementEditor';
import { parsePlacements, type SignaturePlacement } from '@/lib/signing/placements';

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

interface FieldDef {
  key: string;
  label: string;
  defaultValue?: string;
}

interface SignerPreset {
  index: number;
  role: string;
  nameColumn: string;
  emailColumn: string;
  assignedFields?: string[];
}

interface SigningTemplate {
  id: string;
  title: string;
  content: string;
  fieldDefs: FieldDef[];
  signerPresets?: SignerPreset[];
  signaturePlacements?: unknown;
}

const BLANK_DOCUMENT = '<p>Please sign this document.</p>';

interface Recipient {
  name: string;
  email: string;
  fieldValues: Record<string, string>;
  /** Fields that came filled from the CSV; read-only in the table. */
  lockedFields?: string[];
  signers?: { name: string; email: string; role: string }[];
}

interface CsvIssue {
  row?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

const SIGNER_COLORS = [
  { bg: '#dbeafe', text: '#1d4ed8', border: '#93c5fd' }, // blue — signer 1
  { bg: '#dcfce7', text: '#15803d', border: '#86efac' }, // green — signer 2
  { bg: '#ffedd5', text: '#c2410c', border: '#fdba74' }, // orange — signer 3
];

function coloredTemplatePreview(
  content: string,
  fieldAssignments: Record<number, string[]>,
  signerConfigs: BulkSignerConfig[],
): string {
  const fieldToSigner: Record<string, number> = {};
  for (const s of signerConfigs) {
    const assigned = fieldAssignments[s.index] ?? [];
    for (const f of assigned) {
      fieldToSigner[f] = s.index;
    }
  }
  return content.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, key: string) => {
    const signerIdx = fieldToSigner[key];
    const color = signerIdx !== undefined ? SIGNER_COLORS[(signerIdx - 1) % SIGNER_COLORS.length] : null;
    if (color) {
      return `<span style="background:${color.bg};color:${color.text};border:1px solid ${color.border};border-radius:3px;padding:0 3px;font-family:monospace;font-size:0.85em">{{${key}}}</span>`;
    }
    return `<span style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:3px;padding:0 3px;font-family:monospace;font-size:0.85em">{{${key}}}</span>`;
  });
}

function sampleForField(key: string, label: string): string {
  const k = key.toLowerCase();
  if (k.includes('date')) return '18-09-2026';
  if (k.includes('amount') || k.includes('stipend') || k.includes('fee')) return '50000';
  if (k.includes('email')) return 'rahul@example.com';
  if (k.includes('company')) return 'ABC Technologies';
  if (k.includes('course')) return 'Full Stack Development';
  if (k.includes('id')) return 'MS12345';
  if (k.includes('name')) return 'Rahul Sharma';
  return label;
}

export default function NewBulkSendPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Form state
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [ccEmails, setCcEmails] = useState('placements@masaischool.com');
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [attachments, setAttachments] = useState<{ name: string; url: string; contentType: string; size: number }[]>([]);
  const [signers, setSigners] = useState<BulkSignerConfig[]>(defaultBulkSigners());
  const [signingOrder, setSigningOrder] = useState<SigningOrderType>('SEQUENTIAL');
  const [fieldAssignments, setFieldAssignments] = useState<Record<number, string[]>>({});

  // Templates
  const [templates, setTemplates] = useState<SigningTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<SigningTemplate | null>(null);

  // Manual recipients
  const [recipients, setRecipients] = useState<Recipient[]>([{ name: '', email: '', fieldValues: {} }]);

  // CSV import state
  const [csvRows, setCsvRows] = useState<Recipient[] | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvIssues, setCsvIssues] = useState<CsvIssue[]>([]);
  const [previewTarget, setPreviewTarget] = useState<Recipient | null>(null);
  const [placements, setPlacements] = useState<SignaturePlacement[]>([]);
  const [placementEditorOpen, setPlacementEditorOpen] = useState(false);
  const [saveToTemplate, setSaveToTemplate] = useState(true);

  // Load templates on mount
  useEffect(() => {
    fetch('/api/signing-templates')
      .then((res) => res.json())
      .then((data: { templates?: SigningTemplate[] }) => {
        setTemplates(data.templates ?? []);
      })
      .catch(() => {});
  }, []);

  // Sync selectedTemplate and load its signerPresets when templateId changes
  useEffect(() => {
    if (!templateId) {
      setSelectedTemplate(null);
      setPlacements([]);
      return;
    }
    const tpl = templates.find((t) => t.id === templateId) ?? null;
    setSelectedTemplate(tpl);
    setPlacements(parsePlacements(tpl?.signaturePlacements));
    if (tpl?.signerPresets && tpl.signerPresets.length > 0) {
      setSigners(normalizeBulkSigners(tpl.signerPresets as BulkSignerConfig[]));
      const assignments: Record<number, string[]> = {};
      for (const sp of tpl.signerPresets) {
        if (sp.assignedFields && sp.assignedFields.length > 0) {
          assignments[sp.index] = sp.assignedFields;
        }
      }
      setFieldAssignments(assignments);
    }
  }, [templateId, templates]);

  const fieldDefs: FieldDef[] = useMemo(
    () => (selectedTemplate ? mergeSigningFieldDefs(selectedTemplate.content, selectedTemplate.fieldDefs) : []),
    [selectedTemplate],
  );
  const signerConfigs = useMemo(() => normalizeBulkSigners(signers), [signers]);

  // ── Recipient helpers ─────────────────────────────────────────────────────

  function addRecipient() {
    const defaults: Record<string, string> = {};
    for (const fd of fieldDefs) {
      defaults[fd.key] = fd.defaultValue ?? '';
    }
    setRecipients((prev) => [...prev, { name: '', email: '', fieldValues: defaults }]);
  }

  function removeRecipient(i: number) {
    setRecipients((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateRecipientField(i: number, field: 'name' | 'email', val: string) {
    setRecipients((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [field]: val } : r)),
    );
  }

  function updateRecipientCustomField(i: number, key: string, val: string) {
    setRecipients((prev) =>
      prev.map((r, idx) =>
        idx === i ? { ...r, fieldValues: { ...r.fieldValues, [key]: val } } : r,
      ),
    );
  }

  function updateSigner(index: number, patch: Partial<BulkSignerConfig>) {
    setSigners((prev) => normalizeBulkSigners(prev.map((s, i) => (i === index ? { ...s, ...patch } : s))));
  }

  function addSigner() {
    setSigners((prev) => {
      if (prev.length >= 3) return prev;
      const next = prev.length + 1;
      return [...prev, { index: next, role: `Signer ${next}`, nameColumn: `signer_${next}_name`, emailColumn: `signer_${next}_email` }];
    });
  }

  function removeSigner(index: number) {
    setSigners((prev) => normalizeBulkSigners(prev.filter((_, i) => i !== index)));
    // Signers are renumbered after a removal; keep each box with its signer.
    const removed = index + 1;
    setPlacements((prev) =>
      prev
        .filter((p) => p.signerIndex !== removed)
        .map((p) => (p.signerIndex > removed ? { ...p, signerIndex: p.signerIndex - 1 } : p)),
    );
    setFieldAssignments((prev) => {
      const next = { ...prev };
      delete next[index + 1];
      return next;
    });
  }

  function toggleFieldAssignment(signerIndex: number, fieldKey: string) {
    setFieldAssignments((prev) => {
      const current = prev[signerIndex] ?? [];
      const next = current.includes(fieldKey)
        ? current.filter((k) => k !== fieldKey)
        : [...current, fieldKey];
      return { ...prev, [signerIndex]: next };
    });
  }

  // ── Sample CSV download ───────────────────────────────────────────────────

  function downloadSampleCsv() {
    const signerHeaders = signerConfigs.flatMap((s) => [s.nameColumn, s.emailColumn]);
    const headers = [...fieldDefs.map((fd) => fd.key), ...signerHeaders];
    const sampleRow = [
      ...fieldDefs.map((fd) => fd.defaultValue ?? sampleForField(fd.key, fd.label)),
      ...signerConfigs.flatMap((s, i) => [`${i === 0 ? 'Rahul Sharma' : i === 1 ? 'Amit Kumar' : 'Neha Singh'}`, i === 0 ? 'rahul@example.com' : i === 1 ? 'amit@company.com' : 'neha@masaischool.com']),
    ];
    const escape = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const csv = [headers.map(escape).join(','), sampleRow.map(escape).join(',')].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedTemplate?.title ?? 'bulk-send'}-sample.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── CSV parser — reads document variables + configured signer columns ───

  const handleCsvFile = useCallback(
    (file: File) => {
      setCsvError(null);
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = (e.target?.result as string) ?? '';
        const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
        if (rows.length < 2) {
          setCsvError('CSV must have a header row and at least one data row.');
          setCsvIssues([]);
          return;
        }
        const headers = rows[0]!.map((h) => h.trim().toLowerCase());
        // Signer columns are mandatory: we can't send without knowing who signs.
        const signerHeaders = signerConfigs.flatMap((s) => [s.nameColumn, s.emailColumn]);
        const missingSignerHeaders = signerHeaders.filter((h) => !headers.includes(h));
        if (missingSignerHeaders.length > 0) {
          setCsvError(`CSV is missing signer column${missingSignerHeaders.length !== 1 ? 's' : ''}: ${missingSignerHeaders.join(', ')}`);
          setCsvIssues(missingSignerHeaders.map((h) => ({ severity: 'error', message: `Missing column ${h}` })));
          setCsvRows(null);
          return;
        }

        // Document variables are optional: absent columns and blank cells are
        // left for the signer to fill in on the signing page.
        const issues: CsvIssue[] = [];
        const missingFieldColumns = fieldDefs.filter((fd) => !headers.includes(fd.key.toLowerCase()));
        if (missingFieldColumns.length > 0) {
          issues.push({
            severity: 'info',
            message: `Not in CSV (signer will fill): ${missingFieldColumns.map((fd) => fd.key).join(', ')}`,
          });
        }

        const emailSeen = new Set<string>();
        const parsed: Recipient[] = [];
        let blankCells = 0;
        for (let row = 1; row < rows.length; row++) {
          const cols = rows[row]!;
          const rowNumber = row + 1;

          const fieldValues: Record<string, string> = {};
          const lockedFields: string[] = [];
          for (const fd of fieldDefs) {
            const idx = headers.indexOf(fd.key.toLowerCase());
            const value = idx >= 0 ? (cols[idx] ?? '').trim() : (fd.defaultValue ?? '').trim();
            fieldValues[fd.key] = value;
            if (value) lockedFields.push(fd.key);
            else if (idx >= 0) blankCells++;
          }

          const rowSigners = signerConfigs.map((s) => {
            const name = (cols[headers.indexOf(s.nameColumn)] ?? '').trim();
            const email = (cols[headers.indexOf(s.emailColumn)] ?? '').trim().toLowerCase();
            if (!name) issues.push({ row: rowNumber, severity: 'error', message: `Missing ${s.nameColumn}` });
            if (!email) issues.push({ row: rowNumber, severity: 'error', message: `Missing ${s.emailColumn}` });
            else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) issues.push({ row: rowNumber, severity: 'error', message: `Invalid ${s.emailColumn}` });
            const dedupeKey = `${rowNumber}:${email}`;
            if (emailSeen.has(dedupeKey)) issues.push({ row: rowNumber, severity: 'warning', message: `Duplicate signer email ${email} in this row` });
            emailSeen.add(dedupeKey);
            return { name, email, role: s.role };
          });

          const first = rowSigners[0]!;
          parsed.push({ name: first.name, email: first.email, fieldValues, lockedFields, signers: rowSigners });
        }
        if (blankCells > 0) {
          issues.push({
            severity: 'info',
            message: `${blankCells} blank cell${blankCells !== 1 ? 's' : ''} will be filled in by the signer. You can also type values in the table before sending.`,
          });
        }
        const errors = issues.filter((i) => i.severity === 'error');
        setCsvIssues(issues);
        if (parsed.length === 0 || errors.length > 0) {
          setCsvError(errors.length ? `${errors.length} validation error${errors.length !== 1 ? 's' : ''}. Fix the CSV before sending.` : 'No valid rows found in CSV.');
          setCsvRows(null);
          return;
        }
        setCsvError(null);
        setCsvRows(parsed);
      };
      reader.readAsText(file);
    },
    [fieldDefs, signerConfigs],
  );

  function acceptCsvRows() {
    if (csvRows) {
      setRecipients(csvRows);
      setCsvRows(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function discardCsvRows() {
    setCsvRows(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function handleAttachFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setUploading(true);
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/e-sign/attachments', { method: 'POST', body: fd });
      if (res.ok) {
        const meta = (await res.json()) as { name: string; url: string; contentType: string; size: number };
        setAttachments((prev) => [...prev, meta]);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(j.error ?? `Failed to upload ${file.name}`);
      }
    }
    setUploading(false);
    e.target.value = '';
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validRecipients = recipients.filter((r) => r.name.trim() && r.email.trim());

    if (!title.trim()) {
      toast.error('Please enter a batch title.');
      return;
    }
    if (validRecipients.length === 0) {
      toast.error('Add at least one recipient.');
      return;
    }
    if (validRecipients.length > 200) {
      toast.error('Maximum 200 recipients per batch.');
      return;
    }

    const ccList = ccEmails
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    setSubmitting(true);
    const res = await fetch('/api/signing-batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        templateId: templateId || undefined,
        recipients: validRecipients.map((r) => ({
          name: r.name.trim(),
          email: r.email.trim(),
          fieldValues: r.fieldValues,
          signers: r.signers,
        })),
        signers: signerConfigs.map((s) => ({
          ...s,
          assignedFields: fieldAssignments[s.index] ?? [],
        })),
        signingOrder: signerConfigs.length > 1 ? signingOrder : 'SEQUENTIAL',
        signaturePlacements: activePlacements,
        attachments,
        ccEmails: ccList,
        expiresInDays,
      }),
    });
    setSubmitting(false);

    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(json.error ?? 'Failed to create bulk send');
      return;
    }

    toast.success(
      `Bulk send created — ${validRecipients.length} row${validRecipients.length !== 1 ? 's' : ''} queued for signing`,
    );
    router.push('/documents/bulk');
  }

  const validCount = recipients.filter((r) => r.name.trim() && r.email.trim()).length;
  const signerFillCount = recipients
    .filter((r) => r.name.trim() && r.email.trim())
    .reduce((n, r) => n + fieldDefs.filter((fd) => !(r.fieldValues[fd.key] ?? '').trim()).length, 0);
  const documentContent = selectedTemplate?.content ?? BLANK_DOCUMENT;
  const activePlacements = placements.filter((p) => p.signerIndex <= signerConfigs.length);
  const placementSampleValues = (csvRows?.[0] ?? recipients.find((r) => Object.values(r.fieldValues).some((v) => v.trim())))
    ?.fieldValues ?? Object.fromEntries(fieldDefs.map((fd) => [fd.key, fd.defaultValue ?? '']));

  async function savePlacements(next: SignaturePlacement[]) {
    setPlacements(next);
    setPlacementEditorOpen(false);
    if (saveToTemplate && selectedTemplate) {
      const res = await fetch(`/api/signing-templates/${selectedTemplate.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signaturePlacements: next }),
      });
      if (!res.ok) {
        toast.error('Positions are set for this batch, but saving them to the template failed');
        return;
      }
      setTemplates((prev) => prev.map((t) => (t.id === selectedTemplate.id ? { ...t, signaturePlacements: next } : t)));
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/documents/bulk" className="text-sm text-muted-foreground hover:text-foreground">
          ← Bulk Sending
        </Link>
        <h1 className="text-xl font-semibold">New Bulk Send</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ── Batch Details ─────────────────────────────────────────────── */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="eyebrow mb-2">Batch Details</div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              Batch title <span className="text-primary">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Offer Letters — Jan 2026 Batch"
              required
              className="w-full"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium">Template (optional)</label>
              <Link href="/documents/templates/new" className="text-xs text-primary hover:underline">
                + Create template
              </Link>
            </div>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full"
            >
              <option value="">— No template (blank document) —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            {templates.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No templates yet.{' '}
                <Link href="/documents/templates/new" className="text-primary hover:underline">
                  Create one
                </Link>{' '}
                to pre-fill document content and define fields for each recipient.
              </p>
            )}
          </div>

          {/* Template fields summary */}
          {selectedTemplate && fieldDefs.length > 0 && (
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Document variables ({fieldDefs.length})
              </div>
              <div className="overflow-x-auto rounded border bg-background">
                <table className="w-full text-xs">
                  <thead className="bg-muted text-left uppercase text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1">Variable</th>
                      <th className="px-2 py-1">CSV Column</th>
                      <th className="px-2 py-1">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldDefs.map((fd) => (
                      <tr key={fd.key} className="border-t border-border-subtle">
                        <td className="px-2 py-1"><code className="font-mono text-primary">{fd.key}</code></td>
                        <td className="px-2 py-1"><code className="font-mono">{fd.key}</code></td>
                        <td className="px-2 py-1 text-muted-foreground">CSV value locked · blank = signer fills</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Values present in the CSV are read-only on the signing page. Blank cells or missing columns are filled in by the
                signer before they can sign.
              </p>
            </div>
          )}

          {selectedTemplate && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Template Preview
                </div>
                {signerConfigs.length > 1 && Object.keys(fieldAssignments).length > 0 && (
                  <div className="flex items-center gap-2">
                    {signerConfigs.map((s, i) => {
                      const c = SIGNER_COLORS[i % SIGNER_COLORS.length]!;
                      return (
                        <span key={s.index} className="flex items-center gap-1 text-[10px]">
                          <span style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}`, borderRadius: 3, padding: '0 4px' }}>{s.role}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
              <div
                className="rounded-md border bg-background p-3 prose prose-sm max-w-none overflow-auto max-h-36 text-foreground text-xs"
                dangerouslySetInnerHTML={{
                  __html: renderSignatureTokensHtml(
                    signerConfigs.length > 1
                      ? coloredTemplatePreview(selectedTemplate.content, fieldAssignments, signerConfigs)
                      : selectedTemplate.content,
                    signerConfigs.map((s) => ({ signerIndex: s.index, role: s.role })),
                  ),
                }}
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium">CC emails</label>
            <textarea
              value={ccEmails}
              onChange={(e) => setCcEmails(e.target.value)}
              rows={2}
              placeholder="One email per line"
              className="w-full font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">One email per line.</p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Expires in</label>
            <select
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
              className="w-40"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>
        </div>

        {/* ── Signer Configuration ─────────────────────────────────────── */}
        <div className="rounded-lg border bg-card p-5 space-y-3">
          <div className="eyebrow mb-1">Signer configuration</div>
          <p className="text-xs text-muted-foreground -mt-2">
            Configure who signs each generated document. CSV columns below are included in the sample file.
          </p>
          <div className="space-y-2">
            {signerConfigs.map((s, i) => (
              <div key={s.index} className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <input
                  value={s.role}
                  onChange={(e) => updateSigner(i, { role: e.target.value })}
                  placeholder={`Signer ${i + 1} role`}
                  className="text-sm"
                />
                <input
                  value={s.nameColumn}
                  onChange={(e) => updateSigner(i, { nameColumn: e.target.value })}
                  placeholder={`signer_${i + 1}_name`}
                  className="font-mono text-sm"
                />
                <input
                  value={s.emailColumn}
                  onChange={(e) => updateSigner(i, { emailColumn: e.target.value })}
                  placeholder={`signer_${i + 1}_email`}
                  className="font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeSigner(i)}
                  disabled={signerConfigs.length === 1}
                  className="text-xs text-muted-foreground hover:text-primary disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addSigner}
            disabled={signerConfigs.length >= 3}
            className="text-xs text-primary hover:underline disabled:text-muted-foreground"
          >
            + Add signer
          </button>

          {/* Signing order toggle — visible when >1 signer */}
          {signerConfigs.length > 1 && (
            <div className="mt-3 rounded-md border bg-muted/20 p-3 space-y-3">
              <div className="text-xs font-medium">Signing order</div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="signingOrder"
                    checked={signingOrder === 'SEQUENTIAL'}
                    onChange={() => setSigningOrder('SEQUENTIAL')}
                    className="accent-primary"
                  />
                  <span>Sequential <span className="text-muted-foreground">(Signer 1 → 2 → 3)</span></span>
                </label>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="signingOrder"
                    checked={signingOrder === 'PARALLEL'}
                    onChange={() => setSigningOrder('PARALLEL')}
                    className="accent-primary"
                  />
                  <span>Parallel <span className="text-muted-foreground">(all sign at once)</span></span>
                </label>
              </div>

              {/* Per-signer field assignment */}
              {fieldDefs.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-medium">Field assignment <span className="text-muted-foreground font-normal">(which signer fills which fields on the signing page)</span></div>
                  <p className="text-xs text-muted-foreground">
                    Fields with a CSV value are always locked. Tick which signer fills each field when its cell is blank. Unticked
                    blank fields go to {signerConfigs[0]?.role ?? 'Signer 1'}.
                  </p>
                  <div className="overflow-x-auto rounded border bg-background">
                    <table className="w-full text-xs">
                      <thead className="bg-muted text-left uppercase text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5">Field</th>
                          {signerConfigs.map((s) => (
                            <th key={s.index} className="px-2 py-1.5 text-center">{s.role}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {fieldDefs.map((fd) => (
                          <tr key={fd.key} className="border-t border-border-subtle">
                            <td className="px-2 py-1.5"><code className="font-mono text-primary">{fd.key}</code></td>
                            {signerConfigs.map((s) => (
                              <td key={s.index} className="px-2 py-1.5 text-center">
                                <input
                                  type="checkbox"
                                  checked={(fieldAssignments[s.index] ?? []).includes(fd.key)}
                                  onChange={() => toggleFieldAssignment(s.index, fd.key)}
                                  className="accent-primary"
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Visual signature placement */}
          <div className="mt-3 rounded-md border bg-muted/20 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium">Signature positions</div>
                <p className="text-xs text-muted-foreground">
                  Drag a box onto the document for each signer and resize it. Each signature is drawn inside its box on the
                  signed PDF.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPlacementEditorOpen(true)}
                disabled={!selectedTemplate}
                className="btn-secondary !px-3 !py-1 text-xs disabled:opacity-50"
                title={selectedTemplate ? undefined : 'Select a template first'}
              >
                {activePlacements.length ? 'Edit positions' : 'Place signatures on document'}
              </button>
            </div>
            {!selectedTemplate ? (
              <p className="text-xs text-muted-foreground">Select a template above to place signatures.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {signerConfigs.map((s) => {
                  const boxes = activePlacements.filter((p) => p.signerIndex === s.index);
                  const c = signerColor(s.index);
                  return (
                    <span
                      key={s.index}
                      className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px]"
                      style={{ borderColor: boxes.length ? c.border : undefined }}
                    >
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: c.bg, border: `1.5px dashed ${c.border}` }} />
                      {s.role}:{' '}
                      {boxes.length ? (
                        <span>page {[...new Set(boxes.map((b) => b.page + 1))].join(', ')}</span>
                      ) : (
                        <span className="text-muted-foreground">not placed (completion page only)</span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Attachments ───────────────────────────────────────────────── */}
        <div className="rounded-lg border bg-card p-5 space-y-3">
          <div className="eyebrow mb-1">Additional attachments <span className="text-muted-foreground font-normal normal-case text-xs">(optional)</span></div>
          <p className="text-xs text-muted-foreground -mt-2">
            Included in the signing email and post-signing confirmation for every recipient. PDF, Word, JPEG, PNG — max 10 MB each.
          </p>
          {attachments.length > 0 && (
            <ul className="space-y-1">
              {attachments.map((a, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">{a.name}</span>
                  <span className="text-xs text-muted-foreground">{(a.size / 1024).toFixed(0)} KB</span>
                  <button type="button" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} className="text-xs text-muted-foreground hover:text-destructive">✕</button>
                </li>
              ))}
            </ul>
          )}
          <label className="inline-flex items-center gap-2 cursor-pointer rounded border border-dashed px-4 py-2 text-sm text-muted-foreground hover:text-primary hover:border-primary transition">
            {uploading ? 'Uploading…' : '+ Attach files'}
            <input type="file" multiple accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" className="sr-only" onChange={handleAttachFiles} disabled={uploading} />
          </label>
        </div>

        {/* ── Recipients ────────────────────────────────────────────────── */}
        <div className="rounded-lg border bg-card p-5">
          <div className="eyebrow mb-3">Recipients</div>

          {/* CSV Upload */}
          <div className="mb-4 rounded-md border border-dashed p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium">Upload CSV</p>
                <p className="text-xs text-muted-foreground">
                  Required signer columns:{' '}
                  {signerConfigs.flatMap((s) => [s.nameColumn, s.emailColumn]).map((h, i, arr) => (
                    <span key={h}>
                      <code className="font-mono">{h}</code>
                      {i < arr.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                  .
                </p>
                {fieldDefs.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Document columns (optional, blank = signer fills):{' '}
                    {fieldDefs.map((fd, i, arr) => (
                      <span key={fd.key}>
                        <code className="font-mono">{fd.key}</code>
                        {i < arr.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                    .
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={downloadSampleCsv}
                className="text-xs text-primary hover:underline shrink-0"
              >
                ↓ Download sample CSV
              </button>
            </div>
            <div className="mt-3">
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleCsvFile(f);
                }}
                className="text-xs"
              />
            </div>
          </div>

          {csvError && <p className="mb-3 text-xs text-destructive">{csvError}</p>}
          {csvIssues.length > 0 && (
            <div className="mb-3 rounded-md border bg-muted/20 p-3">
              <div className="mb-1 text-xs font-medium">
                Validation summary: {csvRows?.length ?? 0} valid row{(csvRows?.length ?? 0) !== 1 ? 's' : ''},{' '}
                {csvIssues.filter((i) => i.severity === 'error').length} error{csvIssues.filter((i) => i.severity === 'error').length !== 1 ? 's' : ''},{' '}
                {csvIssues.filter((i) => i.severity === 'warning').length} warning{csvIssues.filter((i) => i.severity === 'warning').length !== 1 ? 's' : ''}
              </div>
              <ul className="max-h-28 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                {csvIssues.slice(0, 20).map((issue, i) => (
                  <li
                    key={i}
                    className={
                      issue.severity === 'error'
                        ? 'text-destructive'
                        : issue.severity === 'warning'
                          ? 'text-amber-700'
                          : 'text-blue-700'
                    }
                  >
                    {issue.row ? `Row ${issue.row}: ` : ''}{issue.message}
                  </li>
                ))}
                {csvIssues.length > 20 && <li>... and {csvIssues.length - 20} more</li>}
              </ul>
            </div>
          )}

          {/* CSV Preview */}
          {csvRows && (
            <div className="mb-4 rounded-md border bg-muted/20 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {csvRows.length} row{csvRows.length !== 1 ? 's' : ''} parsed — review before sending:
              </p>
              <div className="max-h-40 overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground text-left">
                      <th className="px-2 py-1">Name</th>
                      <th className="px-2 py-1">Email</th>
                      <th className="px-2 py-1">Signers</th>
                      {fieldDefs.map((fd) => (
                        <th key={fd.key} className="px-2 py-1">{fd.label}</th>
                      ))}
                      <th className="px-2 py-1 text-right">Document</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvRows.slice(0, 20).map((r, i) => (
                      <tr key={i} className="border-t border-border-subtle">
                        <td className="px-2 py-1">{r.name}</td>
                        <td className="px-2 py-1">{r.email}</td>
                        <td className="px-2 py-1 text-muted-foreground">
                          {(r.signers ?? [{ name: r.name, email: r.email, role: 'Signer 1' }]).map((s) => `${s.role}: ${s.name}`).join(' / ')}
                        </td>
                        {fieldDefs.map((fd) => (
                          <td key={fd.key} className="px-2 py-1 text-muted-foreground whitespace-nowrap">
                            {r.fieldValues[fd.key] ? (
                              r.fieldValues[fd.key]
                            ) : (
                              <span className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800">Signer fills</span>
                            )}
                          </td>
                        ))}
                        <td className="px-2 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => setPreviewTarget(r)}
                            className="whitespace-nowrap font-medium text-primary hover:underline"
                          >
                            Preview
                          </button>
                        </td>
                      </tr>
                    ))}
                    {csvRows.length > 20 && (
                      <tr>
                        <td colSpan={4 + fieldDefs.length} className="px-2 py-1 text-muted-foreground italic">
                          … and {csvRows.length - 20} more
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={acceptCsvRows}
                  className="btn-primary !px-3 !py-1 text-xs"
                >
                  Use CSV rows ({csvRows.length})
                </button>
                <button
                  type="button"
                  onClick={discardCsvRows}
                  className="btn-secondary !px-3 !py-1 text-xs"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          {/* Manual recipient table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="px-2 py-1 text-left min-w-[160px]">Name</th>
                  <th className="px-2 py-1 text-left min-w-[180px]">Email</th>
                  {fieldDefs.map((fd) => (
                    <th key={fd.key} className="px-2 py-1 text-left min-w-[140px]">
                      {fd.label}
                    </th>
                  ))}
                  <th className="px-2 py-1 w-24" />
                </tr>
              </thead>
              <tbody>
                {recipients.map((r, i) => (
                  <tr key={i} className="border-t border-border-subtle align-top">
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={r.name}
                        onChange={(e) => updateRecipientField(i, 'name', e.target.value)}
                        placeholder="Full name"
                        className="w-full text-sm"
                      />
                      {(r.signers?.length ?? 0) > 1 && (
                        <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                          {r.signers!.slice(1).map((s, si) => (
                            <div key={si} className="truncate" title={s.email}>
                              + {s.role}: {s.name}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="email"
                        value={r.email}
                        onChange={(e) => updateRecipientField(i, 'email', e.target.value)}
                        placeholder="email@example.com"
                        className="w-full text-sm"
                      />
                    </td>
                    {fieldDefs.map((fd) => {
                      const locked = r.lockedFields?.includes(fd.key) && !!r.fieldValues[fd.key];
                      return (
                        <td key={fd.key} className="px-2 py-1">
                          {locked ? (
                            <div
                              className="flex items-center gap-1 rounded border border-transparent bg-muted/60 px-2 py-1.5 text-sm text-foreground"
                              title="From CSV · locked for the signer"
                            >
                              <LockIcon />
                              <span className="truncate">{r.fieldValues[fd.key]}</span>
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={r.fieldValues[fd.key] ?? ''}
                              onChange={(e) => updateRecipientCustomField(i, fd.key, e.target.value)}
                              placeholder="Signer fills"
                              title="Leave blank for the signer to fill, or type a value to lock it"
                              className={`w-full text-sm ${r.fieldValues[fd.key] ? '' : 'border-dashed !border-amber-300 bg-amber-50/40'}`}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setPreviewTarget(r)}
                        className="text-xs text-primary hover:underline"
                        title="Preview the generated document for this recipient"
                      >
                        Preview
                      </button>
                      {recipients.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeRecipient(i)}
                          className="ml-2 text-xs text-muted-foreground hover:text-primary px-1"
                          aria-label="Remove recipient"
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={addRecipient}
            className="mt-3 text-xs text-primary hover:underline"
          >
            + Add recipient
          </button>

          <p className="mt-3 text-xs text-muted-foreground">
            {validCount} valid recipient{validCount !== 1 ? 's' : ''} · max 200 per batch
            {signerFillCount > 0 && (
              <>
                {' '}· <span className="text-amber-700">{signerFillCount} blank field{signerFillCount !== 1 ? 's' : ''} will be filled by signers</span>
              </>
            )}
          </p>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <LockIcon /> Values from the CSV are locked for the signer. Dashed cells are blank: type a value to lock it, or leave it for the signer.
          </p>
        </div>

        {/* Submit */}
        <div className="flex items-center gap-3 justify-end">
          <Link href="/documents/bulk" className="btn-secondary">
            Cancel
          </Link>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting
              ? 'Sending…'
              : `Send to ${validCount} Recipient${validCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </form>

      {previewTarget && (
        <SigningPreviewModal
          payload={{
            title: title.trim() || selectedTemplate?.title || 'Untitled document',
            content: documentContent,
            fieldValues: previewTarget.fieldValues,
            recipientName: previewTarget.name,
            recipientEmail: previewTarget.email,
            signers: (previewTarget.signers?.length
              ? previewTarget.signers
              : [{ name: previewTarget.name, email: previewTarget.email, role: signerConfigs[0]?.role ?? 'Signer 1' }]
            ).map((s) => ({ role: s.role, name: s.name })),
            placements: activePlacements,
          }}
          onClose={() => setPreviewTarget(null)}
        />
      )}

      {placementEditorOpen && (
        <SignaturePlacementEditor
          title={title.trim() || selectedTemplate?.title || 'Document'}
          content={documentContent}
          fieldValues={placementSampleValues}
          signers={signerConfigs.map((s) => ({ index: s.index, role: s.role }))}
          value={activePlacements}
          onSave={savePlacements}
          onClose={() => setPlacementEditorOpen(false)}
          footer={
            selectedTemplate ? (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={saveToTemplate} onChange={(e) => setSaveToTemplate(e.target.checked)} className="mt-0.5 accent-primary" />
                <span>Also save as the default for “{selectedTemplate.title}”</span>
              </label>
            ) : null
          }
        />
      )}
    </div>
  );
}
