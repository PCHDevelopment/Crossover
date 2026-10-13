import { useEffect, useState, type FormEvent } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import type { Participant } from "./model.js";

interface ImportResponse {
  applied_revision: number;
  file_count: number;
  suggested_health_command: {
    command: string;
    source: string;
    reason: string;
    needs: string;
  } | null;
  upstream: { url: string; branch: string; last_synced_sha: string };
}

interface PullResponse {
  status: "UP_TO_DATE" | "APPLIED" | "HELD" | "CONFLICT";
  applied_revision?: number;
  parts?: number;
  applied_parts?: number;
  upstream: { url: string; branch: string; last_synced_sha: string };
}

interface InviteResponse {
  invite_id: string;
  role: InviteRole;
  expires_at: string;
}

type InviteRole = "DEVELOPER" | "REVIEWER" | "OBSERVER";
type EventListener = (listener: (event: SdkEvent) => void) => () => void;

export function RoomSetupView(props: {
  room: RoomClient;
  roomId: string;
  participants: Participant[];
  leadParticipantId: string | null;
  mayImport: boolean;
  mayInvite: boolean;
  mayAppointLead: boolean;
  maySetHealth: boolean;
  settings: Record<string, unknown> | null;
  onEvent: EventListener;
}) {
  const {
    room,
    roomId,
    participants,
    leadParticipantId,
    mayImport,
    mayInvite,
    mayAppointLead,
    maySetHealth,
    settings,
    onEvent,
  } = props;
  const configuredHealthCommand =
    typeof settings?.health_command === "string" ? settings.health_command : "";
  const configuredHealthImage =
    typeof settings?.health_image === "string" ? settings.health_image : "";
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [importBusy, setImportBusy] = useState(false);
  const [importStatus, setImportStatus] = useState<string>();
  const [importError, setImportError] = useState<string>();
  const [imported, setImported] = useState<ImportResponse>();
  const [pullBusy, setPullBusy] = useState(false);
  const [pullStatus, setPullStatus] = useState<string>();
  const [pullError, setPullError] = useState<string>();
  const [inviteRole, setInviteRole] = useState<InviteRole>("DEVELOPER");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string>();
  const [inviteToken, setInviteToken] = useState<string>();
  const [inviteExpiresAt, setInviteExpiresAt] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [leadParticipant, setLeadParticipant] = useState("");
  const [leadBusy, setLeadBusy] = useState(false);
  const [leadNotice, setLeadNotice] = useState<string>();
  const [leadError, setLeadError] = useState<string>();
  const [healthCommand, setHealthCommand] = useState(configuredHealthCommand);
  const [healthImage, setHealthImage] = useState(configuredHealthImage);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthStatus, setHealthStatus] = useState<string>();
  const [healthError, setHealthError] = useState<string>();

  useEffect(() => {
    setHealthCommand(configuredHealthCommand);
    setHealthImage(configuredHealthImage);
  }, [configuredHealthCommand, configuredHealthImage]);

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "workspace.changeset.applied" && event.actor_id === "system:upstream") {
          setImportStatus("Repository files applied; waiting for the sync confirmation…");
        } else if (
          event.type === "workspace.upstream_synced" &&
          event.payload["imported"] === true
        ) {
          const revision = event.payload["last_synced_room_revision"];
          setImportStatus(
            typeof revision === "number"
              ? `Repository import synced at revision ${revision}.`
              : "Repository import synced.",
          );
        } else if (
          event.type === "workspace.upstream_synced" &&
          event.payload["imported"] !== true
        ) {
          const revision = event.payload["last_synced_room_revision"];
          setPullStatus(
            typeof revision === "number"
              ? `Upstream sync recorded at workspace revision ${revision}.`
              : "Upstream sync recorded.",
          );
        } else if (event.type === "room.health_settings_changed") {
          setHealthStatus("Health settings updated.");
        }
      }),
    [onEvent],
  );

  const importRepository = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setImportBusy(true);
    setImportError(undefined);
    setImported(undefined);
    setImportStatus("Fetching repository…");
    try {
      const result = await room.api.git.import<ImportResponse>({
        url: repositoryUrl.trim(),
        branch: branch.trim(),
      });
      setImported(result.response);
      setImportStatus((current) =>
        current?.startsWith("Repository import synced")
          ? current
          : `Imported ${result.response.file_count} files at revision ${result.response.applied_revision}.`,
      );
    } catch (error) {
      setImportStatus(undefined);
      setImportError(error instanceof Error ? error.message : "Repository import failed");
    } finally {
      setImportBusy(false);
    }
  };

  const pullUpstream = async () => {
    setPullBusy(true);
    setPullError(undefined);
    setPullStatus("Fetching upstream changes…");
    try {
      const result = await room.api.git.pull_upstream<PullResponse>({});
      const response = result.response;
      const sha = response.upstream.last_synced_sha.slice(0, 12);
      if (response.status === "UP_TO_DATE") {
        setPullStatus(`Upstream is already up to date at ${response.upstream.branch}@${sha}.`);
      } else if (response.status === "APPLIED") {
        setPullStatus(
          `Upstream changes applied at workspace revision ${response.applied_revision}.`,
        );
      } else if (response.status === "HELD") {
        setPullStatus(
          `Upstream pull held after ${response.applied_parts}/${response.parts} part(s).`,
        );
      } else {
        setPullStatus(
          `Upstream pull conflicted after ${response.applied_parts}/${response.parts} part(s); resolve the conflict before pulling again.`,
        );
      }
    } catch (error) {
      setPullStatus(undefined);
      setPullError(error instanceof Error ? error.message : "Upstream pull failed");
    } finally {
      setPullBusy(false);
    }
  };

  const createInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviteBusy(true);
    setInviteError(undefined);
    setInviteToken(undefined);
    setInviteExpiresAt(undefined);
    setCopied(false);
    try {
      const result = await room.api.room.invite<InviteResponse>({ role: inviteRole });
      const token = (result.one_time as { token?: unknown } | undefined)?.token;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error(
          "The one-time invite token is unavailable. Create another invite; tokens cannot be retrieved later.",
        );
      }
      setInviteToken(token);
      setInviteExpiresAt(result.response.expires_at);
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "Invite creation failed");
    } finally {
      setInviteBusy(false);
    }
  };

  const useSuggestedHealthCommand = async () => {
    const command = imported?.suggested_health_command?.command;
    if (!maySetHealth || !command) return;
    if (!window.confirm(`Use this command for room health checks?\n\n${command}`)) return;
    setHealthBusy(true);
    setHealthError(undefined);
    setHealthStatus(undefined);
    try {
      await room.api.room.set_health({ health_command: command });
      setHealthCommand(command);
      setHealthStatus("Health command configured.");
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : "Health command could not be saved");
    } finally {
      setHealthBusy(false);
    }
  };

  const saveHealthSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!maySetHealth) return;
    if (!window.confirm("Save the room health settings?")) return;
    setHealthBusy(true);
    setHealthError(undefined);
    setHealthStatus(undefined);
    try {
      await room.api.room.set_health({
        health_command: healthCommand.trim() || null,
        health_image: healthImage.trim() || null,
      });
      setHealthStatus("Health settings saved.");
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : "Health settings could not be saved");
    } finally {
      setHealthBusy(false);
    }
  };

  const clearHealthCommand = async () => {
    if (!maySetHealth || !window.confirm("Clear the room health command?")) return;
    setHealthBusy(true);
    setHealthError(undefined);
    setHealthStatus(undefined);
    try {
      await room.api.room.set_health({ health_command: null });
      setHealthCommand("");
      setHealthStatus("Health command cleared.");
    } catch (error) {
      setHealthError(
        error instanceof Error ? error.message : "Health command could not be cleared",
      );
    } finally {
      setHealthBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!inviteToken) return;
    try {
      await navigator.clipboard.writeText(inviteToken);
      setCopied(true);
      setInviteError(undefined);
    } catch {
      setCopied(false);
      setInviteError("Clipboard access failed. Select and copy the token manually.");
    }
  };

  const hideInvite = () => {
    setInviteToken(undefined);
    setInviteExpiresAt(undefined);
    setCopied(false);
  };

  const appointLead = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!leadParticipant) return;
    setLeadBusy(true);
    setLeadError(undefined);
    setLeadNotice(undefined);
    try {
      await room.api.room.set_lead({ participant_id: leadParticipant });
      const selected = participants.find((participant) => participant.id === leadParticipant);
      setLeadNotice(`${selected?.display_name ?? "Participant"} is now the lead.`);
      setLeadParticipant("");
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Lead appointment failed");
    } finally {
      setLeadBusy(false);
    }
  };

  const candidates = participants.filter(
    (participant) => participant.status === "ACTIVE" && participant.id !== leadParticipantId,
  );
  const cliJoinExample = `read -r -s -p "Invite token: " CROSSOVER_INVITE_TOKEN
printf '\\n' >&2
printf '%s\\n' "$CROSSOVER_INVITE_TOKEN" | room join ${roomId} --invite-token-stdin --manifest agent.json
unset CROSSOVER_INVITE_TOKEN`;
  const typescriptJoinExample = `const token = process.env.CROSSOVER_INVITE_TOKEN;
if (!token) throw new Error("CROSSOVER_INVITE_TOKEN is required");
const joined = await client.join("${roomId}", { token, manifest });`;
  const pythonJoinExample = `joined = await client.join(
    "${roomId}", token=os.environ["CROSSOVER_INVITE_TOKEN"], manifest=manifest
)`;
  const mcpAccessTokenPlaceholder = "${CROSSOVER_ROOM_ACCESS_TOKEN}";
  const mcpConfigExample = `{
  "mcpServers": {
    "crossover": {
      "url": "${window.location.origin}/mcp",
      "headers": {
        "Authorization": "Bearer ${mcpAccessTokenPlaceholder}"
      }
    }
  }
}`;

  return (
    <section aria-label="Project setup" data-testid="project-setup">
      <h2>Project setup</h2>
      {mayImport && (
        <section className="delivery-section" aria-label="Repository import">
          <h3>Import a repository</h3>
          <p className="muted">
            Import a public GitHub repository into this room’s empty workspace.
          </p>
          <form onSubmit={(event) => void importRepository(event)}>
            <label>
              Repository HTTPS URL
              <input
                data-testid="import-url"
                type="url"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repository"
                required
              />
            </label>
            <label>
              Branch
              <input
                data-testid="import-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                maxLength={200}
                required
              />
            </label>
            <button data-testid="import-submit" disabled={importBusy}>
              {importBusy ? "Importing…" : "Import repository"}
            </button>
          </form>
          {importStatus && (
            <p role="status" aria-live="polite" data-testid="import-status">
              {importStatus}
            </p>
          )}
          {importError && (
            <p role="alert" className="error" data-testid="import-error">
              {importError}
            </p>
          )}
          {imported?.suggested_health_command && (
            <div data-testid="health-command-suggestion">
              <p>
                Suggested health command (not applied):{" "}
                <code>{imported.suggested_health_command.command}</code>
                <span className="muted"> — {imported.suggested_health_command.reason}</span>
              </p>
              {maySetHealth && (
                <button
                  type="button"
                  data-testid="health-use-suggestion"
                  disabled={healthBusy}
                  onClick={() => void useSuggestedHealthCommand()}
                >
                  Use this command
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {mayImport && (
        <section className="delivery-section" aria-label="Upstream updates">
          <h3>Upstream updates</h3>
          <p className="muted">
            After importing a repository, pull its latest changes into this room’s workspace.
          </p>
          <button
            type="button"
            data-testid="upstream-pull"
            disabled={pullBusy || importBusy}
            onClick={() => void pullUpstream()}
          >
            {pullBusy ? "Pulling…" : "Pull upstream"}
          </button>
          {pullStatus && (
            <p role="status" aria-live="polite" data-testid="upstream-pull-status">
              {pullStatus}
            </p>
          )}
          {pullError && (
            <p role="alert" className="error" data-testid="upstream-pull-error">
              {pullError}
            </p>
          )}
        </section>
      )}

      {maySetHealth && (
        <section className="delivery-section" aria-label="Health check settings">
          <h3>Health check settings</h3>
          <p className="muted">
            Health checks run in an isolated container. Leave the image blank to use the server
            default; a chosen image must be approved by the operator.
          </p>
          <form onSubmit={(event) => void saveHealthSettings(event)}>
            <label>
              Health command
              <input
                data-testid="health-command"
                value={healthCommand}
                onChange={(event) => setHealthCommand(event.target.value)}
                maxLength={4096}
                placeholder="No health command configured"
              />
            </label>
            <label>
              Health image
              <input
                data-testid="health-image"
                value={healthImage}
                onChange={(event) => setHealthImage(event.target.value)}
                maxLength={255}
                placeholder="Server default"
              />
            </label>
            <button data-testid="health-save" disabled={healthBusy}>
              {healthBusy ? "Saving…" : "Save health settings"}
            </button>
            <button
              type="button"
              data-testid="health-clear"
              disabled={healthBusy || !configuredHealthCommand}
              onClick={() => void clearHealthCommand()}
            >
              Clear health command
            </button>
          </form>
          {healthStatus && (
            <p role="status" aria-live="polite" data-testid="health-settings-status">
              {healthStatus}
            </p>
          )}
          {healthError && (
            <p role="alert" className="error" data-testid="health-settings-error">
              {healthError}
            </p>
          )}
        </section>
      )}

      {mayInvite && (
        <section className="delivery-section" aria-label="Invitations">
          <h3>Invite a human or agent</h3>
          <p className="muted">The one-time token can be used once with the selected room role.</p>
          <form onSubmit={(event) => void createInvite(event)}>
            <label>
              Room role
              <select
                data-testid="invite-role"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as InviteRole)}
              >
                <option value="DEVELOPER">Developer</option>
                <option value="REVIEWER">Reviewer</option>
                <option value="OBSERVER">Observer</option>
              </select>
            </label>
            <button data-testid="invite-create" disabled={inviteBusy}>
              {inviteBusy ? "Creating invite…" : "Create invite"}
            </button>
          </form>
          {inviteToken && (
            <div className="delivery-card" data-testid="invite-once">
              <label>
                One-time invite token
                <input data-testid="invite-token" value={inviteToken} readOnly />
              </label>
              {inviteExpiresAt && (
                <p className="muted">Expires {new Date(inviteExpiresAt).toLocaleString()}.</p>
              )}
              <div className="delivery-actions">
                <button data-testid="invite-copy" type="button" onClick={() => void copyInvite()}>
                  {copied ? "Copied" : "Copy token"}
                </button>
                <button data-testid="invite-hide" type="button" onClick={hideInvite}>
                  Hide token
                </button>
              </div>
              <p className="muted">
                It is not recorded in Activity and will disappear when you leave Setup.
              </p>
              <details data-testid="invite-join-examples">
                <summary>Join examples</summary>
                <p className="muted">
                  The CLI or SDK consumes the invite token. MCP connects afterward with the room
                  access token returned by joining. That token lasts one hour; use the CLI’s stored
                  room credentials or refresh it instead of pasting a static token into MCP config.
                </p>
                <h4>Go CLI</h4>
                <pre>{cliJoinExample}</pre>
                <h4>TypeScript SDK</h4>
                <pre>{typescriptJoinExample}</pre>
                <h4>Python SDK</h4>
                <pre>{pythonJoinExample}</pre>
                <h4>MCP client</h4>
                <pre>{mcpConfigExample}</pre>
              </details>
            </div>
          )}
          {inviteError && (
            <p role="alert" className="error" data-testid="invite-error">
              {inviteError}
            </p>
          )}
        </section>
      )}

      {mayAppointLead && (
        <section className="delivery-section" aria-label="Lead appointment">
          <h3>Appoint a lead</h3>
          <p className="muted">
            The selected active participant becomes the room’s lead immediately.
          </p>
          <form onSubmit={(event) => void appointLead(event)}>
            <label>
              Active participant
              <select
                data-testid="lead-participant"
                value={leadParticipant}
                onChange={(event) => setLeadParticipant(event.target.value)}
                required
              >
                <option value="" disabled>
                  Select a participant
                </option>
                {candidates.map((participant) => (
                  <option key={participant.id} value={participant.id}>
                    {participant.display_name}
                  </option>
                ))}
              </select>
            </label>
            <button data-testid="appoint-lead" disabled={leadBusy || candidates.length === 0}>
              {leadBusy ? "Appointing…" : "Appoint lead"}
            </button>
          </form>
          {leadNotice && (
            <p role="status" data-testid="lead-status">
              {leadNotice}
            </p>
          )}
          {leadError && (
            <p role="alert" className="error" data-testid="lead-error">
              {leadError}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
