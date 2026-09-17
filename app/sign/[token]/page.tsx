'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

type SigningStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'SIGNED' | 'EXPIRED' | 'VOIDED';

interface PublicDocument {
  id: string;
  title: string;
  content: string;
  recipientName: string;
  fieldValues: Record<string, string>;
  status: SigningStatus;
  expiresAt: string | null;
}

type DrawMode = 'draw' | 'type';

function extractVariableNames(content: string): string[] {
  const matches = [...content.matchAll(/\{\{(\w+)\}\}/g)];
  return [...new Set(matches.map((m) => m[1] ?? ''))];
}

function formatLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function substituteVars(content: string, values: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(values)) {
    const display = value.trim()
      ? `<mark style="background:#fef3c7;border-radius:2px;padding:0 2px;font-weight:600">${value}</mark>`
      : `<span style="background:#fee2e2;border-radius:2px;padding:0 2px;color:#991b1b">{{${key}}}</span>`;
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), display);
  }
  // Highlight any remaining unfilled placeholders
  result = result.replace(
    /\{\{(\w+)\}\}/g,
    '<span style="background:#fee2e2;border-radius:2px;padding:0 2px;color:#991b1b">{{$1}}</span>'
  );
  return result;
}

export default function SigningPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();

  const [doc, setDoc] = useState<PublicDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [mode, setMode] = useState<DrawMode>('draw');
  const [typedName, setTypedName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [localFieldValues, setLocalFieldValues] = useState<Record<string, string>>({});

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const typeCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  // ── Load document ────────────────────────────────────────────────────────
  useEffect(() => {
    const token = params.token;
    if (!token) return;
    fetch(`/api/sign/${token}`)
      .then(async (res) => {
        if (res.status === 404) {
          setLoadError('Document not found. Please check your link.');
          return;
        }
        if (res.status === 410) {
          setLoadError('This signing link has expired.');
          return;
        }
        if (!res.ok) {
          setLoadError('Something went wrong. Please try again later.');
          return;
        }
        const json = (await res.json()) as PublicDocument;
        setDoc(json);
        setTypedName(json.recipientName);
        // Pre-populate from admin-set field values
        setLocalFieldValues(json.fieldValues ?? {});
      })
      .catch(() => {
        setLoadError('Could not load the document. Please try again.');
      });
  }, [params.token]);

  // ── Canvas helpers (coordinates scaled to canvas intrinsic size) ──────────
  const getPos = (canvas: HTMLCanvasElement, e: MouseEvent | Touch): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const startDraw = useCallback((e: MouseEvent | TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawing.current = true;
    const touch = 'touches' in e ? e.touches[0] : e;
    if (touch) lastPos.current = getPos(canvas, touch);
  }, []);

  const draw = useCallback((e: MouseEvent | TouchEvent) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    e.preventDefault();
    const touch = 'touches' in e ? e.touches[0] : e;
    if (!touch) return;
    const pos = getPos(canvas, touch);
    const last = lastPos.current;
    if (last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    lastPos.current = pos;
    setHasDrawing(true);
  }, []);

  const stopDraw = useCallback(() => {
    drawing.current = false;
    lastPos.current = null;
  }, []);

  // Attach canvas event listeners
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDraw);
    canvas.addEventListener('mouseleave', stopDraw);
    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', stopDraw);

    return () => {
      canvas.removeEventListener('mousedown', startDraw);
      canvas.removeEventListener('mousemove', draw);
      canvas.removeEventListener('mouseup', stopDraw);
      canvas.removeEventListener('mouseleave', stopDraw);
      canvas.removeEventListener('touchstart', startDraw);
      canvas.removeEventListener('touchmove', draw);
      canvas.removeEventListener('touchend', stopDraw);
    };
  }, [startDraw, draw, stopDraw]);

  // Render typed name onto type canvas
  useEffect(() => {
    const canvas = typeCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (typedName.trim()) {
      ctx.fillStyle = '#1a1a1a';
      ctx.font = 'italic 36px Georgia, "Times New Roman", serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(typedName, 16, canvas.height / 2);
    }
  }, [typedName]);

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasDrawing(false);
  }

  function getSignatureImage(): string {
    if (mode === 'draw') return canvasRef.current?.toDataURL() ?? '';
    return typeCanvasRef.current?.toDataURL() ?? '';
  }

  const fieldNames = doc ? extractVariableNames(doc.content) : [];
  const allFieldsFilled = fieldNames.every((name) => (localFieldValues[name] ?? '').trim().length > 0);
  const canSubmit = agreed && allFieldsFilled && (mode === 'draw' ? hasDrawing : typedName.trim().length > 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !doc) return;
    setSubmitting(true);
    setSubmitError(null);
    const res = await fetch(`/api/sign/${params.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signatureImage: getSignatureImage(),
        signerName: doc.recipientName,
        fieldValues: localFieldValues,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setSubmitError(json.error ?? 'Failed to submit signature. Please try again.');
      return;
    }
    router.push(`/sign/${params.token}/complete`);
  }

  // ── Render states ────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md text-center">
          <div className="mb-4 text-4xl">⚠️</div>
          <h1 className="mb-2 text-xl font-semibold text-gray-900">{loadError}</h1>
          <p className="text-sm text-gray-500">
            If you believe this is a mistake, please contact the sender.
          </p>
        </div>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">Loading document…</p>
      </div>
    );
  }

  if (doc.status === 'SIGNED') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md text-center">
          <div className="mb-4 text-5xl">✅</div>
          <h1 className="mb-2 text-xl font-semibold text-gray-900">Already Signed</h1>
          <p className="text-sm text-gray-500">
            This document has already been signed. A copy has been emailed to you.
          </p>
        </div>
      </div>
    );
  }

  if (doc.status === 'EXPIRED' || doc.status === 'VOIDED') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md text-center">
          <div className="mb-4 text-4xl">⏱️</div>
          <h1 className="mb-2 text-xl font-semibold text-gray-900">
            {doc.status === 'EXPIRED'
              ? 'This signing link has expired'
              : 'This request has been voided'}
          </h1>
          <p className="text-sm text-gray-500">
            Please contact the sender to request a new signing link.
          </p>
        </div>
      </div>
    );
  }

  const previewContent = substituteVars(doc.content, localFieldValues);

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mb-1 text-2xl font-bold tracking-tight text-gray-900">
            masai<span className="text-red-500">.</span>MailFlow
          </div>
          <p className="text-sm text-gray-500">Document Signing</p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          {/* Document title */}
          <div className="border-b border-gray-100 px-6 py-5 sm:px-8">
            <h1 className="text-xl font-semibold text-gray-900">{doc.title}</h1>
            <p className="mt-1 text-sm text-gray-500">
              Hi <strong>{doc.recipientName}</strong>, please review and sign this document.
            </p>
          </div>

          {/* Document content with live variable substitution */}
          <div className="px-6 py-5 sm:px-8">
            <div className="mb-2 text-xs uppercase tracking-wider text-gray-400">Document</div>
            <div
              className="max-h-96 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-4 sm:p-5 text-sm leading-relaxed text-gray-800"
              dangerouslySetInnerHTML={{ __html: previewContent }}
            />
          </div>

          {/* Fillable fields (student fills before signing) */}
          {fieldNames.length > 0 && (
            <div className="border-t border-gray-100 px-6 py-5 sm:px-8">
              <div className="mb-2 text-xs uppercase tracking-wider text-gray-400">Required Information</div>
              <p className="mb-4 text-xs text-gray-500">
                Fill in all fields below — they will be included in the signed document.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {fieldNames.map((name) => (
                  <div key={name}>
                    <label className="mb-1 block text-xs font-medium text-gray-700">
                      {formatLabel(name)} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={localFieldValues[name] ?? ''}
                      onChange={(e) =>
                        setLocalFieldValues((prev) => ({ ...prev, [name]: e.target.value }))
                      }
                      placeholder={`Enter ${formatLabel(name).toLowerCase()}`}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-300"
                    />
                  </div>
                ))}
              </div>
              {!allFieldsFilled && (
                <p className="mt-3 text-xs text-amber-600">
                  Please fill in all required fields to enable signing.
                </p>
              )}
            </div>
          )}

          {/* Signature section */}
          <form onSubmit={handleSubmit}>
            <div className="border-t border-gray-100 px-6 py-5 sm:px-8">
              <div className="mb-4 text-xs uppercase tracking-wider text-gray-400">Your Signature</div>

              {/* Mode tabs */}
              <div className="mb-4 flex w-fit overflow-hidden rounded-lg border border-gray-200">
                <button
                  type="button"
                  onClick={() => setMode('draw')}
                  className={`px-5 py-2 text-sm font-medium transition ${
                    mode === 'draw' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  Draw
                </button>
                <button
                  type="button"
                  onClick={() => setMode('type')}
                  className={`border-l border-gray-200 px-5 py-2 text-sm font-medium transition ${
                    mode === 'type' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  Type
                </button>
              </div>

              {/* Draw tab */}
              {mode === 'draw' && (
                <div>
                  <div className="mb-2 overflow-hidden rounded-lg border border-gray-200">
                    {/* canvas width=560 is the drawing buffer; CSS width=100% scales display.
                        getPos() scales mouse coords back to buffer space. */}
                    <canvas
                      ref={canvasRef}
                      width={560}
                      height={150}
                      className="block w-full cursor-crosshair bg-white"
                      style={{ touchAction: 'none', height: '150px' }}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={clearCanvas}
                      className="text-xs text-gray-500 underline hover:text-gray-800"
                    >
                      Clear
                    </button>
                    {!hasDrawing && (
                      <span className="text-xs text-gray-400">Draw your signature above</span>
                    )}
                  </div>
                </div>
              )}

              {/* Type tab */}
              {mode === 'type' && (
                <div>
                  <input
                    type="text"
                    value={typedName}
                    onChange={(e) => setTypedName(e.target.value)}
                    placeholder="Type your full name"
                    className="mb-3 w-full rounded-lg border border-gray-200 px-4 py-2 text-sm outline-none focus:border-gray-400"
                  />
                  <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                    <canvas
                      ref={typeCanvasRef}
                      width={560}
                      height={90}
                      className="block w-full"
                      style={{ height: '90px' }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    Preview of your typed signature
                  </p>
                </div>
              )}

              {/* Agreement checkbox */}
              <label className="mt-5 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900"
                />
                <span className="text-sm text-gray-600">
                  I agree to sign this document electronically. I understand this signature is legally
                  binding and equivalent to my handwritten signature.
                </span>
              </label>

              {submitError && (
                <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                  {submitError}
                </div>
              )}

              <button
                type="submit"
                disabled={!canSubmit || submitting}
                className="mt-6 w-full rounded-lg bg-gray-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? 'Signing…' : 'Sign Document'}
              </button>

              {doc.expiresAt && (
                <p className="mt-3 text-center text-xs text-gray-400">
                  This link expires on{' '}
                  {new Date(doc.expiresAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                </p>
              )}
            </div>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Secured by MailFlow · Masai School
        </p>
      </div>
    </div>
  );
}
