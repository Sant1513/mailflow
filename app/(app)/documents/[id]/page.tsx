'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { PdfPages } from '@/components/documents/PdfPages';
import { useDocumentPreview } from '@/components/documents/PdfPreviewDialog';
import { PaneDivider, usePaneWidths } from '@/components/email-editor/PaneDivider';
import { boxAtPoint, clampBox, moveBox, nextFieldId, resizeBox, toPixels, type Box } from '@/lib/documents/geometry';
import { guessVariableForFormField, SYSTEM_VARIABLE_HELP, SYSTEM_VARIABLES } from '@/lib/documents/values';
import {
  CASE_FORMATS,
  DATE_FORMATS,
  FONTS,
  LOCK_MODES,
  LOCK_MODE_LABELS,
  NUMBER_FORMATS,
  type DetectedFormField,
  type DocumentField,
  type DocumentInspection,
  type DocumentIssue,
  type LockMode,
} from '@/lib/documents/types';

interface DocumentDetail {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  fileNamePattern: string;
  lockMode: LockMode;
  stampReference: boolean;
  fields: DocumentField[];
  updatedAt: string;
  owner: { name: string; email: string };
  file: { id: string; fileName: string; size: number; pageCount: number; sha256: string };
}

interface Payload {
  document: DocumentDetail;
  inspection: DocumentInspection;
  issues: DocumentIssue[];
  campaigns: { id: string; name: string; status: string; snapshotAt: string }[];
  canEdit: boolean;
}

const NUMBER_LABELS: Record<string, string> = { indian: 'Indian 1,50,000', international: 'Intl 150,000', inr: 'Rs. 1,50,000' };
const CASE_LABELS: Record<string, string> = { upper: 'UPPERCASE', lower: 'lowercase', title: 'Title Case' };
const FONT_LABELS: Record<string, string> = { Helvetica: 'Helvetica', HelveticaBold: 'Helvetica Bold', TimesRoman: 'Times', TimesRomanBold: 'Times Bold', Courier: 'Courier' };
const TYPE_LABELS: Record<string, string> = {
  text: 'text',
  checkbox: 'checkbox',
  dropdown: 'dropdown',
  radio: 'radio buttons',
  optionList: 'list',
  button: 'button',
  signature: 'signature',
  unknown: 'unsupported',
};
const UNFILLABLE = new Set(['button', 'signature', 'unknown']);

/** Overlay colours sit on a white PDF page, so they are fixed rather than theme tokens. */
const COLORS = {
  formOpen: { border: '1px dashed rgb(14 165 233)', background: 'rgba(56, 189, 248, 0.12)' },
  formMapped: { border: '1px solid rgb(22 163 74)', background: 'rgba(34, 197, 94, 0.16)' },
  formDisabled: { border: '1px dashed rgb(163 163 163)', background: 'rgba(212, 212, 212, 0.15)' },
  text: { border: '1px solid rgb(217 119 6)', background: 'rgba(252, 211, 77, 0.22)' },
  selected: { border: '2px solid rgb(237 3 49)', background: 'rgba(237, 3, 49, 0.12)' },
};

function humanize(name: string): string {
  const text = name
    .replace(/[_.-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 80) || 'Field';
}

function newField(id: string, label: string, target: DocumentField['target'], value = ''): DocumentField {
  return {
    id,
    label,
    value,
    required: true,
    format: {},
    target,
    style: { font: 'Helvetica', fontSize: 11, color: '#111111', align: 'left', multiline: false },
  };
}

type Drag = { fieldId: string; mode: 'move' | 'resize'; startX: number; startY: number; box: Box; page: number };

export default function DocumentEditorPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Payload | null>(null);
  const [name, setName] = useState('');
  const [fields, setFields] = useState<DocumentField[]>([]);
  const [fileNamePattern, setFileNamePattern] = useState('');
  const [lockMode, setLockMode] = useState<LockMode>('FLATTEN');
  const [stampReference, setStampReference] = useState(true);
  const [issues, setIssues] = useState<DocumentIssue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [fileVersion, setFileVersion] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [mobilePane, setMobilePane] = useState<'fields' | 'pages'>('fields');
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [records, setRecords] = useState<{ id: string; label: string }[]>([]);
  const [recordId, setRecordId] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const panes = usePaneWidths('mailflow.documents.panes', { left: 380, right: 300 });
  const { openPreview, previewDialog } = useDocumentPreview();
  const replaceInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<Drag | null>(null);

  const apply = useCallback((p: Payload) => {
    setData(p);
    setName(p.document.name);
    setFields(p.document.fields);
    setFileNamePattern(p.document.fileNamePattern);
    setLockMode(p.document.lockMode);
    setStampReference(p.document.stampReference);
    setIssues(p.issues);
  }, []);

  useEffect(() => {
    fetch(`/api/documents/${params.id}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) toast.error(json.error ?? 'Could not load the document');
        else apply(json);
      })
      .catch(() => toast.error('Could not load the document'));
  }, [params.id, apply]);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem('mailflow.documents.zoom'));
      if (saved >= 0.5 && saved <= 2) setZoom(saved);
    } catch {
      /* storage unavailable */
    }
    fetch('/api/datasets')
      .then((r) => r.json())
      .then((j) => setDatasets(j.datasets ?? []))
      .catch(() => undefined);
  }, []);

  function changeZoom(value: number) {
    setZoom(value);
    try {
      localStorage.setItem('mailflow.documents.zoom', String(value));
    } catch {
      /* storage unavailable */
    }
  }

  useEffect(() => {
    if (!datasetId) {
      setRecords([]);
      setRecordId('');
      setColumns([]);
      return;
    }
    fetch(`/api/datasets/${datasetId}?pageSize=50`)
      .then((r) => r.json())
      .then((j) => {
        setColumns((j.columns ?? []).map((c: { key: string }) => c.key));
        const options = (j.records ?? []).map((rec: { id: string; data: Record<string, unknown> }) => {
          const first = Object.values(rec.data ?? {}).find((v) => typeof v === 'string' && v.trim());
          return { id: rec.id, label: (first as string | undefined) ?? rec.id.slice(0, 8) };
        });
        setRecords(options);
        setRecordId(options[0]?.id ?? '');
      })
      .catch(() => undefined);
  }, [datasetId]);

  const canEdit = data?.canEdit ?? false;
  const selected = fields.find((f) => f.id === selectedId) ?? null;

  const dirty = useMemo(() => {
    if (!data) return false;
    const d = data.document;
    return (
      name !== d.name ||
      fileNamePattern !== d.fileNamePattern ||
      lockMode !== d.lockMode ||
      stampReference !== d.stampReference ||
      JSON.stringify(fields) !== JSON.stringify(d.fields)
    );
  }, [data, name, fileNamePattern, lockMode, stampReference, fields]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const formByName = useMemo(() => new Map((data?.inspection.formFields ?? []).map((f) => [f.name, f])), [data]);
  const mappedForm = useMemo(() => {
    const map = new Map<string, DocumentField>();
    for (const f of fields) if (f.target.kind === 'form') map.set(f.target.fieldName, f);
    return map;
  }, [fields]);
  const issuesByField = useMemo(() => {
    const map = new Map<string, DocumentIssue[]>();
    for (const issue of issues) if (issue.fieldId) map.set(issue.fieldId, [...(map.get(issue.fieldId) ?? []), issue]);
    return map;
  }, [issues]);

  const updateField = useCallback((id: string, change: (f: DocumentField) => DocumentField) => {
    setFields((all) => all.map((f) => (f.id === id ? change(f) : f)));
  }, []);

  function removeField(id: string) {
    setFields((all) => all.filter((f) => f.id !== id));
    setSelectedId(null);
  }

  function reveal(page: number | null | undefined) {
    if (page === null || page === undefined) return;
    document.querySelector(`[data-page-index="${page}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function selectField(f: DocumentField) {
    setSelectedId(f.id);
    reveal(f.target.kind === 'text' ? f.target.page : formByName.get(f.target.fieldName)?.page);
  }

  function addFormField(detected: DetectedFormField) {
    const existing = mappedForm.get(detected.name);
    if (existing) {
      setSelectedId(existing.id);
      return;
    }
    const id = nextFieldId(fields.map((f) => f.id));
    const guess = guessVariableForFormField(detected.name, columns);
    setFields((all) => [...all, newField(id, humanize(detected.name), { kind: 'form', fieldName: detected.name }, guess ? `{{${guess}}}` : '')]);
    setSelectedId(id);
  }

  function mapAllFormFields() {
    if (!data) return;
    const open = data.inspection.formFields.filter((f) => !UNFILLABLE.has(f.type) && !mappedForm.has(f.name));
    if (open.length === 0) {
      toast.message('Every fillable form field is already mapped.');
      return;
    }
    const ids = fields.map((f) => f.id);
    const created: DocumentField[] = [];
    for (const detected of open) {
      const id = nextFieldId([...ids, ...created.map((c) => c.id)]);
      const guess = guessVariableForFormField(detected.name, columns);
      created.push(newField(id, humanize(detected.name), { kind: 'form', fieldName: detected.name }, guess ? `{{${guess}}}` : ''));
    }
    setFields((all) => [...all, ...created]);
    setSelectedId(created[0]?.id ?? null);
    const matched = created.filter((c) => c.value).length;
    toast.success(
      columns.length
        ? `${created.length} form field(s) added; ${matched} matched to a column by name. Check the rest.`
        : `${created.length} form field(s) added. Pick a sample dataset to match columns automatically.`
    );
  }

  function matchEmptyValues() {
    let matched = 0;
    const next = fields.map((f) => {
      if (f.target.kind !== 'form' || f.value.trim()) return f;
      const guess = guessVariableForFormField(f.target.fieldName, columns);
      if (!guess) return f;
      matched += 1;
      return { ...f, value: `{{${guess}}}` };
    });
    setFields(next);
    toast.message(matched ? `${matched} empty field(s) matched to a column.` : 'No empty field name matched a column.');
  }

  function placeTextBox(page: number, point: { x: number; y: number }) {
    if (!data) return;
    const info = data.inspection.pages[page];
    if (!info) return;
    if (info.rotation !== 0) {
      toast.error('Text boxes are not supported on rotated pages. Use a form field there.');
      return;
    }
    const id = nextFieldId(fields.map((f) => f.id));
    const box = boxAtPoint(point.x, point.y, info);
    const count = fields.filter((f) => f.target.kind === 'text').length + 1;
    setFields((all) => [...all, newField(id, `Text ${count}`, { kind: 'text', page, ...box })]);
    setSelectedId(id);
    setPlacing(false);
    requestAnimationFrame(() => valueInput.current?.focus());
  }

  function insertVariable(variable: string) {
    if (!selected) return;
    const token = `{{${variable}}}`;
    const el = valueInput.current;
    const start = el?.selectionStart ?? selected.value.length;
    const end = el?.selectionEnd ?? start;
    const value = selected.value.slice(0, start) + token + selected.value.slice(end);
    updateField(selected.id, (f) => ({ ...f, value }));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  // Dragging and resizing text boxes: measured from the drag start, so the box never drifts.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const current = drag.current;
      const info = current && data?.inspection.pages[current.page];
      if (!current || !info) return;
      const dx = e.clientX - current.startX;
      const dy = e.clientY - current.startY;
      const box = current.mode === 'move' ? moveBox(current.box, dx, dy, zoom, info) : resizeBox(current.box, dx, dy, zoom, info);
      setFields((all) =>
        all.map((f) => (f.id === current.fieldId && f.target.kind === 'text' ? { ...f, target: { ...f.target, ...box } } : f))
      );
    }
    function onUp() {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [data, zoom]);

  // Keyboard: Esc cancels placing; arrows nudge the selected box (Shift = 10pt); Delete removes it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPlacing(false);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (!canEdit || !selectedId || !target || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return;
      const field = fields.find((f) => f.id === selectedId);
      if (!field) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        setFields((all) => all.filter((f) => f.id !== field.id));
        setSelectedId(null);
        return;
      }
      if (field.target.kind !== 'text') return;
      const step = e.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[e.key];
      const info = data?.inspection.pages[field.target.page];
      if (!move || !info) return;
      e.preventDefault();
      const box = clampBox({ x: field.target.x + move[0], y: field.target.y + move[1], width: field.target.width, height: field.target.height }, info);
      updateField(field.id, (f) => (f.target.kind === 'text' ? { ...f, target: { ...f.target, ...box } } : f));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit, selectedId, fields, data, updateField]);

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/documents/${params.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fields, fileNamePattern, lockMode, stampReference }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      const first = json.issues?.[0];
      const where = first?.path?.[0] === 'fields' && typeof first.path[1] === 'number' ? `Field ${first.path[1] + 1}: ` : '';
      toast.error(first ? `${where}${first.message}` : json.error ?? 'Could not save');
      return;
    }
    setData((d) => (d ? { ...d, document: json.document, inspection: json.inspection, issues: json.issues } : d));
    setFields(json.document.fields);
    setIssues(json.issues);
    const errors = (json.issues as DocumentIssue[]).filter((i) => i.level === 'error').length;
    if (errors) toast.warning(`Saved. ${errors} problem(s) must be fixed before a campaign can send this document.`);
    else toast.success('Saved');
  }

  async function replaceFile(file: File) {
    if (!confirm('Replace the PDF? The field map is kept and anything that no longer matches is flagged. Campaigns keep the version they attached.')) return;
    setReplacing(true);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/documents/${params.id}/file`, { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    setReplacing(false);
    if (!res.ok) {
      toast.error(json.error ?? 'Could not replace the PDF');
      return;
    }
    setData((d) => (d ? { ...d, document: { ...d.document, file: json.document.file }, inspection: json.inspection } : d));
    setIssues(json.issues);
    setFileVersion((v) => v + 1);
    toast.success(`PDF replaced: ${json.inspection.pageCount} page(s), ${json.inspection.formFields.length} fillable field(s).`);
  }

  async function preview() {
    const json = await openPreview(
      `/api/documents/${params.id}/preview`,
      { ...(recordId ? { recordId } : {}), draft: { fields, fileNamePattern, lockMode, stampReference } },
      name
    );
    if (json?.issues) setIssues(json.issues as DocumentIssue[]);
  }

  if (!data) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const { inspection, document: doc } = data;
  const fillable = inspection.formFields.filter((f) => !UNFILLABLE.has(f.type));
  const unmapped = fillable.filter((f) => !mappedForm.has(f.name)).length;
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const detected = selected?.target.kind === 'form' ? formByName.get(selected.target.fieldName) : undefined;

  const renderOverlay = (pageIndex: number) => (
    <>
      {inspection.formFields
        .filter((f) => f.page === pageIndex && f.rect)
        .map((f) => {
          const mapped = mappedForm.get(f.name);
          const px = toPixels(f.rect!, zoom);
          const colours = mapped && mapped.id === selectedId ? COLORS.selected : mapped ? COLORS.formMapped : UNFILLABLE.has(f.type) ? COLORS.formDisabled : COLORS.formOpen;
          return (
            <button
              key={`form-${f.name}`}
              type="button"
              title={`${f.name} (${TYPE_LABELS[f.type]})${mapped ? ` · filled by "${mapped.label}"` : UNFILLABLE.has(f.type) ? ' · cannot be filled' : canEdit ? ' · click to map' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (UNFILLABLE.has(f.type)) return;
                if (mapped) setSelectedId(mapped.id);
                else if (canEdit) addFormField(f);
              }}
              className="pointer-events-auto absolute overflow-hidden rounded-[2px] text-left"
              style={{ left: px.left, top: px.top, width: px.width, height: px.height, border: colours.border, background: colours.background }}
            >
              <span className="block truncate px-0.5 text-[10px] leading-tight" style={{ color: '#1f2937' }}>
                {mapped ? mapped.label : f.name}
              </span>
            </button>
          );
        })}
      {fields.map((f) => {
        if (f.target.kind !== 'text' || f.target.page !== pageIndex) return null;
        const target = f.target;
        const px = toPixels(target, zoom);
        const isSelected = f.id === selectedId;
        const colours = isSelected ? COLORS.selected : COLORS.text;
        const startDrag = (e: React.MouseEvent, mode: Drag['mode']) => {
          e.stopPropagation();
          setSelectedId(f.id);
          if (!canEdit) return;
          e.preventDefault();
          drag.current = { fieldId: f.id, mode, startX: e.clientX, startY: e.clientY, box: { x: target.x, y: target.y, width: target.width, height: target.height }, page: pageIndex };
          document.body.style.userSelect = 'none';
        };
        return (
          <div
            key={f.id}
            role="button"
            tabIndex={0}
            onMouseDown={(e) => startDrag(e, 'move')}
            onClick={(e) => e.stopPropagation()}
            className={`pointer-events-auto absolute rounded-[2px] ${canEdit ? 'cursor-move' : 'cursor-pointer'}`}
            style={{ left: px.left, top: px.top, width: px.width, height: px.height, border: colours.border, background: colours.background }}
            title={`${f.label}: ${f.value || '(no value yet)'}`}
          >
            <span
              className="block overflow-hidden whitespace-nowrap px-1 leading-tight"
              style={{ color: '#1f2937', fontSize: Math.max(8, Math.min(f.style.fontSize * zoom, px.height * 0.75)), textAlign: f.style.align }}
            >
              {f.value || f.label}
            </span>
            {canEdit && isSelected && (
              <span
                onMouseDown={(e) => startDrag(e, 'resize')}
                className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm"
                style={{ background: 'rgb(237 3 49)', border: '1px solid white' }}
                title="Drag to resize"
              />
            )}
          </div>
        );
      })}
    </>
  );

  return (
    <div className="flex h-full min-h-[calc(100dvh-3.5rem)] flex-col lg:min-h-0">
      <header className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2">
        <Link href="/documents" className="text-sm text-muted-foreground hover:text-foreground">
          ← Documents
        </Link>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit}
          aria-label="Document name"
          className="min-w-[180px] flex-1 rounded-md border bg-transparent px-2 py-1 text-sm font-semibold"
        />
        {doc.archived && <span className="badge badge-neutral">Archived</span>}
        {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={preview} className="btn-secondary !py-1.5 text-xs" title={recordId ? 'Fill with the selected sample record' : 'Shows where each value goes'}>
            Preview PDF
          </button>
          {canEdit && (
            <button onClick={save} disabled={saving || !dirty} className="btn-primary !py-1.5 text-xs">
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </header>

      {!canEdit && (
        <div className="border-b bg-muted px-4 py-1.5 text-xs text-muted-foreground">Read-only: you can preview this document but not change it.</div>
      )}

      <div className="flex border-b lg:hidden">
        {(['fields', 'pages'] as const).map((pane) => (
          <button
            key={pane}
            onClick={() => setMobilePane(pane)}
            className={`flex-1 py-2 text-xs font-medium ${mobilePane === pane ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground'}`}
          >
            {pane === 'fields' ? `Fields (${fields.length})` : `Pages (${inspection.pageCount})`}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className={`${mobilePane === 'fields' ? 'block' : 'hidden'} w-full shrink-0 space-y-4 overflow-y-auto border-r p-3 lg:block lg:w-[var(--pane-left)]`}
          style={{ ['--pane-left' as string]: `${panes.widths.left}px` }}
        >
          <Section title="PDF">
            <div className="text-xs text-muted-foreground">
              {doc.file.fileName} · {inspection.pageCount} page(s) · {Math.max(1, Math.round(doc.file.size / 1024))} KB ·{' '}
              {fillable.length} fillable field(s)
            </div>
            {inspection.hasXfa && (
              <p className="mt-1 text-[11px] text-warning">Dynamic (XFA) form: MailFlow fills its standard fields and removes the XFA layer.</p>
            )}
            {canEdit && (
              <>
                <button onClick={() => replaceInput.current?.click()} disabled={replacing} className="mt-2 text-xs text-primary hover:underline">
                  {replacing ? 'Replacing…' : 'Replace PDF'}
                </button>
                <input
                  ref={replaceInput}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) replaceFile(file);
                  }}
                />
              </>
            )}
          </Section>

          <Section title="Sample data for preview">
            <div className="grid grid-cols-2 gap-2">
              <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} className="w-full rounded-md border px-2 py-1.5 text-xs">
                <option value="">No dataset</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <select value={recordId} onChange={(e) => setRecordId(e.target.value)} disabled={!records.length} className="w-full rounded-md border px-2 py-1.5 text-xs">
                {records.length === 0 && <option value="">No record</option>}
                {records.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1 text-[11px] text-faint">
              {recordId ? 'Preview fills the PDF with this record, exactly as a campaign would.' : 'Without a record, the preview shows each value template where it will be written.'}
            </p>
            {canEdit && columns.length > 0 && fields.some((f) => f.target.kind === 'form' && !f.value.trim()) && (
              <button onClick={matchEmptyValues} className="mt-1 text-xs text-primary hover:underline">
                Match empty form fields to columns by name
              </button>
            )}
          </Section>

          <Section title="Output">
            <fieldset disabled={!canEdit} className="space-y-3">
              <FormRow label="File name" hint="Use variables to personalise it, e.g. Offer Letter - {{Name}}.pdf">
                <input value={fileNamePattern} onChange={(e) => setFileNamePattern(e.target.value)} className="w-full rounded-md border px-2 py-1.5 font-mono text-xs" />
              </FormRow>
              <div className="space-y-1.5">
                <div className="text-xs font-medium">What the student can do with the PDF</div>
                {LOCK_MODES.map((mode) => (
                  <label key={mode} className="flex cursor-pointer gap-2 text-xs">
                    <input type="radio" name="lockMode" checked={lockMode === mode} onChange={() => setLockMode(mode)} className="mt-0.5" />
                    <span>
                      <span className="font-medium">{LOCK_MODE_LABELS[mode].label}</span>
                      <span className="block text-[11px] text-faint">{LOCK_MODE_LABELS[mode].help}</span>
                    </span>
                  </label>
                ))}
              </div>
              <label className="flex cursor-pointer gap-2 text-xs">
                <input type="checkbox" checked={stampReference} onChange={(e) => setStampReference(e.target.checked)} className="mt-0.5" />
                <span>
                  <span className="font-medium">Print a reference line on every page</span>
                  <span className="block text-[11px] text-faint">Small footer: Ref MF-…, prepared for the recipient, issue date. Lets you verify a returned copy.</span>
                </span>
              </label>
            </fieldset>
          </Section>

          {(errors.length > 0 || warnings.length > 0) && (
            <Section title="Checks from the last save or preview">
              <ul className="space-y-1 text-xs">
                {[...errors, ...warnings].map((issue, i) => {
                  const field = issue.fieldId ? fields.find((f) => f.id === issue.fieldId) : undefined;
                  return (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => field && selectField(field)}
                        className={`text-left ${issue.level === 'error' ? 'text-primary' : 'text-warning'} ${field ? 'hover:underline' : ''}`}
                      >
                        {issue.level === 'error' ? '✕' : '!'} {issue.message}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <Section title={`Fields (${fields.length})`}>
            {fields.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {fillable.length
                  ? 'Click a blue box on the page to map a fillable field, or use "Map all form fields".'
                  : 'This PDF has no fillable fields. Use "+ Text box" and click where the text should go.'}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {fields.map((f) => {
                  const fieldIssues = issuesByField.get(f.id) ?? [];
                  const hasError = fieldIssues.some((i) => i.level === 'error');
                  return (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => selectField(f)}
                        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs ${f.id === selectedId ? 'bg-primary/10' : 'hover:bg-elevated'}`}
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-full ${f.target.kind === 'form' ? 'bg-success' : 'bg-warning'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{f.label}</span>
                          <span className="block truncate font-mono text-[10px] text-faint">
                            {f.value || '(empty)'} → {f.target.kind === 'form' ? f.target.fieldName : `page ${f.target.page + 1} text box`}
                          </span>
                        </span>
                        {hasError && (
                          <span className="text-primary" title={fieldIssues.map((i) => i.message).join('\n')}>
                            ✕
                          </span>
                        )}
                        {!f.required && <span className="text-[10px] text-faint">optional</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {selected && (
            <Section
              title="Selected field"
              action={
                canEdit ? (
                  <button onClick={() => removeField(selected.id)} className="text-xs text-muted-foreground hover:text-primary">
                    Delete field
                  </button>
                ) : null
              }
            >
              <fieldset disabled={!canEdit} className="space-y-3">
                <FormRow label="Label">
                  <input
                    value={selected.label}
                    onChange={(e) => updateField(selected.id, (f) => ({ ...f, label: e.target.value }))}
                    className="w-full rounded-md border px-2 py-1.5 text-xs"
                  />
                </FormRow>
                <FormRow label="Value" hint="Text with variables. Click a variable below to insert it at the cursor.">
                  <textarea
                    ref={valueInput}
                    rows={selected.style.multiline ? 3 : 2}
                    value={selected.value}
                    placeholder="{{Name}}"
                    onChange={(e) => updateField(selected.id, (f) => ({ ...f, value: e.target.value }))}
                    className="w-full rounded-md border px-2 py-1.5 font-mono text-xs"
                  />
                </FormRow>
                <div className="flex flex-wrap gap-1">
                  {columns.map((c) => (
                    <button key={c} type="button" onClick={() => insertVariable(c)} className="rounded border px-1.5 py-0.5 font-mono text-[10px] hover:border-primary hover:text-primary">
                      {`{{${c}}}`}
                    </button>
                  ))}
                  {SYSTEM_VARIABLES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      title={SYSTEM_VARIABLE_HELP[v]}
                      onClick={() => insertVariable(v)}
                      className="rounded border border-dashed px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                  {columns.length === 0 && <span className="text-[11px] text-faint">Pick a sample dataset above to list its columns.</span>}
                </div>

                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.required}
                    onChange={(e) => updateField(selected.id, (f) => ({ ...f, required: e.target.checked }))}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">Required</span>
                    <span className="block text-[11px] text-faint">A recipient with an empty value is skipped instead of receiving a blank document.</span>
                  </span>
                </label>
                {!selected.required && (
                  <FormRow label="Fallback when empty">
                    <input
                      value={selected.fallback ?? ''}
                      onChange={(e) => updateField(selected.id, (f) => ({ ...f, fallback: e.target.value || undefined }))}
                      placeholder="e.g. To be confirmed"
                      className="w-full rounded-md border px-2 py-1.5 text-xs"
                    />
                  </FormRow>
                )}

                <div className="grid grid-cols-3 gap-2">
                  <FormRow label="Date">
                    <select
                      value={selected.format.date ?? ''}
                      onChange={(e) => updateField(selected.id, (f) => ({ ...f, format: { ...f.format, date: (e.target.value || undefined) as DocumentField['format']['date'] } }))}
                      className="w-full rounded-md border px-1 py-1 text-[11px]"
                    >
                      <option value="">As is</option>
                      {DATE_FORMATS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </FormRow>
                  <FormRow label="Number">
                    <select
                      value={selected.format.number ?? ''}
                      onChange={(e) => updateField(selected.id, (f) => ({ ...f, format: { ...f.format, number: (e.target.value || undefined) as DocumentField['format']['number'] } }))}
                      className="w-full rounded-md border px-1 py-1 text-[11px]"
                    >
                      <option value="">As is</option>
                      {NUMBER_FORMATS.map((n) => (
                        <option key={n} value={n}>
                          {NUMBER_LABELS[n]}
                        </option>
                      ))}
                    </select>
                  </FormRow>
                  <FormRow label="Case">
                    <select
                      value={selected.format.case ?? ''}
                      onChange={(e) => updateField(selected.id, (f) => ({ ...f, format: { ...f.format, case: (e.target.value || undefined) as DocumentField['format']['case'] } }))}
                      className="w-full rounded-md border px-1 py-1 text-[11px]"
                    >
                      <option value="">As is</option>
                      {CASE_FORMATS.map((c) => (
                        <option key={c} value={c}>
                          {CASE_LABELS[c]}
                        </option>
                      ))}
                    </select>
                  </FormRow>
                </div>

                {selected.target.kind === 'form' ? (
                  <FormRow label="Fills the PDF form field">
                    <select
                      value={selected.target.fieldName}
                      onChange={(e) => updateField(selected.id, (f) => ({ ...f, target: { kind: 'form', fieldName: e.target.value } }))}
                      className="w-full rounded-md border px-2 py-1.5 text-xs"
                    >
                      {!formByName.has(selected.target.fieldName) && (
                        <option value={selected.target.fieldName}>{selected.target.fieldName} (not in this PDF)</option>
                      )}
                      {inspection.formFields.map((f) => (
                        <option key={f.name} value={f.name} disabled={UNFILLABLE.has(f.type)}>
                          {f.name} · {TYPE_LABELS[f.type]}
                          {f.page !== null ? ` · page ${f.page + 1}` : ''}
                        </option>
                      ))}
                    </select>
                    {detected?.type === 'checkbox' && <span className="mt-1 block text-[11px] text-faint">Ticked when the value is Yes, True, 1, Y, X or ✓.</span>}
                    {detected?.options?.length ? (
                      <span className="mt-1 block text-[11px] text-faint">Options: {detected.options.join(', ')}. The value must match one (case does not matter).</span>
                    ) : null}
                    {detected?.maxLength ? <span className="mt-1 block text-[11px] text-faint">The PDF allows at most {detected.maxLength} characters.</span> : null}
                  </FormRow>
                ) : (
                  <TextBoxControls
                    field={selected}
                    pages={inspection.pages.length}
                    onChange={(target) => {
                      const info = inspection.pages[target.page];
                      if (!info) return;
                      if (info.rotation !== 0) toast.error(`Page ${target.page + 1} is rotated; text boxes are not supported there.`);
                      const box = clampBox(target, info);
                      updateField(selected.id, (f) => ({ ...f, target: { kind: 'text', page: target.page, ...box } }));
                    }}
                    onStyle={(style) => updateField(selected.id, (f) => ({ ...f, style: { ...f.style, ...style } }))}
                  />
                )}
              </fieldset>
            </Section>
          )}

          {data.campaigns.length > 0 && (
            <Section title="Used in campaigns">
              <ul className="space-y-1 text-xs">
                {data.campaigns.map((c) => (
                  <li key={c.id}>
                    <Link href={`/campaigns/${c.id}`} className="text-primary hover:underline">
                      {c.name}
                    </Link>{' '}
                    <span className="text-faint">
                      · {c.status.replace(/_/g, ' ').toLowerCase()} · attached {new Date(c.snapshotAt).toLocaleDateString('en-IN')}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-faint">Campaigns keep the version they attached. Update them from the campaign page.</p>
            </Section>
          )}
        </aside>

        <PaneDivider onDrag={(dx) => panes.resize('left', dx)} />

        <main className={`${mobilePane === 'pages' ? 'block' : 'hidden'} min-w-0 flex-1 overflow-auto bg-muted/40 lg:block`}>
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-card/95 px-3 py-2 text-xs backdrop-blur">
            {canEdit && (
              <button onClick={() => setPlacing((p) => !p)} className={placing ? 'btn-primary !py-1 text-xs' : 'btn-secondary !py-1 text-xs'}>
                {placing ? 'Click on a page to place it (Esc cancels)' : '+ Text box'}
              </button>
            )}
            {canEdit && unmapped > 0 && (
              <button onClick={mapAllFormFields} className="btn-secondary !py-1 text-xs">
                Map all form fields ({unmapped})
              </button>
            )}
            <span className="hidden text-faint xl:inline">Blue dashed: fillable, not mapped · Green: mapped · Amber: text box · Arrow keys nudge the selected box</span>
            <label className="ml-auto flex items-center gap-2">
              Zoom
              <input type="range" min={50} max={200} step={10} value={Math.round(zoom * 100)} onChange={(e) => changeZoom(Number(e.target.value) / 100)} />
              <span className="w-9 text-right tabular-nums">{Math.round(zoom * 100)}%</span>
            </label>
          </div>
          <div className="overflow-x-auto p-4">
            <PdfPages
              src={`/api/documents/${params.id}/file?v=${doc.file.id}`}
              reloadKey={fileVersion}
              pages={inspection.pages}
              scale={zoom}
              renderOverlay={renderOverlay}
              cursor={placing ? 'crosshair' : undefined}
              onPageClick={(page, point) => {
                if (placing && canEdit) placeTextBox(page, point);
                else setSelectedId(null);
              }}
            />
          </div>
        </main>
      </div>

      {previewDialog}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="eyebrow">{title}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

function FormRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

function TextBoxControls({
  field,
  pages,
  onChange,
  onStyle,
}: {
  field: DocumentField;
  pages: number;
  onChange: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  onStyle: (style: Partial<DocumentField['style']>) => void;
}) {
  if (field.target.kind !== 'text') return null;
  const t = field.target;
  const num = (key: 'x' | 'y' | 'width' | 'height') => (
    <label className="block text-[11px]">
      <span className="block text-faint">{key === 'x' ? 'Left' : key === 'y' ? 'Top' : key === 'width' ? 'Width' : 'Height'}</span>
      <input
        type="number"
        step={1}
        value={Math.round(t[key])}
        onChange={(e) => onChange({ ...t, [key]: Number(e.target.value) || 0 })}
        className="w-full rounded-md border px-1 py-1 text-[11px]"
      />
    </label>
  );
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium">Text box (points)</div>
      <div className="grid grid-cols-5 gap-1.5">
        <label className="block text-[11px]">
          <span className="block text-faint">Page</span>
          <select value={t.page} onChange={(e) => onChange({ ...t, page: Number(e.target.value) })} className="w-full rounded-md border px-1 py-1 text-[11px]">
            {Array.from({ length: pages }, (_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
        {num('x')}
        {num('y')}
        {num('width')}
        {num('height')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px]">
          <span className="block text-faint">Font</span>
          <select value={field.style.font} onChange={(e) => onStyle({ font: e.target.value as DocumentField['style']['font'] })} className="w-full rounded-md border px-1 py-1 text-[11px]">
            {FONTS.map((f) => (
              <option key={f} value={f}>
                {FONT_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[11px]">
          <span className="block text-faint">Size (shrinks to fit)</span>
          <input
            type="number"
            min={4}
            max={72}
            value={field.style.fontSize}
            onChange={(e) => onStyle({ fontSize: Math.min(72, Math.max(4, Number(e.target.value) || 11)) })}
            className="w-full rounded-md border px-1 py-1 text-[11px]"
          />
        </label>
      </div>
      <div className="grid grid-cols-3 items-end gap-2">
        <label className="block text-[11px]">
          <span className="block text-faint">Colour</span>
          <input type="color" value={field.style.color} onChange={(e) => onStyle({ color: e.target.value })} className="h-7 w-full rounded-md border" />
        </label>
        <label className="block text-[11px]">
          <span className="block text-faint">Align</span>
          <select value={field.style.align} onChange={(e) => onStyle({ align: e.target.value as DocumentField['style']['align'] })} className="w-full rounded-md border px-1 py-1 text-[11px]">
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="flex items-center gap-1 pb-1 text-[11px]">
          <input type="checkbox" checked={field.style.multiline} onChange={(e) => onStyle({ multiline: e.target.checked })} />
          Wrap lines
        </label>
      </div>
    </div>
  );
}
