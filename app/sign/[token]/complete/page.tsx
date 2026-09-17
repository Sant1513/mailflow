export default function SigningCompletePage() {
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
          A copy of the signed document has been emailed to you. Please keep it for your records.
        </p>

        <div className="rounded-xl border border-gray-100 bg-white px-6 py-4 text-sm text-gray-400 shadow-sm">
          You may now close this tab.
        </div>

        <p className="mt-8 text-xs text-gray-400">
          Secured by MailFlow · Masai School
        </p>
      </div>
    </div>
  );
}
