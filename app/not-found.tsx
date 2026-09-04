import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm rounded-lg border bg-card p-8 text-center shadow-sm">
        <div className="mb-2 text-3xl font-semibold">404</div>
        <p className="mb-6 text-sm text-muted-foreground">
          That page doesn&apos;t exist in MailFlow.
        </p>
        <Link href="/" className="text-sm font-medium text-primary underline">
          Back to MailFlow
        </Link>
      </div>
    </div>
  );
}
