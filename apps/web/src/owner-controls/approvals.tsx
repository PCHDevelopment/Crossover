import type { Participant } from "../model.js";

export interface Approval {
  id: string;
  requester_id: string;
  method: string;
  params: unknown;
  capability: string;
  expires_at: string;
}

interface ApprovalsSectionProps {
  busy: boolean;
  approvals: Approval[];
  targets: Participant[];
  onRefresh: () => void;
  onDecide: (approval: Approval, decision: "approve" | "reject") => void;
}

export function ApprovalsSection({
  busy,
  approvals,
  targets,
  onRefresh,
  onDecide,
}: ApprovalsSectionProps) {
  return (
    <section aria-label="Approvals">
      <h3>Pending approvals</h3>
      <button data-testid="refresh-approvals" disabled={busy} onClick={onRefresh}>
        Refresh
      </button>
      {approvals.length === 0 ? (
        <p className="muted">No pending approvals.</p>
      ) : (
        <ul className="list" data-testid="pending-approvals">
          {approvals.map((approval) => {
            const requester = targets.find(
              (participant) => participant.id === approval.requester_id,
            );
            return (
              <li key={approval.id} data-testid="pending-approval">
                <strong>{approval.method}</strong> from{" "}
                {requester?.display_name ?? approval.requester_id}
                <div className="muted">
                  {approval.capability} · expires {new Date(approval.expires_at).toLocaleString()}
                </div>
                <pre>{JSON.stringify(approval.params, null, 2)}</pre>
                <button
                  data-testid="approve-request"
                  disabled={busy}
                  onClick={() => onDecide(approval, "approve")}
                >
                  Approve
                </button>{" "}
                <button
                  data-testid="reject-request"
                  disabled={busy}
                  onClick={() => onDecide(approval, "reject")}
                >
                  Reject
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
