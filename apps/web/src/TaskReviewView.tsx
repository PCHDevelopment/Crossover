import { useCallback, useEffect, useState } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";

interface EvidenceItem {
  requirement: number;
  proof: Array<{ kind: "test" | "check" | "manual"; ref: string; note?: string }>;
  sabotage?: Array<{ broke: string; failed: string }>;
}

interface ReviewTask {
  id: string;
  title: string;
  description: string;
  status: string;
  owner_id: string | null;
  reviewer_id: string | null;
  requirements: string[];
  evidence: EvidenceItem[];
  missing_evidence: number[];
  version: number;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

export default function TaskReviewView(props: {
  room: RoomClient;
  participantId: string;
  mayManageTasks: boolean;
  onEvent: (listener: (event: SdkEvent) => void) => () => void;
}) {
  const { room, participantId, mayManageTasks, onEvent } = props;
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const loadTasks = useCallback(async () => {
    const page = await room.api.tasks.list<{ tasks: ReviewTask[] }>({
      status: ["REVIEW"],
      limit: 100,
    });
    setTasks(page.response.tasks);
  }, [room]);

  useEffect(() => {
    void loadTasks().catch((error: unknown) => setNotice(message(error)));
  }, [loadTasks]);

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type.startsWith("task.")) {
          void loadTasks().catch((error: unknown) => setNotice(message(error)));
        }
      }),
    [loadTasks, onEvent],
  );

  const review = async (task: ReviewTask, verdict: "approve" | "request_changes") => {
    setBusy(`task:${task.id}`);
    setNotice(undefined);
    try {
      await room.api.tasks.review({
        task_id: task.id,
        expected_version: task.version,
        verdict,
        comments: comments[task.id] ?? "",
      });
      setComments((current) => ({ ...current, [task.id]: "" }));
      await loadTasks();
    } catch (error) {
      setNotice(message(error));
      void loadTasks().catch(() => undefined);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-label="Task review" data-testid="task-review-view">
      <h2>Tasks awaiting review</h2>
      {notice && (
        <p role="alert" className="error" data-testid="delivery-notice">
          {notice}
        </p>
      )}

      <section className="delivery-section" aria-label="Tasks awaiting review">
        <ul className="list" data-testid="review-tasks">
          {tasks.map((task) => {
            const evidence = new Map(task.evidence.map((item) => [item.requirement, item]));
            const canReview =
              task.owner_id !== participantId &&
              (mayManageTasks || task.reviewer_id === participantId);
            return (
              <li
                key={task.id}
                className="delivery-card"
                data-testid="review-task"
                data-id={task.id}
              >
                <h4>{task.title}</h4>
                {task.description && <p>{task.description}</p>}
                <ol className="task-requirements">
                  {task.requirements.map((requirement, index) => {
                    const item = evidence.get(index);
                    return (
                      <li key={index} data-testid="review-requirement">
                        <span>{requirement}</span>
                        {item ? (
                          <ul data-testid="task-evidence">
                            {item.proof.map((proof, proofIndex) => (
                              <li key={proofIndex}>
                                <strong>{proof.kind}:</strong> {proof.ref}
                                {proof.note && <span> — {proof.note}</span>}
                              </li>
                            ))}
                            {item.sabotage?.map((sabotage, sabotageIndex) => (
                              <li key={`sabotage-${sabotageIndex}`}>
                                Broke {sabotage.broke}; failed: {sabotage.failed}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="badge">Missing evidence</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p data-testid="task-missing-evidence">
                  {task.missing_evidence.length === 0
                    ? "All requirements have evidence."
                    : `Missing evidence for: ${task.missing_evidence
                        .map((index) => task.requirements[index] ?? `requirement ${index + 1}`)
                        .join("; ")}`}
                </p>
                <label>
                  Review comments
                  <textarea
                    data-testid="review-comments"
                    value={comments[task.id] ?? ""}
                    onChange={(event) =>
                      setComments((current) => ({ ...current, [task.id]: event.target.value }))
                    }
                    maxLength={10_000}
                    disabled={!canReview || busy === `task:${task.id}`}
                  />
                </label>
                {canReview ? (
                  <div className="delivery-actions">
                    <button
                      data-testid="request-task-changes"
                      disabled={busy !== undefined}
                      onClick={() => void review(task, "request_changes")}
                    >
                      Request changes
                    </button>
                    <button
                      data-testid="approve-task"
                      disabled={busy !== undefined}
                      onClick={() => void review(task, "approve")}
                    >
                      Approve
                    </button>
                  </div>
                ) : (
                  <p className="muted">
                    Only the assigned reviewer or a room manager can review this task.
                  </p>
                )}
              </li>
            );
          })}
          {tasks.length === 0 && <li className="muted">No tasks are waiting for review.</li>}
        </ul>
      </section>
    </section>
  );
}
