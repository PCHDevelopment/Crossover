import type { Dispatch, FormEventHandler, SetStateAction } from "react";

export const BUDGET_FIELDS = [
  { name: "commands", label: "Commands", window: "per minute", default: 120 },
  { name: "messages", label: "Messages", window: "per minute", default: 10 },
  { name: "changesets", label: "ChangeSets", window: "per hour", default: 60 },
  { name: "tool_invocations", label: "Tool invocations", window: "per hour", default: 100 },
] as const;

export const COMPUTE_BUDGET_FIELDS = [
  { name: "agent_vcpu_hours_per_day", label: "Per-agent sandbox CPU", default: 4 },
  { name: "room_vcpu_hours_per_day", label: "Room sandbox CPU", default: 40 },
] as const;

export type BudgetName = (typeof BUDGET_FIELDS)[number]["name"];
export type BudgetValues = Partial<Record<BudgetName, number | null>>;
export type BudgetForm = Record<BudgetName, { value: string; unlimited: boolean }>;
export type ComputeBudgetName = (typeof COMPUTE_BUDGET_FIELDS)[number]["name"];
export type ComputeBudgetValues = Partial<Record<ComputeBudgetName, number | null>>;
export type ComputeBudgetForm = Record<ComputeBudgetName, { value: string; unlimited: boolean }>;

export interface BudgetAgentStatus {
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

export interface BudgetStatus {
  room_budgets: BudgetValues;
  compute_budgets: ComputeBudgetValues;
  room_compute: {
    limit_vcpu_hours_per_day: number | null;
    used_vcpu_hours: number;
    reserved_vcpu_hours: number;
  };
  agents: BudgetAgentStatus[];
}

interface BudgetSectionProps {
  busy: boolean;
  budgetLoading: boolean;
  budgetStatus: BudgetStatus | undefined;
  roomBudgetForm: BudgetForm;
  setRoomBudgetForm: Dispatch<SetStateAction<BudgetForm>>;
  roomComputeBudgetForm: ComputeBudgetForm;
  setRoomComputeBudgetForm: Dispatch<SetStateAction<ComputeBudgetForm>>;
  budgetTargetId: string;
  agentBudgetForm: BudgetForm;
  setAgentBudgetForm: Dispatch<SetStateAction<BudgetForm>>;
  agentComputeBudgetForm: ComputeBudgetForm;
  setAgentComputeBudgetForm: Dispatch<SetStateAction<ComputeBudgetForm>>;
  onRoomBudgetEdit: (name: BudgetName) => void;
  onRoomComputeBudgetEdit: (name: ComputeBudgetName) => void;
  onAgentBudgetEdit: (name: BudgetName) => void;
  onAgentComputeBudgetEdit: (name: ComputeBudgetName) => void;
  onBudgetTargetChange: (participantId: string) => void;
  onRefresh: () => void;
  onSubmitRoomBudgets: FormEventHandler<HTMLFormElement>;
  onSubmitComputeBudgets: FormEventHandler<HTMLFormElement>;
  onSubmitAgentBudgets: FormEventHandler<HTMLFormElement>;
}

function formatCpuHours(hours: number): string {
  return hours.toFixed(3).replace(/\.000$/, "");
}

export function BudgetSection({
  busy,
  budgetLoading,
  budgetStatus,
  roomBudgetForm,
  setRoomBudgetForm,
  roomComputeBudgetForm,
  setRoomComputeBudgetForm,
  budgetTargetId,
  agentBudgetForm,
  setAgentBudgetForm,
  agentComputeBudgetForm,
  setAgentComputeBudgetForm,
  onRoomBudgetEdit,
  onRoomComputeBudgetEdit,
  onAgentBudgetEdit,
  onAgentComputeBudgetEdit,
  onBudgetTargetChange,
  onRefresh,
  onSubmitRoomBudgets,
  onSubmitComputeBudgets,
  onSubmitAgentBudgets,
}: BudgetSectionProps) {
  return (
    <section aria-label="Budgets">
      <h3>Agent budgets</h3>
      <p className="muted">
        Room defaults apply to each agent. Leave a value blank to inherit the room value or platform
        default; No limit removes this scope's cap, while a limit from the other scope still
        applies.
      </p>
      <button
        type="button"
        data-testid="refresh-budgets"
        disabled={busy || budgetLoading}
        onClick={onRefresh}
      >
        {budgetLoading ? "Loading budgets…" : "Refresh budget status"}
      </button>

      <form onSubmit={onSubmitRoomBudgets}>
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
                onRoomBudgetEdit(name);
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
                  onRoomBudgetEdit(name);
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

      <form onSubmit={onSubmitComputeBudgets}>
        <h4>Daily sandbox CPU limits</h4>
        <p className="muted">
          Limits count measured sandbox CPU time in vCPU-hours per UTC day. Blank uses the platform
          default; No limit removes that cap.
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
                onRoomComputeBudgetEdit(name);
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
                  onRoomComputeBudgetEdit(name);
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

      <form onSubmit={onSubmitAgentBudgets}>
        <h4>Agent overrides</h4>
        <label>
          Agent
          <select
            data-testid="budget-agent"
            value={budgetTargetId}
            disabled={busy || budgetLoading || !budgetStatus?.agents.length}
            onChange={(event) => onBudgetTargetChange(event.target.value)}
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
                    onAgentBudgetEdit(name);
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
                      onAgentBudgetEdit(name);
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
                  onAgentComputeBudgetEdit("agent_vcpu_hours_per_day");
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
                    onAgentComputeBudgetEdit("agent_vcpu_hours_per_day");
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
  );
}
