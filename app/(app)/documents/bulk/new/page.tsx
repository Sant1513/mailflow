'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface FieldDef {
  key: string;
  label: string;
  defaultValue?: string;
}

interface SigningTemplate {
  id: string;
  title: string;
  content: string;
  fieldDefs: FieldDef[];
}

interface Recipient {
  name: string;
  email: string;
  fieldValues: Record<string, string>;
}

export default function NewBulkSendPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Form state
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [ccEmails, setCcEmails] = useState('placements@masaischool.com');
  const [expiresInDays, setExpiresInDays] = useState(7);

  // Templates
  const [templates, setTemplates] = useState<SigningTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<SigningTemplate | null>(null);

  // Manual recipients
  const [recipients, setRecipients] = useState<Recipient[]>([{ name: '', email: '', fieldValues: {} }]);

  // CSV import state
  const [csvRows, setCsvRows] = useState<Recipient[] | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);

  // Load templates on mount
  useEffect(() => {
    fetch('/api/signing-templates')
      .then((res) => res.json())
      .then((data: { templates?: SigningTemplate[] }) => {
        setTemplates(data.templates ?? []);
      })
      .catch(() => {});
  }, []);

  // Sync selectedTemplate whenever templateId changes
  useEffect(() => {
    if (!templateId) {
      setSelectedTemplate(null);
      return;
    }
    const tpl = templates.find((t) => t.id === templateId) ?? null;
    setSelectedTemplate(tpl);
  }, [templateId, templates]);

  const fieldDefs: FieldDef[] = selectedTemplate?.fieldDefs ?? [];

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

  // ── CSV parser ────────────────────────────────────────────────────────────

  const handleCsvFile = useCallback((file: File) => {
    setCsvError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = (e.target?.result as string) ?? '';
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        setCsvError('CSV must have a header row and at least one data row.');
        return;
      }
      const headers = lines[0]!
        .split(',')
        .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
      const nameIdx = headers.indexOf('name');
      const emailIdx = headers.indexOf('email');
      if (nameIdx === -1 || emailIdx === -1) {
        setCsvError('CSV must include "name" and "email" columns.');
        return;
      }
      const parsed: Recipient[] = [];
      for (let row = 1; row < lines.length; row++) {
        const cols = lines[row]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
        const name = cols[nameIdx] ?? '';
        const email = cols[emailIdx] ?? '';
        if (!name || !email) continue;
        parsed.push({ name, email, fieldValues: {} });
      }
      if (parsed.length === 0) {
        setCsvError('No valid rows found in CSV.');
        return;
      }
      setCsvRows(parsed);
    };
    reader.readAsText(file);
  }, []);

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
        })),
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
      `Bulk send created — ${validRecipients.length} request${validRecipients.length !== 1 ? 's' : ''} sent`,
    );
    router.push('/documents/bulk');
  }

  const validCount = recipients.filter((r) => r.name.trim() && r.email.trim()).length;

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
            <label className="mb-1 block text-sm font-medium">Template (optional)</label>
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
          </div>

          {selectedTemplate && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Template Preview
              </div>
              <div
                className="rounded-md border bg-background p-3 prose prose-sm max-w-none overflow-auto max-h-36 text-foreground text-xs"
                dangerouslySetInnerHTML={{ __html: selectedTemplate.content }}
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

        {/* ── Recipients ────────────────────────────────────────────────── */}
        <div className="rounded-lg border bg-card p-5">
          <div className="eyebrow mb-3">Recipients</div>

          {/* CSV Upload */}
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3">
            <div className="flex-1 min-w-[180px]">
              <p className="text-xs font-medium">Upload CSV</p>
              <p className="text-xs text-muted-foreground">
                Must include <code className="font-mono">name</code> and{' '}
                <code className="font-mono">email</code> columns.
              </p>
            </div>
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

          {csvError && <p className="mb-3 text-xs text-destructive">{csvError}</p>}

          {/* CSV Preview */}
          {csvRows && (
            <div className="mb-4 rounded-md border bg-muted/20 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {csvRows.length} row{csvRows.length !== 1 ? 's' : ''} parsed — review before sending:
              </p>
              <div className="max-h-40 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground text-left">
                      <th className="px-2 py-1">Name</th>
                      <th className="px-2 py-1">Email</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvRows.slice(0, 20).map((r, i) => (
                      <tr key={i} className="border-t border-border-subtle">
                        <td className="px-2 py-1">{r.name}</td>
                        <td className="px-2 py-1">{r.email}</td>
                      </tr>
                    ))}
                    {csvRows.length > 20 && (
                      <tr>
                        <td colSpan={2} className="px-2 py-1 text-muted-foreground italic">
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
                    <th key={fd.key} className="px-2 py-1 text-left min-w-[120px]">
                      {fd.label}
                    </th>
                  ))}
                  <th className="px-2 py-1 w-8" />
                </tr>
              </thead>
              <tbody>
                {recipients.map((r, i) => (
                  <tr key={i} className="border-t border-border-subtle">
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={r.name}
                        onChange={(e) => updateRecipientField(i, 'name', e.target.value)}
                        placeholder="Full name"
                        className="w-full text-sm"
                      />
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
                    {fieldDefs.map((fd) => (
                      <td key={fd.key} className="px-2 py-1">
                        <input
                          type="text"
                          value={r.fieldValues[fd.key] ?? ''}
                          onChange={(e) => updateRecipientCustomField(i, fd.key, e.target.value)}
                          placeholder={fd.defaultValue ?? fd.label}
                          className="w-full text-sm"
                        />
                      </td>
                    ))}
                    <td className="px-2 py-1">
                      {recipients.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeRecipient(i)}
                          className="text-xs text-muted-foreground hover:text-primary px-1"
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
    </div>
  );
}
