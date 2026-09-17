'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface FieldPair {
  key: string;
  value: string;
}

export default function NewSigningRequestPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [ccEmails, setCcEmails] = useState('placements@masaischool.com');
  const [content, setContent] = useState('');
  const [fields, setFields] = useState<FieldPair[]>([{ key: '', value: '' }]);
  const [expiresInDays, setExpiresInDays] = useState(7);

  function addField() {
    setFields((prev) => [...prev, { key: '', value: '' }]);
  }

  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }

  function updateField(index: number, part: 'key' | 'value', val: string) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, [part]: val } : f)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !recipientName.trim() || !recipientEmail.trim() || !content.trim()) {
      toast.error('Please fill in all required fields.');
      return;
    }

    const fieldValues: Record<string, string> = {};
    for (const f of fields) {
      if (f.key.trim()) fieldValues[f.key.trim()] = f.value;
    }

    const ccList = ccEmails
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    setSubmitting(true);
    const res = await fetch('/api/e-sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        content: content.trim(),
        recipientName: recipientName.trim(),
        recipientEmail: recipientEmail.trim(),
        fieldValues,
        ccEmails: ccList,
        expiresInDays,
      }),
    });
    setSubmitting(false);

    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(json.error ?? 'Failed to send signing request');
      return;
    }

    toast.success('Signing request sent successfully');
    router.push('/documents');
  }

  /** Replace {{variable}} placeholders in content with field values for preview */
  function buildPreview(): string {
    let out = content;
    for (const f of fields) {
      if (f.key.trim()) {
        out = out.replaceAll(`{{${f.key.trim()}}}`, f.value);
      }
    }
    if (recipientName) out = out.replaceAll('{{recipient_name}}', recipientName);
    return out;
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/documents" className="text-sm text-muted-foreground hover:text-foreground">
          ← Documents
        </Link>
        <h1 className="text-xl font-semibold">New Signing Request</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="eyebrow mb-3">Document Details</div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              Document title <span className="text-primary">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Internship Offer Letter — Jan 2026"
              required
              className="w-full"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">
                Recipient name <span className="text-primary">*</span>
              </label>
              <input
                type="text"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                placeholder="Rahul Sharma"
                required
                className="w-full"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Recipient email <span className="text-primary">*</span>
              </label>
              <input
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="rahul@example.com"
                required
                className="w-full"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">CC emails</label>
            <textarea
              value={ccEmails}
              onChange={(e) => setCcEmails(e.target.value)}
              rows={2}
              placeholder="One email per line"
              className="w-full font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">One email per line. These addresses receive a copy.</p>
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

        {/* Custom Fields */}
        <div className="rounded-lg border bg-card p-5">
          <div className="eyebrow mb-3">Custom fields</div>
          <p className="mb-3 text-xs text-muted-foreground">
            Add key-value pairs that will replace <code className="font-mono">{'{{key}}'}</code> placeholders in the document content.
          </p>
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={f.key}
                  onChange={(e) => updateField(i, 'key', e.target.value)}
                  placeholder="Variable name (e.g. stipend)"
                  className="flex-1 text-sm"
                />
                <span className="text-muted-foreground text-sm">→</span>
                <input
                  type="text"
                  value={f.value}
                  onChange={(e) => updateField(i, 'value', e.target.value)}
                  placeholder="Value (e.g. ₹15,000/month)"
                  className="flex-1 text-sm"
                />
                {fields.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeField(i)}
                    className="text-xs text-muted-foreground hover:text-primary px-1"
                    aria-label="Remove field"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={addField} className="mt-3 text-xs text-primary hover:underline">
            + Add field
          </button>
        </div>

        {/* Document Content */}
        <div className="rounded-lg border bg-card p-5">
          <div className="eyebrow mb-1">Document content</div>
          <p className="mb-3 text-xs text-muted-foreground">
            You can use HTML for formatting. Variables like{' '}
            <code className="font-mono">{'{{student_name}}'}</code> will be replaced with field values.
          </p>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={16}
            required
            placeholder={`<p>Dear {{recipient_name}},</p>\n\n<p>We are pleased to offer you an internship opportunity at Masai School.</p>\n\n<p><strong>Stipend:</strong> {{stipend}}</p>\n\n<p>Please sign below to confirm your acceptance.</p>`}
            className="w-full font-mono text-sm"
          />
        </div>

        {/* Preview */}
        <div className="rounded-lg border bg-card">
          <button
            type="button"
            onClick={() => setPreviewOpen((o) => !o)}
            className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium"
          >
            <span>Preview</span>
            <span className="text-muted-foreground text-xs">{previewOpen ? '▲ Hide' : '▼ Show'}</span>
          </button>
          {previewOpen && (
            <div className="border-t px-5 pb-5 pt-4">
              <p className="mb-2 text-xs text-muted-foreground">
                This is how the document will look to the recipient (variables substituted).
              </p>
              <div
                className="rounded-md border bg-background p-4 prose prose-sm max-w-none overflow-auto max-h-96 text-foreground"
                dangerouslySetInnerHTML={{ __html: buildPreview() }}
              />
            </div>
          )}
        </div>

        {/* Submit */}
        <div className="flex items-center gap-3 justify-end">
          <Link href="/documents" className="btn-secondary">
            Cancel
          </Link>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Sending…' : 'Send for Signature'}
          </button>
        </div>
      </form>
    </div>
  );
}
