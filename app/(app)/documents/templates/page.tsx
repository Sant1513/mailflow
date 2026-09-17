'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

interface FieldDef {
  key: string;
  label: string;
  defaultValue?: string;
}

interface SigningTemplate {
  id: string;
  title: string;
  description?: string | null;
  fieldDefs: FieldDef[];
  archived: boolean;
  createdAt: string;
}

export default function DocumentTemplatesPage() {
  const [templates, setTemplates] = useState<SigningTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [archiving, setArchiving] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch('/api/signing-templates');
    if (res.ok) {
      const data = (await res.json()) as { templates: SigningTemplate[] };
      setTemplates(data.templates);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function archiveTemplate(id: string) {
    setArchiving(id);
    const res = await fetch(`/api/signing-templates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    setArchiving(null);
    if (res.ok) {
      toast.success('Template archived.');
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } else {
      toast.error('Failed to archive template.');
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="mb-1">
            <Link href="/documents" className="text-sm text-muted-foreground hover:text-foreground">
              ← Documents
            </Link>
          </div>
          <h1 className="text-xl font-semibold">Document Templates</h1>
        </div>
        <Link href="/documents/templates/new" className="btn-primary">
          New Template
        </Link>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-muted-foreground">No templates yet.</p>
          <div className="mt-4">
            <Link href="/documents/templates/new" className="btn-primary">
              Create your first template
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <div key={t.id} className="rounded-lg border bg-card p-5 flex flex-col gap-3">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-semibold text-foreground leading-snug">{t.title}</h2>
                  <span className="badge shrink-0">
                    {t.fieldDefs.length} field{t.fieldDefs.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {t.description && (
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                    {t.description}
                  </p>
                )}
              </div>
              <div className="mt-auto flex items-center gap-2">
                <Link
                  href={`/documents/new?templateId=${t.id}`}
                  className="btn-primary text-sm flex-1 text-center"
                >
                  Use
                </Link>
                <Link
                  href={`/documents/templates/${t.id}`}
                  className="btn-secondary text-sm px-3"
                >
                  Edit
                </Link>
                <button
                  type="button"
                  onClick={() => archiveTemplate(t.id)}
                  disabled={archiving === t.id}
                  className="btn-secondary text-sm px-3 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  title="Archive template"
                >
                  {archiving === t.id ? '…' : 'Archive'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
