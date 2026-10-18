import type { FormEventHandler } from "react";

interface ProtectedPathsSectionProps {
  busy: boolean;
  protectedPaths: string;
  setProtectedPaths: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}

export function ProtectedPathsSection({
  busy,
  protectedPaths,
  setProtectedPaths,
  onSubmit,
}: ProtectedPathsSectionProps) {
  return (
    <section aria-label="Protected paths">
      <h3>Protected paths</h3>
      <p className="muted">
        Default patterns apply until changed. An explicit empty list disables protected-path checks.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          Path patterns
          <textarea
            data-testid="protected-paths"
            rows={4}
            value={protectedPaths}
            onChange={(event) => setProtectedPaths(event.target.value)}
          />
        </label>
        <button data-testid="save-protected-paths" disabled={busy}>
          Save protected paths
        </button>
      </form>
    </section>
  );
}
