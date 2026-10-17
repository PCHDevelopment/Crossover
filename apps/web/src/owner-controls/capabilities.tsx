import type { Dispatch, FormEventHandler, SetStateAction } from "react";
import type { Participant } from "../model.js";

export interface CapabilityState {
  participant_id: string;
  bundle: string[];
  grants: {
    id: string;
    capability: string;
    tier: number;
    requires_approval: boolean;
    expires_at: string | null;
  }[];
  revocations: { id: string; capability: string }[];
}

interface CapabilitiesSectionProps {
  busy: boolean;
  targets: Participant[];
  targetId: string;
  setTargetId: Dispatch<SetStateAction<string>>;
  capabilityState: CapabilityState | undefined;
  capability: string;
  setCapability: Dispatch<SetStateAction<string>>;
  expiresAt: string;
  setExpiresAt: Dispatch<SetStateAction<string>>;
  requiresApproval: boolean;
  setRequiresApproval: Dispatch<SetStateAction<boolean>>;
  onGrant: FormEventHandler<HTMLFormElement>;
  onRevoke: (grant: CapabilityState["grants"][number]) => void;
}

export function CapabilitiesSection({
  busy,
  targets,
  targetId,
  setTargetId,
  capabilityState,
  capability,
  setCapability,
  expiresAt,
  setExpiresAt,
  requiresApproval,
  setRequiresApproval,
  onGrant,
  onRevoke,
}: CapabilitiesSectionProps) {
  return (
    <section aria-label="Capabilities">
      <h3>Capabilities</h3>
      <label>
        Participant
        <select
          data-testid="capability-participant"
          value={targetId}
          onChange={(event) => setTargetId(event.target.value)}
        >
          <option value="">Choose a participant</option>
          {targets.map((participant) => (
            <option key={participant.id} value={participant.id}>
              {participant.display_name}
            </option>
          ))}
        </select>
      </label>
      {targetId && (
        <>
          {capabilityState?.participant_id === targetId ? (
            <>
              <p>
                <strong>Role bundle</strong>
              </p>
              <p data-testid="capability-bundle">
                {capabilityState.bundle.join(", ") || "No role capabilities"}
              </p>
              <h4>Explicit grants</h4>
              {capabilityState.grants.length ? (
                <ul className="list" data-testid="capability-grants">
                  {capabilityState.grants.map((grant) => (
                    <li key={grant.id} data-testid="capability-grant">
                      {grant.capability} (tier {grant.tier}
                      {grant.requires_approval ? ", approval required" : ""}){" "}
                      {grant.expires_at && (
                        <span className="muted">
                          expires {new Date(grant.expires_at).toLocaleString()}{" "}
                        </span>
                      )}
                      <button
                        data-testid="revoke-capability"
                        disabled={busy}
                        onClick={() => onRevoke(grant)}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No explicit grants.</p>
              )}
              <h4>Revocations</h4>
              <ul className="list" data-testid="capability-revocations">
                {capabilityState.revocations.map((revocation) => (
                  <li key={revocation.id}>{revocation.capability}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">Loading capabilities…</p>
          )}
          <form onSubmit={onGrant}>
            <label>
              Capability
              <input
                data-testid="capability-input"
                value={capability}
                onChange={(event) => setCapability(event.target.value)}
                placeholder="tasks.create or workspace.write:src/**"
                required
              />
            </label>
            <label>
              Expires at (required for Tier 3)
              <input
                data-testid="capability-expiry"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </label>
            <label>
              <input
                data-testid="capability-requires-approval"
                type="checkbox"
                checked={requiresApproval}
                onChange={(event) => setRequiresApproval(event.target.checked)}
              />
              Require approval when this capability is used
            </label>
            <button data-testid="grant-capability" disabled={busy || !capability.trim()}>
              Grant capability
            </button>
          </form>
          <p className="muted">
            The server validates capability names. Authority powers cannot be granted or revoked
            here; Tier 3 grants expire within 24 hours.
          </p>
        </>
      )}
    </section>
  );
}
