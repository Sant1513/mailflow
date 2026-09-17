'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface SigningBatch {
  id: string;
  title: string;
  totalCount: number;
  sentCount: number;
  signedCount: number;
  createdAt: string;
  template: { title: string } | null;
}

export default function BulkSendingPage() {
  const router = useRouter();
  const [batches, setBatches] = useState<SigningBatch[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const res = await fetch('/api/signing-batches');
      setLoading(false);
      if (!res.ok) return;
      const json = (await res.json()) as { batches: SigningBatch[] };
      setBatches(json.batches ?? []);
    }
    load();
  }, []);

  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' });

  return (
    <div className="p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Bulk Sending</h1>
          <p className="text-sm text-muted-foreground">
            Send signing requests to multiple recipients at once.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-muted-foreground">Loading…</span>}
          <Link href="/documents/bulk/new" className="btn-primary">
            New Bulk Send
          </Link>
        </div>
      </div>

      {!loading && batches.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground">No bulk sends yet.</div>
      ) : (
        <div className="overflow-x-auto overflow-hidden rounded-lg border bg-card">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Template</th>
                <th className="px-4 py-2">Progress</th>
                <th className="px-4 py-2 whitespace-nowrap">Counts</th>
                <th className="px-4 py-2 whitespace-nowrap">Date</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch, i) => {
                const pct =
                  batch.totalCount > 0
                    ? Math.round((batch.signedCount / batch.totalCount) * 100)
                    : 0;
                return (
                  <tr
                    key={batch.id}
                    className={`border-t border-border-subtle cursor-pointer hover:bg-muted/30 ${
                      i % 2 === 1 ? 'bg-muted/20' : ''
                    }`}
                    onClick={() => router.push(`/documents/bulk/${batch.id}`)}
                  >
                    <td className="px-4 py-2 font-medium">{batch.title}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {batch.template ? (
                        batch.template.title
                      ) : (
                        <span className="italic text-xs">None</span>
                      )}
                    </td>
                    <td className="px-4 py-2 min-w-[140px]">
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-2 rounded-full bg-green-500 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground w-8 text-right">
                          {pct}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {batch.signedCount}/{batch.totalCount} signed · {batch.sentCount} sent
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {fmt(batch.createdAt)}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/documents/bulk/${batch.id}`}
                        className="text-xs text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
