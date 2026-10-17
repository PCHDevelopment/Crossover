import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import { DEFAULT_PROTECTED_PATHS } from "@crossover/protocol";
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
const COMPUTE_BUDGET_FIELDS = [
  { name: "agent_vcpu_hours_per_day", label: "Per-agent sandbox CPU", default: 4 },
  { name: "room_vcpu_hours_per_day", label: "Room sandbox CPU", default: 40 },
] as const;
type BudgetName = (typeof BUDGET_FIELDS)[number]["name"];
type BudgetValues = Partial<Record<BudgetName, number | null>>;
type BudgetForm = Record<BudgetName, { value: string; unlimited: boolean }>;
type ComputeBudgetName = (typeof COMPUTE_BUDGET_FIELDS)[number]["name"];
type ComputeBudgetValues = Partial<Record<ComputeBudgetName, number | null>>;
type ComputeBudgetForm = Record<ComputeBudgetName, { value: string; unlimited: boolean }>;

function preserveEditedBudgetFields<
  T extends Record<string, { value: string; unlimited: boolean }>,
>(incoming: T, current: T, edited: ReadonlySet<string>): T {
  return Object.fromEntries(
    Object.entries(incoming).map(([name, field]) => [
      name,
      edited.has(name) ? current[name] : field,
    ]),
  ) as T;
}

interface BudgetAgentStatus {
  participant_id: string;
  display_name: string;
  status: string;
  budgets: BudgetValues;
  compute_budgets: ComputeBudgetValues;
  effective: Record<BudgetName, number | null>;
  usage: Record<BudgetName, number>;
  compute: {
    limit_vcpu_hours_per_day: number | null;
    used_vcpu_hours: number;
    reserved_vcpu_hours: number;
  };
}

interface BudgetStatus {
  room_budgets: BudgetValues;
  compute_budgets: ComputeBudgetValues;
  room_compute: {
    limit_vcpu_hours_per_day: number | null;
    used_vcpu_hours: number;
    reserved_vcpu_hours: number;
  };
  agents: BudgetAgentStatus[];
}

interface RoomIntegration {
  provider: string;
  status: string;
  status_reason: string | null;
  config?: Record<string, unknown>;
}

interface PendingGitHubRepositories {
  repositories: { name: string }[];
}

const GITHUB_PENDING_ID = /^[A-Za-z0-9_-]{43}$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

const computeBudgetForm = (values: ComputeBudgetValues): ComputeBudgetForm =>
  Object.fromEntries(
    COMPUTE_BUDGET_FIELDS.map(({ name }) => {
      const value = values[name];
      return [
        name,
        {
          value: value === undefined || value === null ? "" : String(value),
          unlimited: value === null,
        },
      ];
    }),
  ) as ComputeBudgetForm;

function computeBudgetValues(form: ComputeBudgetForm): ComputeBudgetValues {
  const values: ComputeBudgetValues = {};
  for (const { name, label } of COMPUTE_BUDGET_FIELDS) {
    const field = form[name];
    if (field.unlimited) {
      values[name] = null;
      continue;
    }
    if (!field.value.trim()) continue;
    const value = Number(field.value);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${label} must be a positive whole number.`);
    values[name] = value;
  }
  return values;
}

function formatCpuHours(hours: number): string {
  return hours.toFixed(3).replace(/\.000$/, "");
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
  archivedAt: string | null;
  retentionDays: number;
  settings: Settings;
  githubPendingId: string | undefined;
  onGitHubPendingHandled: () => void;
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
    archivedAt,
    retentionDays,
    settings,
    githubPendingId,
    onGitHubPendingHandled,
    onEvent,
    onRefresh,
  } = props;
  const [busy, setBusy] = useState(false);
  const [retentionDaysInput, setRetentionDaysInput] = useState(String(retentionDays));
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
  const [roomComputeBudgetForm, setRoomComputeBudgetForm] = useState<ComputeBudgetForm>(() =>
    computeBudgetForm({}),
  );
  const roomBudgetEdits = useRef(new Set<BudgetName>());
  const roomComputeBudgetEdits = useRef(new Set<ComputeBudgetName>());
  const [budgetTargetId, setBudgetTargetId] = useState("");
  const budgetTargetIdRef = useRef("");
  const [agentBudgetForm, setAgentBudgetForm] = useState<BudgetForm>(() => budgetForm({}));
  const [agentComputeBudgetForm, setAgentComputeBudgetForm] = useState<ComputeBudgetForm>(() =>
    computeBudgetForm({}),
  );
  const agentBudgetEdits = useRef(new Set<BudgetName>());
  const agentComputeBudgetEdits = useRef(new Set<ComputeBudgetName>());
  const agentBudgetEditsTarget = useRef("");
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [integrations, setIntegrations] = useState<RoomIntegration[]>([]);
  const [pendingRepositories, setPendingRepositories] = useState<string[]>([]);
  const [selectedRepositories, setSelectedRepositories] = useState<string[]>([]);
  const [pendingRepositoriesLoading, setPendingRepositoriesLoading] = useState(false);

  useEffect(() => setRetentionDaysInput(String(retentionDays)), [retentionDays]);

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

  const refreshIntegrations = useCallback(async () => {
    const result = await room.api.integrations.list<{ integrations: RoomIntegration[] }>({});
    setIntegrations(result.response.integrations);
  }, [room]);

  useEffect(() => {
    void refreshIntegrations().catch((err: unknown) => setError(errorText(err)));
  }, [refreshIntegrations]);

  useEffect(() => {
    if (!githubPendingId) {
      setPendingRepositories([]);
      setSelectedRepositories([]);
      return;
    }
    if (!GITHUB_PENDING_ID.test(githubPendingId)) {
      setError("The GitHub connection link is invalid or expired. Start again to reconnect.");
      onGitHubPendingHandled();
      return;
    }
    let cancelled = false;
    setPendingRepositoriesLoading(true);
    void (async () => {
      try {
        const response = await fetch(
          `/v1/rooms/${encodeURIComponent(room.roomId)}/integrations/github/pending?pending_id=${encodeURIComponent(githubPendingId)}`,
          { credentials: "same-origin", headers: { accept: "application/json" } },
        );
        if (!response.ok) throw new Error("The GitHub repository list is unavailable or expired.");
        const value: unknown = await response.json();
        const repositories =
          typeof value === "object" && value !== null && "repositories" in value
            ? (value as PendingGitHubRepositories).repositories
            : undefined;
        if (
          !Array.isArray(repositories) ||
          repositories.length === 0 ||
          repositories.some(
            (repository) =>
              !repository ||
              typeof repository.name !== "string" ||
              !GITHUB_REPOSITORY.test(repository.name),
          )
        ) {
          throw new Error("GitHub returned an invalid repository list.");
        }
        if (!cancelled) setPendingRepositories(repositories.map(({ name }) => name));
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      } finally {
        if (!cancelled) setPendingRepositoriesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [githubPendingId, onGitHubPendingHandled, room.roomId]);

  const loadBudgetControls = useCallback(async () => {
    setBudgetLoading(true);
    try {
      const status = await refreshBudgetStatus();
      setRoomBudgetForm((current) =>
        preserveEditedBudgetFields(
          budgetForm(status.room_budgets),
          current,
          roomBudgetEdits.current,
        ),
      );
      setRoomComputeBudgetForm((current) =>
        preserveEditedBudgetFields(
          computeBudgetForm(status.compute_budgets),
          current,
          roomComputeBudgetEdits.current,
        ),
      );
      const target =
        status.agents.find((agent) => agent.participant_id === budgetTargetIdRef.current) ??
        status.agents[0];
      const nextTargetId = target?.participant_id ?? "";
      if (agentBudgetEditsTarget.current !== nextTargetId) {
        agentBudgetEdits.current.clear();
        agentComputeBudgetEdits.current.clear();
        agentBudgetEditsTarget.current = nextTargetId;
      }
      budgetTargetIdRef.current = nextTargetId;
      setBudgetTargetId(nextTargetId);
      setAgentBudgetForm((current) =>
        preserveEditedBudgetFields(
          budgetForm(target?.budgets ?? {}),
          current,
          agentBudgetEdits.current,
        ),
      );
      setAgentComputeBudgetForm((current) =>
        preserveEditedBudgetFields(
          computeBudgetForm(target?.compute_budgets ?? {}),
          current,
          agentComputeBudgetEdits.current,
        ),
      );
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
      if (event.type === "integration.connected" || event.type === "integration.disconnected") {
        void refreshIntegrations().catch((err: unknown) => setError(errorText(err)));
      }
    });
  }, [
    loadBudgetControls,
    onEvent,
    refreshApprovals,
    refreshBudgetStatus,
    refreshCapabilities,
    refreshIntegrations,
  ]);

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

  const githubIntegration = integrations.find(({ provider }) => provider === "github");
  const startGitHubInstall = () => {
    window.location.assign(
      `/v1/rooms/${encodeURIComponent(room.roomId)}/integrations/github/install`,
    );
  };
  const connectGitHub = () => {
    if (!githubPendingId || selectedRepositories.length === 0) return;
    void perform("Connect GitHub", async () => {
      await room.api.integrations.connect({
        provider: "github",
        pending_id: githubPendingId,
        repositories: selectedRepositories,
      });
      await refreshIntegrations();
      onGitHubPendingHandled();
      setPendingRepositories([]);
      setSelectedRepositories([]);
    });
  };
  const verifyGitHub = () =>
    void perform("Verify GitHub", async () => {
      await room.api.integrations.verify({ provider: "github" });
      await refreshIntegrations();
    });
  const disconnectGitHub = () => {
    if (!window.confirm("Disconnect GitHub from this room?")) return;
    void perform("Disconnect GitHub", async () => {
      await room.api.integrations.disconnect({ provider: "github" });
      await refreshIntegrations();
    });
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
      roomBudgetEdits.current.clear();
      await loadBudgetControls();
    });
  };

  const submitComputeBudgets = (event: FormEvent) => {
    event.preventDefault();
    let compute_budgets: ComputeBudgetValues;
    try {
      compute_budgets = computeBudgetValues(roomComputeBudgetForm);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    if (!window.confirm("Replace the room's daily sandbox CPU limits?")) return;
    void perform("Save sandbox CPU limits", async () => {
      await room.api.budgets.set({ compute_budgets });
      roomComputeBudgetEdits.current.clear();
      await loadBudgetControls();
    });
  };

  const submitAgentBudgets = (event: FormEvent) => {
    event.preventDefault();
    if (!budgetTargetId) return;
    let budgets: BudgetValues;
    let compute_budgets: ComputeBudgetValues;
    try {
      budgets = budgetValues(agentBudgetForm);
      const allComputeBudgets = computeBudgetValues(agentComputeBudgetForm);
      const agentComputeBudget = allComputeBudgets.agent_vcpu_hours_per_day;
      compute_budgets =
        agentComputeBudget === undefined ? {} : { agent_vcpu_hours_per_day: agentComputeBudget };
    } catch (err) {
      setError(errorText(err));
      return;
    }
    const target = budgetStatus?.agents.find((agent) => agent.participant_id === budgetTargetId);
    if (!target || !window.confirm(`Replace ${target.display_name}'s budget overrides?`)) return;
    void perform(`Save ${target.display_name}'s budgets`, async () => {
      await room.api.budgets.set({ participant_id: budgetTargetId, budgets, compute_budgets });
      agentBudgetEdits.current.clear();
      agentComputeBudgetEdits.current.clear();
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

  const archive = () => {
    if (roomStatus !== "ACTIVE" && roomStatus !== "PAUSED") return;
    if (
      !window.confirm(
        `Archive ${roomName}? It will become read-only and its data will be permanently deleted after ${retentionDays} days, following a 7-day notice.`,
      )
    )
      return;
    void perform("Archive room", async () => {
      await room.api.room.archive({});
    });
  };

  const submitRetention = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextDays = Number(retentionDaysInput);
    if (!Number.isSafeInteger(nextDays) || nextDays < 30 || nextDays > 365) {
      setError("Retention must be a whole number from 30 to 365 days.");
      return;
    }
    if (nextDays === retentionDays) return;
    void perform("Save room retention", async () => {
      await room.api.rooms.set_retention({ retention_days: nextDays });
    });
  };

  const unarchive = () => {
    if (
      roomStatus !== "ARCHIVED" ||
      !window.confirm(
        `Unarchive ${roomName}? The room will become active. Its existing sandbox data will not be recreated.`,
      )
    )
      return;
    void perform("Unarchive room", async () => {
      await room.api.rooms.unarchive({});
    });
  };

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

      <section aria-label="Integrations" data-testid="owner-integrations">
        <h3>Integrations</h3>
        <h4>GitHub</h4>
        <p>
          Status:{" "}
          <strong data-testid="github-integration-status">
            {githubIntegration?.status ?? "Not connected"}
          </strong>
          {githubIntegration?.status_reason ? ` · ${githubIntegration.status_reason}` : ""}
        </p>
        {Array.isArray(githubIntegration?.config?.["repositories"]) && (
          <p data-testid="github-connected-repositories">
            Repositories: {(githubIntegration.config["repositories"] as string[]).join(", ")}
          </p>
        )}
        <button
          type="button"
          data-testid="github-connect"
          disabled={busy}
          onClick={startGitHubInstall}
        >
          Connect GitHub
        </button>{" "}
        {githubIntegration?.status === "CONNECTED" && (
          <>
            <button
              type="button"
              data-testid="github-verify"
              disabled={busy}
              onClick={verifyGitHub}
            >
              Verify
            </button>{" "}
            <button
              type="button"
              data-testid="github-disconnect"
              disabled={busy}
              onClick={disconnectGitHub}
            >
              Disconnect
            </button>
          </>
        )}
        {githubPendingId && (
          <div data-testid="github-repository-picker">
            <h4>Choose repositories</h4>
            {pendingRepositoriesLoading ? (
              <p className="muted">Loading repositories…</p>
            ) : pendingRepositories.length === 0 ? (
              <p className="muted">
                No verified repositories are available. Start the connection again.
              </p>
            ) : (
              <fieldset disabled={busy}>
                <legend>Allow Crossover to use these repositories</legend>
                {pendingRepositories.map((repository) => (
                  <label key={repository}>
                    <input
                      type="checkbox"
                      data-testid="github-repository-option"
                      checked={selectedRepositories.includes(repository)}
                      onChange={(event) =>
                        setSelectedRepositories((selected) =>
                          event.target.checked
                            ? [...selected, repository]
                            : selected.filter((name) => name !== repository),
                        )
                      }
                    />
                    {repository}
                  </label>
                ))}
              </fieldset>
            )}
            <button
              type="button"
              data-testid="github-connect-selected"
              disabled={busy || pendingRepositoriesLoading || selectedRepositories.length === 0}
              onClick={connectGitHub}
            >
              Connect selected repositories
            </button>
          </div>
        )}
      </section>

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
        ) : roomStatus === "ARCHIVED" ? (
          <button data-testid="unarchive-room" disabled={busy} onClick={unarchive}>
            Unarchive room
          </button>
        ) : (
          <p className="muted">Lifecycle controls are unavailable for this room status.</p>
        )}
        {(roomStatus === "ACTIVE" || roomStatus === "PAUSED") && (
          <button data-testid="archive-room" disabled={busy} onClick={archive}>
            Archive room
          </button>
        )}
        <form onSubmit={submitRetention}>
          <label>
            Retain archived room for
            <select
              data-testid="room-retention-days"
              value={retentionDaysInput}
              onChange={(event) => setRetentionDaysInput(event.target.value)}
              disabled={busy}
            >
              {[30, 60, 90, 180, 365].map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
              {![30, 60, 90, 180, 365].includes(retentionDays) && (
                <option value={retentionDays}>{retentionDays} days (current)</option>
              )}
            </select>
          </label>
          <button
            data-testid="save-room-retention"
            disabled={busy || Number(retentionDaysInput) === retentionDays}
          >
            Save retention
          </button>
        </form>
        {roomStatus === "ARCHIVED" && archivedAt && (
          <p data-testid="room-retention-deadline">
            Scheduled deletion:{" "}
            {new Date(Date.parse(archivedAt) + retentionDays * 86_400_000).toLocaleString()}
          </p>
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
                onChange={(event) => {
                  roomBudgetEdits.current.add(name);
                  setRoomBudgetForm((current) => ({
                    ...current,
                    [name]: { ...current[name], value: event.target.value },
                  }));
                }}
              />
              <span>
                <input
                  data-testid={`room-budget-unlimited-${name}`}
                  type="checkbox"
                  checked={roomBudgetForm[name].unlimited}
                  disabled={busy}
                  onChange={(event) => {
                    roomBudgetEdits.current.add(name);
                    setRoomBudgetForm((current) => ({
                      ...current,
                      [name]: { ...current[name], unlimited: event.target.checked },
                    }));
                  }}
                />
                No limit
              </span>
            </label>
          ))}
          <button data-testid="save-room-budgets" disabled={busy || budgetLoading}>
            Save room defaults
          </button>
        </form>

        <form onSubmit={submitComputeBudgets}>
          <h4>Daily sandbox CPU limits</h4>
          <p className="muted">
            Limits count measured sandbox CPU time in vCPU-hours per UTC day. Blank uses the
            platform default; No limit removes that cap.
          </p>
          {COMPUTE_BUDGET_FIELDS.map(({ name, label, default: defaultValue }) => (
            <label key={name}>
              {label} (vCPU-hours/day; platform default {defaultValue})
              <input
                data-testid={`compute-budget-${name}`}
                type="number"
                min={1}
                step={1}
                value={roomComputeBudgetForm[name].value}
                disabled={busy || roomComputeBudgetForm[name].unlimited}
                onChange={(event) => {
                  roomComputeBudgetEdits.current.add(name);
                  setRoomComputeBudgetForm((current) => ({
                    ...current,
                    [name]: { ...current[name], value: event.target.value },
                  }));
                }}
              />
              <span>
                <input
                  data-testid={`compute-budget-unlimited-${name}`}
                  type="checkbox"
                  checked={roomComputeBudgetForm[name].unlimited}
                  disabled={busy}
                  onChange={(event) => {
                    roomComputeBudgetEdits.current.add(name);
                    setRoomComputeBudgetForm((current) => ({
                      ...current,
                      [name]: { ...current[name], unlimited: event.target.checked },
                    }));
                  }}
                />
                No limit
              </span>
            </label>
          ))}
          <button data-testid="save-compute-budgets" disabled={busy || budgetLoading}>
            Save CPU limits
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
                agentBudgetEdits.current.clear();
                agentComputeBudgetEdits.current.clear();
                agentBudgetEditsTarget.current = participantId;
                setAgentBudgetForm(budgetForm(target?.budgets ?? {}));
                setAgentComputeBudgetForm(computeBudgetForm(target?.compute_budgets ?? {}));
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
                    onChange={(event) => {
                      agentBudgetEdits.current.add(name);
                      setAgentBudgetForm((current) => ({
                        ...current,
                        [name]: { ...current[name], value: event.target.value },
                      }));
                    }}
                  />
                  <span>
                    <input
                      data-testid={`agent-budget-unlimited-${name}`}
                      type="checkbox"
                      checked={agentBudgetForm[name].unlimited}
                      disabled={busy}
                      onChange={(event) => {
                        agentBudgetEdits.current.add(name);
                        setAgentBudgetForm((current) => ({
                          ...current,
                          [name]: { ...current[name], unlimited: event.target.checked },
                        }));
                      }}
                    />
                    No limit
                  </span>
                </label>
              ))}
              <label>
                Per-agent sandbox CPU (vCPU-hours/day; default 4)
                <input
                  data-testid="agent-compute-budget-agent_vcpu_hours_per_day"
                  type="number"
                  min={1}
                  step={1}
                  value={agentComputeBudgetForm.agent_vcpu_hours_per_day.value}
                  disabled={busy || agentComputeBudgetForm.agent_vcpu_hours_per_day.unlimited}
                  onChange={(event) => {
                    agentComputeBudgetEdits.current.add("agent_vcpu_hours_per_day");
                    setAgentComputeBudgetForm((current) => ({
                      ...current,
                      agent_vcpu_hours_per_day: {
                        ...current.agent_vcpu_hours_per_day,
                        value: event.target.value,
                      },
                    }));
                  }}
                />
                <span>
                  <input
                    data-testid="agent-compute-budget-unlimited-agent_vcpu_hours_per_day"
                    type="checkbox"
                    checked={agentComputeBudgetForm.agent_vcpu_hours_per_day.unlimited}
                    disabled={busy}
                    onChange={(event) => {
                      agentComputeBudgetEdits.current.add("agent_vcpu_hours_per_day");
                      setAgentComputeBudgetForm((current) => ({
                        ...current,
                        agent_vcpu_hours_per_day: {
                          ...current.agent_vcpu_hours_per_day,
                          unlimited: event.target.checked,
                        },
                      }));
                    }}
                  />
                  No limit
                </span>
              </label>
              <button data-testid="save-agent-budgets" disabled={busy || budgetLoading}>
                Save agent overrides
              </button>
            </>
          ) : (
            <p className="muted">No agents in this room.</p>
          )}
        </form>

        <h4>Current usage</h4>
        <p data-testid="room-compute-usage">
          Room sandbox CPU: {formatCpuHours(budgetStatus?.room_compute.used_vcpu_hours ?? 0)} used,{" "}
          {formatCpuHours(budgetStatus?.room_compute.reserved_vcpu_hours ?? 0)} reserved of{" "}
          {budgetStatus?.room_compute.limit_vcpu_hours_per_day ?? "unlimited"} vCPU-hours/day
        </p>
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
                  <li data-testid={`compute-usage-${agent.participant_id}`}>
                    Sandbox CPU: {formatCpuHours(agent.compute.used_vcpu_hours)} used,{" "}
                    {formatCpuHours(agent.compute.reserved_vcpu_hours)} reserved of{" "}
                    {agent.compute.limit_vcpu_hours_per_day ?? "unlimited"} vCPU-hours/day
                  </li>
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
