import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import { DEFAULT_PROTECTED_PATHS } from "@crossover/protocol";
import { IntegrationsSection, type RoomIntegration } from "./owner-controls/integrations.js";
import {
  ParticipantAccessSection,
  type AssignableRole,
} from "./owner-controls/participant-access.js";
import { RoomLifecycleSection } from "./owner-controls/room-lifecycle.js";
import {
  BudgetSection,
  BUDGET_FIELDS,
  COMPUTE_BUDGET_FIELDS,
  type BudgetForm,
  type BudgetName,
  type BudgetStatus,
  type BudgetValues,
  type ComputeBudgetForm,
  type ComputeBudgetName,
  type ComputeBudgetValues,
} from "./owner-controls/budgets.js";
import { CapabilitiesSection, type CapabilityState } from "./owner-controls/capabilities.js";
import { ApprovalsSection, type Approval } from "./owner-controls/approvals.js";
import { EgressSection } from "./owner-controls/egress.js";
import { ProtectedPathsSection } from "./owner-controls/protected-paths.js";
import type { Participant } from "./model.js";

type Settings = Record<string, unknown> | null;
type EventListener = (listener: (event: SdkEvent) => void) => () => void;

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

  // Reads can finish out of order: one started by an event can answer after the user's refresh
  // (T1556). Only the answer to the newest read is shown, and only the newest read ends "loading",
  // or the refresh button would re-enable while a read is still in flight.
  const budgetReadId = useRef(0);
  const refreshBudgetStatus = useCallback(async (): Promise<BudgetStatus> => {
    const readId = ++budgetReadId.current;
    try {
      const result = await room.api.budgets.get<BudgetStatus>({});
      if (readId === budgetReadId.current) setBudgetStatus(result.response);
      return result.response;
    } finally {
      if (readId === budgetReadId.current) setBudgetLoading(false);
    }
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
    const read = refreshBudgetStatus();
    const readId = budgetReadId.current;
    try {
      const status = await read;
      if (readId !== budgetReadId.current) return; // a newer read has superseded this one
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
      if (readId === budgetReadId.current) setBudgetLoading(false);
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
        // Through the same load as every other read, so a newer read never discards the forms'.
        void loadBudgetControls().catch((err: unknown) => setError(errorText(err)));
      }
      if (event.type === "integration.connected" || event.type === "integration.disconnected") {
        void refreshIntegrations().catch((err: unknown) => setError(errorText(err)));
      }
    });
  }, [loadBudgetControls, onEvent, refreshApprovals, refreshCapabilities, refreshIntegrations]);

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
      onGitHubPendingHandled();
      setPendingRepositories([]);
      setSelectedRepositories([]);
      await refreshIntegrations();
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

  const markRoomBudgetEdited = (name: BudgetName) => {
    roomBudgetEdits.current.add(name);
  };
  const markRoomComputeBudgetEdited = (name: ComputeBudgetName) => {
    roomComputeBudgetEdits.current.add(name);
  };
  const markAgentBudgetEdited = (name: BudgetName) => {
    agentBudgetEdits.current.add(name);
  };
  const markAgentComputeBudgetEdited = (name: ComputeBudgetName) => {
    agentComputeBudgetEdits.current.add(name);
  };
  const changeBudgetTarget = (participantId: string) => {
    budgetTargetIdRef.current = participantId;
    setBudgetTargetId(participantId);
    const target = budgetStatus?.agents.find((agent) => agent.participant_id === participantId);
    agentBudgetEdits.current.clear();
    agentComputeBudgetEdits.current.clear();
    agentBudgetEditsTarget.current = participantId;
    setAgentBudgetForm(budgetForm(target?.budgets ?? {}));
    setAgentComputeBudgetForm(computeBudgetForm(target?.compute_budgets ?? {}));
  };
  const refreshBudgetSection = () => {
    void loadBudgetControls().catch((err: unknown) => setError(errorText(err)));
  };
  const refreshApprovalSection = () => {
    void refreshApprovals().catch((err: unknown) => setError(errorText(err)));
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

      <IntegrationsSection
        busy={busy}
        githubIntegration={githubIntegration}
        githubPendingId={githubPendingId}
        pendingRepositories={pendingRepositories}
        selectedRepositories={selectedRepositories}
        pendingRepositoriesLoading={pendingRepositoriesLoading}
        setSelectedRepositories={setSelectedRepositories}
        startGitHubInstall={startGitHubInstall}
        verifyGitHub={verifyGitHub}
        disconnectGitHub={disconnectGitHub}
        connectGitHub={connectGitHub}
      />

      <RoomLifecycleSection
        roomStatus={roomStatus}
        retentionDays={retentionDays}
        archivedAt={archivedAt}
        retentionDaysInput={retentionDaysInput}
        setRetentionDaysInput={setRetentionDaysInput}
        busy={busy}
        freeze={freeze}
        resume={resume}
        archive={archive}
        unarchive={unarchive}
        submitRetention={submitRetention}
      />

      <ParticipantAccessSection
        participants={participants}
        targets={targets}
        selfId={selfId}
        leadParticipantId={leadParticipantId}
        busy={busy}
        roleTargetId={roleTargetId}
        setRoleTargetId={setRoleTargetId}
        nextRole={nextRole}
        setNextRole={setNextRole}
        changeRole={changeRole}
        remove={remove}
      />

      <BudgetSection
        busy={busy}
        budgetLoading={budgetLoading}
        budgetStatus={budgetStatus}
        roomBudgetForm={roomBudgetForm}
        setRoomBudgetForm={setRoomBudgetForm}
        roomComputeBudgetForm={roomComputeBudgetForm}
        setRoomComputeBudgetForm={setRoomComputeBudgetForm}
        budgetTargetId={budgetTargetId}
        agentBudgetForm={agentBudgetForm}
        setAgentBudgetForm={setAgentBudgetForm}
        agentComputeBudgetForm={agentComputeBudgetForm}
        setAgentComputeBudgetForm={setAgentComputeBudgetForm}
        onRoomBudgetEdit={markRoomBudgetEdited}
        onRoomComputeBudgetEdit={markRoomComputeBudgetEdited}
        onAgentBudgetEdit={markAgentBudgetEdited}
        onAgentComputeBudgetEdit={markAgentComputeBudgetEdited}
        onBudgetTargetChange={changeBudgetTarget}
        onRefresh={refreshBudgetSection}
        onSubmitRoomBudgets={submitRoomBudgets}
        onSubmitComputeBudgets={submitComputeBudgets}
        onSubmitAgentBudgets={submitAgentBudgets}
      />

      <CapabilitiesSection
        busy={busy}
        targets={targets}
        targetId={targetId}
        setTargetId={setTargetId}
        capabilityState={capabilityState}
        capability={capability}
        setCapability={setCapability}
        expiresAt={expiresAt}
        setExpiresAt={setExpiresAt}
        requiresApproval={requiresApproval}
        setRequiresApproval={setRequiresApproval}
        onGrant={grantCapability}
        onRevoke={revokeCapability}
      />

      <ApprovalsSection
        busy={busy}
        approvals={approvals}
        targets={targets}
        onRefresh={refreshApprovalSection}
        onDecide={decideApproval}
      />

      <EgressSection busy={busy} egress={egress} setEgress={setEgress} onSubmit={submitEgress} />

      <ProtectedPathsSection
        busy={busy}
        protectedPaths={protectedPaths}
        setProtectedPaths={setProtectedPaths}
        onSubmit={submitProtectedPaths}
      />
    </section>
  );
}
