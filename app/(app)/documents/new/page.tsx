'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

interface FieldPair {
  key: string;
  value: string;
}

interface FieldDef {
  key: string;
  label: string;
  defaultValue?: string;
}

interface SigningTemplate {
  id: string;
  title: string;
  description?: string | null;
  content: string;
  fieldDefs: FieldDef[];
  signaturePlacements?: unknown[];
}

export default function NewSigningRequestPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [attachments, setAttachments] = useState<{ name: string; url: string; contentType: string; size: number }[]>([]);
  const [uploading, setUploading] = useState(false);

  // Template picker state
  const [templates, setTemplates] = useState<SigningTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateLoading, setTemplateLoading] = useState(false);
  const [signaturePlacements, setSignaturePlacements] = useState<unknown[]>([]);

  /** Load all templates for the dropdown. */
  useEffect(() => {
    fetch('/api/signing-templates')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { templates: SigningTemplate[] } | null) => {
        if (data) setTemplates(data.templates);
      })
      .catch(() => {});
  }, []);

  /** If ?templateId= is set in the URL, pre-fill the form from that template. */
  useEffect(() => {
    const templateId = searchParams.get('templateId');
    if (!templateId) return;

    setTemplateLoading(true);
    fetch(`/api/signing-templates/${templateId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { template: SigningTemplate } | null) => {
        if (data?.template) {
          applyTemplate(data.template);
          setSelectedTemplateId(data.template.id);
        }
      })
      .catch(() => {})
      .finally(() => setTemplateLoading(false));
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyTemplate(tpl: SigningTemplate) {
    setTitle(tpl.title);
    setContent(tpl.content);
    setSignaturePlacements(Array.isArray(tpl.signaturePlacements) ? tpl.signaturePlacements : []);
    const newFields: FieldPair[] = tpl.fieldDefs.map((fd) => ({
      key: fd.key,
      value: fd.defaultValue ?? '',
    }));
    setFields(newFields.length > 0 ? newFields : [{ key: '', value: '' }]);
  }

  async function handleTemplateSelect(id: string) {
    setSelectedTemplateId(id);
    if (!id) {
      setSignaturePlacements([]);
      return;
    }
    setTemplateLoading(true);
    const res = await fetch(`/api/signing-templates/${id}`);
    if (res.ok) {
      const data = (await res.json()) as { template: SigningTemplate };
      applyTemplate(data.template);
      toast.success(`Template "${data.template.title}" loaded.`);
    } else {
      toast.error('Could not load template.');
    }
    setTemplateLoading(false);
  }

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
        attachments,
        ccEmails: ccList,
        expiresInDays,
        signaturePlacements,
        ...(emailSubject.trim() ? { emailSubject: emailSubject.trim() } : {}),
        ...(emailBody.trim() ? { emailBody: emailBody.trim() } : {}),
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

      {/* Template picker */}
      {templates.length > 0 && (
        <div className="mb-6 rounded-lg border bg-card p-4 flex items-center gap-3">
          <label className="text-sm font-medium shrink-0">Load from template</label>
          <select
            value={selectedTemplateId}
            onChange={(e) => handleTemplateSelect(e.target.value)}
            disabled={templateLoading}
            className="flex-1 text-sm"
          >
            <option value="">— choose a template —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          {templateLoading && (
            <span className="text-xs text-muted-foreground">Loading…</span>
          )}
          <Link
            href="/documents/templates"
            className="text-xs text-primary hover:underline shrink-0"
          >
            Manage templates
          </Link>
        </div>
      )}

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

        {/* Email Customization */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="eyebrow mb-1">Invitation email (optional)</div>
          <p className="text-xs text-muted-foreground -mt-2">
            Leave blank to use the default template. Available placeholders:{' '}
            {['{{student_name}}', '{{document_name}}', '{{signing_link}}', '{{admin_name}}'].map((p) => (
              <code
                key={p}
                className="font-mono text-xs bg-muted px-1 py-0.5 rounded mr-1 cursor-pointer hover:bg-primary/10"
                onClick={() => setEmailSubject((s) => s + p)}
                title="Click to insert in Subject"
              >
                {p}
              </code>
            ))}
          </p>
          <div>
            <label className="mb-1 block text-sm font-medium">Subject</label>
            <input
              type="text"
              value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
              placeholder="[Action Required] Please sign: {{document_name}}"
              className="w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Body (HTML allowed)</label>
            <textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              rows={5}
              placeholder={`<p>Hi {{student_name}},</p>\n<p>Please review and sign the attached document at your earliest convenience.</p>`}
              className="w-full font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The signing button and document details are always appended automatically.
            </p>
          </div>
        </div>

        {/* Additional Attachments */}
        <div className="rounded-lg border bg-card p-5 space-y-3">
          <div className="eyebrow mb-1">Additional attachments <span className="text-muted-foreground font-normal normal-case text-xs">(optional)</span></div>
          <p className="text-xs text-muted-foreground -mt-2">
            Files attached here are included in the signing email AND the post-signing confirmation email. PDF, Word, JPEG, PNG — max 10 MB each.
          </p>
          {attachments.length > 0 && (
            <ul className="space-y-1">
              {attachments.map((a, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">{a.name}</span>
                  <span className="text-xs text-muted-foreground">{(a.size / 1024).toFixed(0)} KB</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >✕</button>
                </li>
              ))}
            </ul>
          )}
          <label className="inline-flex items-center gap-2 cursor-pointer rounded border border-dashed px-4 py-2 text-sm text-muted-foreground hover:text-primary hover:border-primary transition">
            {uploading ? 'Uploading…' : '+ Attach files'}
            <input type="file" multiple accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" className="sr-only" onChange={handleAttachFiles} disabled={uploading} />
          </label>
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
