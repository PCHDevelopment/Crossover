import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import { DEFAULT_PROTECTED_PATHS } from "@crossover/workspace/protected-paths";
import type { Participant } from "./model.js";

type Settings = Record<string, unknown> | null;
type EventListener = (listener: (event: SdkEvent) => void) => () => void;

interface CapabilityState {
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

interface Approval {
  id: string;
  requester_id: string;
  method: string;
  params: unknown;
  capability: string;
  expires_at: string;
}

type AssignableRole = Exclude<Participant["role"], "LEAD">;
const ASSIGNABLE_ROLES: readonly AssignableRole[] = ["DEVELOPER", "REVIEWER", "OBSERVER"];
const BUDGET_FIELDS = [
  { name: "commands", label: "Commands", window: "per minute", default: 120 },
  { name: "messages", label: "Messages", window: "per minute", default: 10 },
  { name: "changesets", label: "ChangeSets", window: "per hour", default: 60 },
  { name: "tool_invocations", label: "Tool invocations", window: "per hour", default: 100 },
] as const;
type BudgetName = (typeof BUDGET_FIELDS)[number]["name"];
type BudgetValues = Partial<Record<BudgetName, number | null>>;
type BudgetForm = Record<BudgetName, { value: string; unlimited: boolean }>;

interface BudgetAgentStatus {
  participant_id: string;
  display_name: string;
  status: string;
  budgets: BudgetValues;
  effective: Record<BudgetName, number | null>;
  usage: Record<BudgetName, number>;
}

interface BudgetStatus {
  room_budgets: BudgetValues;
  agents: BudgetAgentStatus[];
}

const budgetForm = (values: BudgetValues): BudgetForm =>
  Object.fromEntries(
    BUDGET_FIELDS.map(({ name }) => {
      const value = values[name];
      return [
        name,
        {
          value: value === undefined || value === null ? "" : String(value),
          unlimited: value === null,
        },
      ];
    }),
  ) as BudgetForm;

function budgetValues(form: BudgetForm): BudgetValues {
  const values: BudgetValues = {};
  for (const { name, label } of BUDGET_FIELDS) {
    const field = form[name];
    if (field.unlimited) {
      values[name] = null;
      continue;
    }
    if (!field.value.trim()) continue;
    const value = Number(field.value);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive whole number.`);
    }
    values[name] = value;
  }
  return values;
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const lines = (value: string): string[] => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];
const sameLines = (left: string, right: string): boolean =>
  lines(left).sort().join("\n") === lines(right).sort().join("\n");
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "The action failed";

function useServerSyncedText(serverValue: string): [string, (value: string) => void] {
  const [value, setValue] = useState(serverValue);
  const previousServerValue = useRef(serverValue);

  useEffect(() => {
    const previous = previousServerValue.current;
    if (sameLines(previous, serverValue)) {
      previousServerValue.current = serverValue;
      return;
    }
    previousServerValue.current = serverValue;
    setValue((current) =>
      sameLines(current, previous) || sameLines(current, serverValue) ? serverValue : current,
    );
  }, [serverValue]);

  return [value, setValue];
}

export function OwnerControlsView(props: {
  room: RoomClient;
  roomName: string;
  participants: Participant[];
  selfId: string;
  leadParticipantId: string | null;
  roomStatus: string;
  settings: Settings;
  onEvent: EventListener;
  onRefresh: () => Promise<void>;
}) {
  const {
    room,
    roomName,
    participants,
    selfId,
    leadParticipantId,
    roomStatus,
    settings,
    onEvent,
    onRefresh,
  } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const egressServerValue = list(settings?.["egress_allowlist"]).join("\n");
  const protectedPathsServerValue = list(
    settings?.["protected_paths"] ?? DEFAULT_PROTECTED_PATHS,
  ).join("\n");
  const [egress, setEgress] = useServerSyncedText(egressServerValue);
  const [protectedPaths, setProtectedPaths] = useServerSyncedText(protectedPathsServerValue);
  const targets = participants.filter((participant) => participant.status !== "REMOVED");
  const [targetId, setTargetId] = useState("");
  const [roleTargetId, setRoleTargetId] = useState("");
  const [nextRole, setNextRole] = useState<AssignableRole>("DEVELOPER");
  const [capabilityState, setCapabilityState] = useState<CapabilityState>();
  const [capability, setCapability] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [budgetStatus, setBudgetStatus] = useState<BudgetStatus>();
  const [roomBudgetForm, setRoomBudgetForm] = useState<BudgetForm>(() => budgetForm({}));
  const [budgetTargetId, setBudgetTargetId] = useState("");
  const budgetTargetIdRef = useRef("");
  const [agentBudgetForm, setAgentBudgetForm] = useState<BudgetForm>(() => budgetForm({}));
  const [budgetLoading, setBudgetLoading] = useState(false);

  const refreshCapabilities = useCallback(async () => {
    if (!targetId) {
      setCapabilityState(undefined);
      return;
    }
    const result = await room.api.capabilities.list<CapabilityState>({ participant_id: targetId });
    setCapabilityState(result.response);
  }, [room, targetId]);

  const refreshApprovals = useCallback(async () => {
    const result = await room.api.approvals.list<{ approvals: Approval[] }>({
      status: "PENDING",
      limit: 100,
    });
    setApprovals(result.response.approvals);
  }, [room]);

  const refreshBudgetStatus = useCallback(async (): Promise<BudgetStatus> => {
    const result = await room.api.budgets.get<BudgetStatus>({});
    setBudgetStatus(result.response);
    return result.response;
  }, [room]);

  const loadBudgetControls = useCallback(async () => {
    setBudgetLoading(true);
    try {
      const status = await refreshBudgetStatus();
      setRoomBudgetForm(budgetForm(status.room_budgets));
      const target =
        status.agents.find((agent) => agent.participant_id === budgetTargetIdRef.current) ??
        status.agents[0];
      const nextTargetId = target?.participant_id ?? "";
      budgetTargetIdRef.current = nextTargetId;
      setBudgetTargetId(nextTargetId);
      setAgentBudgetForm(budgetForm(target?.budgets ?? {}));
    } finally {
      setBudgetLoading(false);
    }
  }, [refreshBudgetStatus]);

  useEffect(() => {
    void refreshCapabilities().catch((err: unknown) => setError(errorText(err)));
  }, [refreshCapabilities]);

  useEffect(() => {
    void refreshApprovals().catch((err: unknown) => setError(errorText(err)));
    return onEvent((event) => {
      if (event.type === "approval.requested" || event.type === "approval.decided") {
        void refreshApprovals().catch((err: unknown) => setError(errorText(err)));
      }
      if (event.type === "capability.granted" || event.type === "capability.revoked") {
        void refreshCapabilities().catch((err: unknown) => setError(errorText(err)));
      }
      if (event.type === "room.budgets_changed") {
        void loadBudgetControls().catch((err: unknown) => setError(errorText(err)));
      }
      if (event.type === "budget.exceeded") {
        void refreshBudgetStatus().catch((err: unknown) => setError(errorText(err)));
      }
    });
  }, [loadBudgetControls, onEvent, refreshApprovals, refreshBudgetStatus, refreshCapabilities]);

  useEffect(() => {
    void loadBudgetControls().catch((err: unknown) => setError(errorText(err)));
  }, [loadBudgetControls]);

  const perform = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await onRefresh();
      setNotice(`${label} complete.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (participant: Participant) => {
    if (
      participant.id === selfId ||
      participant.id === leadParticipantId ||
      !window.confirm(
        `Remove ${participant.display_name}? Their room access tokens will be revoked permanently.`,
      )
    )
      return;
    void perform(`Remove ${participant.display_name}`, async () => {
      await room.api.participants.remove({ participant_id: participant.id });
    });
  };

  const changeRole = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const participant = targets.find((item) => item.id === roleTargetId);
    if (!participant || participant.role === "LEAD" || participant.role === nextRole) return;
    const subject = participant.id === selfId ? "your role" : `${participant.display_name}'s role`;
    if (!window.confirm(`Change ${subject} from ${participant.role} to ${nextRole}?`)) return;
    void perform("Change participant role", async () => {
      await room.api.participants.set_role({ participant_id: participant.id, role: nextRole });
    });
  };

  const submitEgress = (event: FormEvent) => {
    event.preventDefault();
    const hosts = lines(egress);
    if (
      !window.confirm(
        `Replace ${roomName}’s extra egress host allowlist with ${hosts.length ? hosts.join(", ") : "no extra hosts"}?`,
      )
    )
      return;
    void perform("Save egress allowlist", async () => {
      await room.api.room.set_egress_allowlist({ hosts });
    });
  };

  const submitProtectedPaths = (event: FormEvent) => {
    event.preventDefault();
    const patterns = lines(protectedPaths);
    if (
      !window.confirm(
        `Replace ${roomName}’s protected path patterns with ${patterns.length ? patterns.join(", ") : "no protected paths"}?`,
      )
    )
      return;
    void perform("Save protected paths", async () => {
      await room.api.room.set_protected_paths({ patterns });
    });
  };

  const submitRoomBudgets = (event: FormEvent) => {
    event.preventDefault();
    let budgets: BudgetValues;
    try {
      budgets = budgetValues(roomBudgetForm);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    if (!window.confirm("Replace the room's default limits for every agent?")) return;
    void perform("Save room budgets", async () => {
      await room.api.budgets.set({ budgets });
      await loadBudgetControls();
    });
  };

  const submitAgentBudgets = (event: FormEvent) => {
    event.preventDefault();
    if (!budgetTargetId) return;
    let budgets: BudgetValues;
    try {
      budgets = budgetValues(agentBudgetForm);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    const target = budgetStatus?.agents.find((agent) => agent.participant_id === budgetTargetId);
    if (!target || !window.confirm(`Replace ${target.display_name}'s budget overrides?`)) return;
    void perform(`Save ${target.display_name}'s budgets`, async () => {
      await room.api.budgets.set({ participant_id: budgetTargetId, budgets });
      await loadBudgetControls();
    });
  };

  const grantCapability = (event: FormEvent) => {
    event.preventDefault();
    const participant = targets.find((item) => item.id === targetId);
    const trimmed = capability.trim();
    if (!participant || !trimmed) return;
    const approvalText = requiresApproval ? " with approval required" : "";
    if (!window.confirm(`Grant ${trimmed} to ${participant.display_name}${approvalText}?`)) return;
    void perform("Grant capability", async () => {
      await room.api.capabilities.grant({
        participant_id: targetId,
        capability: trimmed,
        requires_approval: requiresApproval,
        ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      });
      await refreshCapabilities();
      setCapability("");
      setExpiresAt("");
    });
  };

  const revokeCapability = (grant: CapabilityState["grants"][number]) => {
    const participant = targets.find((item) => item.id === targetId);
    if (
      !participant ||
      !window.confirm(`Revoke ${grant.capability} from ${participant.display_name}?`)
    )
      return;
    void perform("Revoke capability", async () => {
      await room.api.capabilities.revoke({
        participant_id: targetId,
        capability: grant.capability,
      });
      await refreshCapabilities();
    });
  };

  const decideApproval = (approval: Approval, decision: "approve" | "reject") => {
    const requester = targets.find((participant) => participant.id === approval.requester_id);
    const requesterName = requester?.display_name ?? approval.requester_id;
    const request = `${approval.method} from ${requesterName}`;
    const details = JSON.stringify(approval.params) ?? "Request details unavailable";
    const message =
      decision === "approve"
        ? `Approve ${request}? The command may run immediately. Request: ${details}`
        : `Reject ${request}? Request: ${details}`;
    if (!window.confirm(message)) return;
    void perform(`${decision === "approve" ? "Approve" : "Reject"} request`, async () => {
      await room.api.approvals.decide({ approval_id: approval.id, decision });
      await refreshApprovals();
    });
  };

  const freeze = () => {
    if (!window.confirm(`Freeze ${roomName}? Active agent work will stop until it is resumed.`))
      return;
    void perform("Freeze room", async () => {
      await room.api.room.freeze({});
    });
  };

  const resume = () =>
    void perform("Resume room", async () => {
      await room.api.room.resume({});
    });

  return (
    <section aria-label="Owner controls" data-testid="owner-controls">
      <h2>Owner controls</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" data-testid="owner-controls-notice">
          {notice}
        </p>
      )}

      <section aria-label="Room lifecycle">
        <h3>Room lifecycle</h3>
        <p>
          Room status: <strong data-testid="owner-room-status">{roomStatus}</strong>
        </p>
        {roomStatus === "ACTIVE" ? (
          <button data-testid="freeze-room" disabled={busy} onClick={freeze}>
            Freeze room
          </button>
        ) : roomStatus === "PAUSED" ? (
          <button data-testid="resume-room" disabled={busy} onClick={resume}>
            Resume room
          </button>
        ) : (
          <p className="muted">Lifecycle controls are unavailable for this room status.</p>
        )}
      </section>

      <section aria-label="Participant access">
        <h3>Change participant role</h3>
        <label>
          Participant
          <select
            data-testid="role-participant"
            value={roleTargetId}
            onChange={(event) => {
              const id = event.target.value;
              const participant = targets.find((item) => item.id === id);
              setRoleTargetId(id);
              setNextRole(
                participant && participant.role !== "LEAD" ? participant.role : "DEVELOPER",
              );
            }}
          >
            <option value="">Choose a participant</option>
            {targets.map((participant) => (
              <option key={participant.id} value={participant.id}>
                {participant.display_name}
                {participant.id === selfId ? " (you)" : ""}
              </option>
            ))}
          </select>
        </label>
        {roleTargetId &&
        targets.find((participant) => participant.id === roleTargetId)?.role === "LEAD" ? (
          <p className="muted" data-testid="role-lead-guidance">
            Appoint another lead before changing this participant’s role.
          </p>
        ) : (
          <form onSubmit={changeRole}>
            <label>
              New role
              <select
                data-testid="participant-role-value"
                value={nextRole}
                onChange={(event) => setNextRole(event.target.value as AssignableRole)}
              >
                {ASSIGNABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <button
              data-testid="change-participant-role"
              disabled={
                busy ||
                !roleTargetId ||
                targets.find((item) => item.id === roleTargetId)?.role === nextRole
              }
            >
              Change role
            </button>
          </form>
        )}

        <h3>Remove participant</h3>
        <ul className="list">
          {participants
            .filter((participant) => participant.id !== selfId)
            .map((participant) => (
              <li key={participant.id} data-testid="owner-participant">
                {participant.display_name}{" "}
                <span className="muted">
                  ({participant.role}, {participant.status})
                </span>{" "}
                {participant.id === leadParticipantId ? (
                  <span className="muted">Appoint another lead before removal.</span>
                ) : (
                  <button
                    data-testid="remove-participant"
                    disabled={busy}
                    onClick={() => remove(participant)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
        </ul>
      </section>

      <section aria-label="Budgets">
        <h3>Agent budgets</h3>
        <p className="muted">
          Room defaults apply to each agent. Leave a value blank to inherit the room value or
          platform default; No limit removes this scope's cap, while a limit from the other scope
          still applies.
        </p>
        <button
          type="button"
          data-testid="refresh-budgets"
          disabled={busy || budgetLoading}
          onClick={() =>
            void loadBudgetControls().catch((err: unknown) => setError(errorText(err)))
          }
        >
          {budgetLoading ? "Loading budgets…" : "Refresh budget status"}
        </button>

        <form onSubmit={submitRoomBudgets}>
          <h4>Room defaults</h4>
          {BUDGET_FIELDS.map(({ name, label, window, default: defaultValue }) => (
            <label key={name}>
              {label} ({window}; platform default {defaultValue})
              <input
                data-testid={`room-budget-${name}`}
                type="number"
                min={1}
                step={1}
                value={roomBudgetForm[name].value}
                disabled={busy || roomBudgetForm[name].unlimited}
                onChange={(event) =>
                  setRoomBudgetForm((current) => ({
                    ...current,
                    [name]: { ...current[name], value: event.target.value },
                  }))
                }
              />
              <span>
                <input
                  data-testid={`room-budget-unlimited-${name}`}
                  type="checkbox"
                  checked={roomBudgetForm[name].unlimited}
                  disabled={busy}
                  onChange={(event) =>
                    setRoomBudgetForm((current) => ({
                      ...current,
                      [name]: { ...current[name], unlimited: event.target.checked },
                    }))
                  }
                />
                No limit
              </span>
            </label>
          ))}
          <button data-testid="save-room-budgets" disabled={busy || budgetLoading}>
            Save room defaults
          </button>
        </form>

        <form onSubmit={submitAgentBudgets}>
          <h4>Agent overrides</h4>
          <label>
            Agent
            <select
              data-testid="budget-agent"
              value={budgetTargetId}
              disabled={busy || budgetLoading || !budgetStatus?.agents.length}
              onChange={(event) => {
                const participantId = event.target.value;
                budgetTargetIdRef.current = participantId;
                setBudgetTargetId(participantId);
                const target = budgetStatus?.agents.find(
                  (agent) => agent.participant_id === participantId,
                );
                setAgentBudgetForm(budgetForm(target?.budgets ?? {}));
              }}
            >
              <option value="">Choose an agent</option>
              {budgetStatus?.agents.map((agent) => (
                <option key={agent.participant_id} value={agent.participant_id}>
                  {agent.display_name} ({agent.status.toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          {budgetTargetId ? (
            <>
              {BUDGET_FIELDS.map(({ name, label, window }) => (
                <label key={name}>
                  {label} ({window})
                  <input
                    data-testid={`agent-budget-${name}`}
                    type="number"
                    min={1}
                    step={1}
                    value={agentBudgetForm[name].value}
                    disabled={busy || agentBudgetForm[name].unlimited}
                    onChange={(event) =>
                      setAgentBudgetForm((current) => ({
                        ...current,
                        [name]: { ...current[name], value: event.target.value },
                      }))
                    }
                  />
                  <span>
                    <input
                      data-testid={`agent-budget-unlimited-${name}`}
                      type="checkbox"
                      checked={agentBudgetForm[name].unlimited}
                      disabled={busy}
                      onChange={(event) =>
                        setAgentBudgetForm((current) => ({
                          ...current,
                          [name]: { ...current[name], unlimited: event.target.checked },
                        }))
                      }
                    />
                    No limit
                  </span>
                </label>
              ))}
              <button data-testid="save-agent-budgets" disabled={busy || budgetLoading}>
                Save agent overrides
              </button>
            </>
          ) : (
            <p className="muted">No agents in this room.</p>
          )}
        </form>

        <h4>Current usage</h4>
        {!budgetStatus?.agents.length ? (
          <p className="muted">No agent budget usage yet.</p>
        ) : (
          <ul className="list" data-testid="budget-usage-list">
            {budgetStatus.agents.map((agent) => (
              <li key={agent.participant_id}>
                <strong>{agent.display_name}</strong>
                <ul>
                  {BUDGET_FIELDS.map(({ name, label, window }) => (
                    <li key={name} data-testid={`budget-usage-${agent.participant_id}-${name}`}>
                      {label}: {agent.usage[name]} used of {agent.effective[name] ?? "unlimited"}{" "}
                      {window}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

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
                          onClick={() => revokeCapability(grant)}
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
            <form onSubmit={grantCapability}>
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

      <section aria-label="Approvals">
        <h3>Pending approvals</h3>
        <button
          data-testid="refresh-approvals"
          disabled={busy}
          onClick={() => void refreshApprovals().catch((err: unknown) => setError(errorText(err)))}
        >
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
                    onClick={() => decideApproval(approval, "approve")}
                  >
                    Approve
                  </button>{" "}
                  <button
                    data-testid="reject-request"
                    disabled={busy}
                    onClick={() => decideApproval(approval, "reject")}
                  >
                    Reject
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Network egress policy">
        <h3>Extra egress hosts</h3>
        <p className="muted">
          One exact host or *.suffix pattern per line. Platform defaults remain in effect.
        </p>
        <form onSubmit={submitEgress}>
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

      <section aria-label="Protected paths">
        <h3>Protected paths</h3>
        <p className="muted">
          Default patterns apply until changed. An explicit empty list disables protected-path
          checks.
        </p>
        <form onSubmit={submitProtectedPaths}>
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
    </section>
  );
}
