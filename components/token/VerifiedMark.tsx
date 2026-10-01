/** Small "verified" check shown next to the official contract address. Shape: Lucide badge-check (ISC). */
export default function VerifiedMark() {
  return (
    <svg className="verified-mark" viewBox="0 0 24 24" width="16" height="16" role="img" aria-label="Official contract">
      <path fill="currentColor" d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path fill="none" stroke="var(--verified-ink)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="m9 12 2 2 4-4" />
    </svg>
  );
}
