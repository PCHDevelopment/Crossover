import type { Dispatch, FormEventHandler, SetStateAction } from "react";
import type { Participant } from "../model.js";

export type AssignableRole = Exclude<Participant["role"], "LEAD">;
export const ASSIGNABLE_ROLES: readonly AssignableRole[] = ["DEVELOPER", "REVIEWER", "OBSERVER"];

export function ParticipantAccessSection({
  participants,
  targets,
  selfId,
  leadParticipantId,
  busy,
  roleTargetId,
  setRoleTargetId,
  nextRole,
  setNextRole,
  changeRole,
  remove,
}: {
  participants: Participant[];
  targets: Participant[];
  selfId: string;
  leadParticipantId: string | null;
  busy: boolean;
  roleTargetId: string;
  setRoleTargetId: Dispatch<SetStateAction<string>>;
  nextRole: AssignableRole;
  setNextRole: Dispatch<SetStateAction<AssignableRole>>;
  changeRole: FormEventHandler<HTMLFormElement>;
  remove: (participant: Participant) => void;
}) {
  return (
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
  );
}
