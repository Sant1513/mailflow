'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { SignatureTokenInserter } from '@/components/documents/SignatureTokenInserter';
import { renderSignatureTokensHtml } from '@/lib/signing/signature-tokens';

interface FieldDef {
  key: string;
  label: string;
  defaultValue: string;
}

export default function NewTemplatePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [fieldDefs, setFieldDefs] = useState<FieldDef[]>([
    { key: '', label: '', defaultValue: '' },
  ]);

  function addField() {
    setFieldDefs((prev) => [...prev, { key: '', label: '', defaultValue: '' }]);
  }

  function removeField(index: number) {
    setFieldDefs((prev) => prev.filter((_, i) => i !== index));
  }

  function updateField(index: number, part: keyof FieldDef, val: string) {
    setFieldDefs((prev) =>
      prev.map((f, i) => (i === index ? { ...f, [part]: val } : f))
    );
  }

  /** Replace {{key}} in content with defaultValues for preview. */
  function buildPreview(): string {
    let out = content;
    for (const fd of fieldDefs) {
      if (fd.key.trim()) {
        out = out.replaceAll(`{{${fd.key.trim()}}}`, fd.defaultValue);
      }
    }
    return renderSignatureTokensHtml(out, []);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) {
      toast.error('Title and content are required.');
      return;
    }

    const validFields = fieldDefs.filter((fd) => fd.key.trim() && fd.label.trim());

    setSubmitting(true);
    const res = await fetch('/api/signing-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        description: description.trim() || undefined,
        content: content.trim(),
        fieldDefs: validFields.map((fd) => ({
          key: fd.key.trim(),
          label: fd.label.trim(),
          ...(fd.defaultValue.trim() ? { defaultValue: fd.defaultValue.trim() } : {}),
        })),
      }),
    });
    setSubmitting(false);

    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(json.error ?? 'Failed to create template.');
      return;
    }

    toast.success('Template created.');
    router.push('/documents/templates');
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/documents/templates"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Templates
        </Link>
        <h1 className="text-xl font-semibold">New Document Template</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic info */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="eyebrow mb-3">Template Details</div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              Title <span className="text-primary">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Internship Offer Letter"
              required
              className="w-full"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Brief description of what this template is for."
              className="w-full text-sm"
            />
          </div>
        </div>

        {/* Field definitions */}
        <div className="rounded-lg border bg-card p-5">
          <div className="eyebrow mb-3">Field Definitions</div>
          <p className="mb-3 text-xs text-muted-foreground">
            Define the variables used in this template. Use{' '}
            <code className="font-mono">{'{{key}}'}</code> in the content body. The{' '}
            <strong>default value</strong> is shown in previews and pre-filled when creating a signing
            request.
          </p>

          {fieldDefs.length > 0 && (
            <div className="mb-2 grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs font-medium text-muted-foreground px-1">
              <span>Key (variable name)</span>
              <span>Label</span>
              <span>Default value</span>
              <span />
            </div>
          )}

          <div className="space-y-2">
            {fieldDefs.map((fd, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                <input
                  type="text"
                  value={fd.key}
                  onChange={(e) => updateField(i, 'key', e.target.value)}
                  placeholder="e.g. stipend"
                  className="text-sm font-mono"
                />
                <input
                  type="text"
                  value={fd.label}
                  onChange={(e) => updateField(i, 'label', e.target.value)}
                  placeholder="e.g. Monthly Stipend"
                  className="text-sm"
                />
                <input
                  type="text"
                  value={fd.defaultValue}
                  onChange={(e) => updateField(i, 'defaultValue', e.target.value)}
                  placeholder="e.g. ₹15,000/month"
                  className="text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeField(i)}
                  className="text-xs text-muted-foreground hover:text-primary px-1"
                  aria-label="Remove field"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addField}
            className="mt-3 text-xs text-primary hover:underline"
          >
            + Add field
          </button>
        </div>

        {/* Content */}
        <div className="rounded-lg border bg-card p-5">
          <div className="eyebrow mb-1">Document Content</div>
          <p className="mb-3 text-xs text-muted-foreground">
            HTML or plain text. Use <code className="font-mono">{'{{key}}'}</code> placeholders
            matching the field keys above.
          </p>
          <SignatureTokenInserter textareaRef={contentRef} content={content} onChange={setContent} />
          <textarea
            ref={contentRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={18}
            required
            placeholder={`<p>Dear {{recipient_name}},</p>\n\n<p>We are pleased to offer you an internship at Masai School.</p>\n\n<p><strong>Stipend:</strong> {{stipend}}</p>\n\n<p>Please sign below to confirm your acceptance.</p>`}
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
            <span className="text-muted-foreground text-xs">
              {previewOpen ? '▲ Hide' : '▼ Show'}
            </span>
          </button>
          {previewOpen && (
            <div className="border-t px-5 pb-5 pt-4">
              <p className="mb-2 text-xs text-muted-foreground">
                Variables are replaced with their default values.
              </p>
              <div
                className="rounded-md border bg-background p-4 prose prose-sm max-w-none overflow-auto max-h-96 text-foreground"
                dangerouslySetInnerHTML={{ __html: buildPreview() }}
              />
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 justify-end">
          <Link href="/documents/templates" className="btn-secondary">
            Cancel
          </Link>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Saving…' : 'Create Template'}
          </button>
        </div>
      </form>
    </div>
  );
}
