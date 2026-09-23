'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { labelForSigningField } from '@/lib/signing/fields';
import type { SignaturePlacement } from '@/lib/signing/placements';
import { DocumentHtmlPane, PdfPane, PreviewTabs, usePdfPreview, type PreviewPayload } from './SigningDocPreview';

interface RequestDetail {
  id: string;
  title: string;
  content: string;
  status: string;
  recipientName: string;
  recipientEmail: string;
  signerRole: string | null;
  groupId: string | null;
  fieldValues: Record<string, string>;
  lockedFields: string[];
  fieldKeys: string[];
  signaturePlacements: SignaturePlacement[];
}

interface GroupMember {
  id: string;
  recipientName: string;
  recipientEmail: string;
  signerRole: string | null;
  signerOrder: number;
  status: string;
}

interface Loaded {
  request: RequestDetail;
  groupMembers: GroupMember[];
  editable: boolean;
  lockReason: string | null;
}

/**
 * Preview a sent request and, until anyone signs, correct its details and
 * notify the signer(s). The server re-checks the lock on save.
 */
export function EditSigningRequestModal({
  requestId,
  onClose,
  onSaved,
}: {
  requestId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'doc' | 'pdf'>('doc');
  const pdf = usePdfPreview();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/e-sign/${requestId}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as Loaded & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          toast.error(json.error ?? 'Could not load the document');
          onCloseRef.current();
          return;
        }
        setData(json);
        setValues(json.request.fieldValues);
        setName(json.request.recipientName);
        setEmail(json.request.recipientEmail);
      })
      .catch(() => {
        if (!cancelled) {
          toast.error('Could not load the document');
          onCloseRef.current();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const signers = useMemo(() => {
    if (!data) return [];
    if (data.groupMembers.length > 0) {
      return data.groupMembers.map((m) => ({ role: m.signerRole ?? `Signer ${m.signerOrder + 1}`, name: m.recipientName }));
    }
    return [{ role: data.request.signerRole ?? 'Signer', name }];
  }, [data, name]);

  const payload: PreviewPayload | null = data
    ? {
        title: data.request.title,
        content: data.request.content,
        fieldValues: values,
        signers,
        recipientName: name,
        recipientEmail: email,
        placements: data.request.signaturePlacements,
      }
    : null;

  const changedKeys = data ? data.request.fieldKeys.filter((k) => (data.request.fieldValues[k] ?? '') !== (values[k] ?? '')) : [];
  const identityChanged = !!data && (name.trim() !== data.request.recipientName || email.trim().toLowerCase() !== data.request.recipientEmail);
  const dirty = changedKeys.length > 0 || identityChanged;

  async function save() {
    if (!data || !dirty) return;
    setSaving(true);
    const res = await fetch(`/api/e-sign/${requestId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update',
        fieldValues: Object.fromEntries(changedKeys.map((k) => [k, values[k] ?? ''])),
        ...(name.trim() !== data.request.recipientName ? { recipientName: name.trim() } : {}),
        ...(email.trim().toLowerCase() !== data.request.recipientEmail ? { recipientEmail: email.trim() } : {}),
        notify,
      }),
    });
    setSaving(false);
    const json = (await res.json().catch(() => ({}))) as { error?: string; notified?: number };
    if (!res.ok) {
      toast.error(json.error ?? 'Could not save the changes');
      return;
    }
    toast.success(
      notify && json.notified
        ? `Saved · ${json.notified} signer${json.notified !== 1 ? 's' : ''} notified`
        : 'Saved',
    );
    onSaved?.();
    onClose();
  }

  function openPdf() {
    setTab('pdf');
    if (payload) void pdf.generate(payload);
  }

  const readOnly = !data?.editable;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 sm:p-6" onClick={() => !saving && onClose()}>
      <div className="panel flex w-full max-w-6xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit signing request">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="eyebrow">{readOnly ? 'Sent document' : 'Edit sent document'}</div>
            <div className="truncate text-base font-bold">{data?.request.title ?? 'Loading…'}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {data && <PreviewTabs tab={tab} onDoc={() => setTab('doc')} onPdf={openPdf} />}
            <button type="button" onClick={onClose} disabled={saving} className="btn-secondary !py-1.5 text-xs">
              Close
            </button>
          </div>
        </div>

        {!data ? (
          <div className="flex flex-1 items-center justify-center p-10 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[360px_1fr] lg:overflow-hidden">
            <aside className="min-h-0 space-y-4 overflow-y-auto border-b p-4 lg:border-b-0 lg:border-r">
              {data.lockReason ? (
                <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">{data.lockReason}</div>
              ) : (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                  Nobody has signed yet, so you can still correct these details. Changes are locked as soon as any signer signs.
                </div>
              )}

              {data.groupMembers.length > 1 && (
                <div>
                  <div className="eyebrow mb-1">Signers</div>
                  <ul className="space-y-1 text-xs">
                    {data.groupMembers.map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          {m.signerOrder + 1}. {m.recipientName}
                          <span className="text-muted-foreground"> · {m.signerRole ?? `Signer ${m.signerOrder + 1}`}</span>
                        </span>
                        <span className="badge text-[10px]">{m.status}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-2">
                <div className="eyebrow">Recipient{data.request.signerRole ? ` · ${data.request.signerRole}` : ''}</div>
                <input value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} className="w-full text-sm" placeholder="Full name" />
                <input value={email} onChange={(e) => setEmail(e.target.value)} disabled={readOnly} type="email" className="w-full text-sm" placeholder="email@example.com" />
              </div>

              {data.request.fieldKeys.length > 0 && (
                <div className="space-y-2">
                  <div className="eyebrow">Document details</div>
                  {data.request.fieldKeys.map((k) => {
                    const blank = !(values[k] ?? '').trim();
                    return (
                      <label key={k} className="block">
                        <span className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          {labelForSigningField(k)}
                          {blank && <span className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800">Signer fills</span>}
                          {changedKeys.includes(k) && <span className="rounded bg-blue-100 px-1 text-[10px] font-medium text-blue-800">Changed</span>}
                        </span>
                        <input
                          value={values[k] ?? ''}
                          onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
                          disabled={readOnly}
                          placeholder="Leave blank for the signer to fill"
                          className="w-full text-sm"
                        />
                      </label>
                    );
                  })}
                </div>
              )}

              {!readOnly && (
                <div className="space-y-3 border-t pt-3">
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 accent-primary" />
                    <span>Email the active signer(s) that the document was updated (same signing link).</span>
                  </label>
                  <button type="button" onClick={save} disabled={!dirty || saving} className="btn-primary w-full disabled:opacity-50">
                    {saving ? 'Saving…' : notify ? 'Save & resend' : 'Save changes'}
                  </button>
                </div>
              )}
            </aside>

            <div className="min-h-0 overflow-y-auto bg-muted/30 p-4">
              {payload &&
                (tab === 'doc' ? (
                  <DocumentHtmlPane payload={payload} />
                ) : (
                  <PdfPane url={pdf.url} loading={pdf.loading} onGenerate={() => void pdf.generate(payload)} />
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
