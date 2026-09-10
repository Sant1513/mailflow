'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  updatedAt: string;
  _count: { versions: number };
  versions: { version: number; subject: string; createdAt: string }[];
}

export default function TemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/templates?includeArchived=${showArchived}`);
    const json = await res.json();
    setTemplates(json.templates ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  async function createTemplate() {
    const name = prompt('Template name (e.g. "RPG Clearance Reminder")');
    if (!name) return;
    setCreating(true);
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        subject: '',
        html: STARTER_HTML,
      }),
    });
    setCreating(false);
    if (!res.ok) {
      toast.error('Failed to create template');
      return;
    }
    const json = await res.json();
    router.push(`/templates/${json.template.id}`);
  }

  async function duplicate(id: string) {
    const res = await fetch(`/api/templates/${id}/duplicate`, { method: 'POST' });
    if (!res.ok) {
      toast.error('Failed to duplicate');
      return;
    }
    toast.success('Template duplicated');
    load();
  }

  async function archive(id: string, archived: boolean) {
    const res = await fetch(`/api/templates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    if (!res.ok) {
      toast.error('Failed to update');
      return;
    }
    toast.success(archived ? 'Template archived' : 'Template restored');
    load();
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Templates</h1>
          <p className="text-sm text-muted-foreground">
            HTML/CSS email templates with variables, versioning, and personalized preview.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <button
            onClick={createTemplate}
            disabled={creating}
            className="btn-primary"
          >
            {creating ? 'Creating…' : 'New template'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : templates.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">
          Create your first email template.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Subject</th>
                <th className="px-4 py-2">Versions</th>
                <th className="px-4 py-2">Updated</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-t hover:bg-elevated/60">
                  <td className="px-4 py-2">
                    <Link href={`/templates/${t.id}`} className="font-medium text-primary hover:underline">
                      {t.name}
                    </Link>
                    {t.archived && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px]">ARCHIVED</span>}
                    {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {t.versions[0]?.subject || <span className="italic">no subject yet</span>}
                  </td>
                  <td className="px-4 py-2">v{t.versions[0]?.version ?? 1} ({t._count.versions})</td>
                  <td className="px-4 py-2 text-muted-foreground">{new Date(t.updatedAt).toLocaleString()}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2 text-xs">
                      <button onClick={() => duplicate(t.id)} className="text-muted-foreground hover:text-foreground">
                        Duplicate
                      </button>
                      <button
                        onClick={() => archive(t.id, !t.archived)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        {t.archived ? 'Restore' : 'Archive'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const STARTER_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
        <tr>
          <td style="padding:24px 32px;border-bottom:1px solid #e6e9ee;">
            <strong style="font-size:16px;color:#12263f;">Masai School</strong>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;color:#3c4858;font-size:14px;line-height:1.6;">
            <p style="margin:0 0 16px;">Dear {{Name}},</p>
            <p style="margin:0 0 16px;">Write your message here.</p>
            <p style="margin:0;">Regards,<br />Placement Team<br />Masai School</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;background:#f4f6f8;color:#8492a6;font-size:12px;">
            This is an internal communication from Masai School.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
