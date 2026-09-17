'use client';

import { useParams } from 'next/navigation';

export default function SigningCompletePage() {
  const params = useParams<{ token: string }>();

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md text-center">
        <div className="mb-6 flex items-center justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
            <svg
              className="h-10 w-10 text-green-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>

        <h1 className="mb-2 text-2xl font-bold text-gray-900">Document Signed Successfully</h1>

        <p className="mb-1 text-base text-gray-600">Thank you for signing the document.</p>

        <p className="mb-6 text-sm text-gray-500">
          A copy of the signed document has been emailed to you. You can also view it below.
        </p>

        <a
          href={`/api/sign/${params.token}/download`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
          View Signed Document
        </a>
        <p className="mt-2 text-xs text-gray-400">Opens in browser · Ctrl+P to save as PDF</p>

        <p className="mt-8 text-xs text-gray-400">
          Secured by MailFlow · Masai School
        </p>
      </div>
    </div>
  );
}
