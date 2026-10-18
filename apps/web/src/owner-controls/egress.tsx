import type { FormEventHandler } from "react";

interface EgressSectionProps {
  busy: boolean;
  egress: string;
  setEgress: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}

export function EgressSection({ busy, egress, setEgress, onSubmit }: EgressSectionProps) {
  return (
    <section aria-label="Network egress policy">
      <h3>Extra egress hosts</h3>
      <p className="muted">
        One exact host or *.suffix pattern per line. Platform defaults remain in effect.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          Allowed hosts
          <textarea
            data-testid="egress-hosts"
            rows={4}
            value={egress}
            onChange={(event) => setEgress(event.target.value)}
          />
        </label>
        <button data-testid="save-egress" disabled={busy}>
          Save egress allowlist
        </button>
      </form>
    </section>
  );
}
