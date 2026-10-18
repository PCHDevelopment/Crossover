import { describe, it } from "vitest";
import { registerWebCollaborationStart } from "./web-collaboration-start.js";
import { registerWebDecisionsAndInbox } from "./web-decisions-inbox.js";
import { registerWebOwnerRoleChanges } from "./web-owner-roles.js";
import { registerWebTaskReview } from "./web-task-review.js";
import { registerWebEditorTests } from "./web-editor.js";
import { registerWebFixture } from "./web-fixture.js";
import { registerWebAuthTests } from "./web-auth.js";
import { registerWebDemoFlow } from "./web-demo-flow.js";
import { registerWebWorkspaceTests } from "./web-workspace.js";

const fixture = registerWebFixture();

describe.skipIf(!fixture.executablePath && !fixture.inCi)("web app in a browser", () => {
  registerWebAuthTests(fixture);
  it("T1406 harness: rejects an invalid token through the real Git listener bridge", async () => {
    await fixture.assertBadGitTokenRejected();
  });
  registerWebCollaborationStart(fixture);
  registerWebOwnerRoleChanges(fixture);
  registerWebTaskReview(fixture);
  registerWebEditorTests(fixture);
  registerWebWorkspaceTests(fixture);
  registerWebDecisionsAndInbox(fixture);
  registerWebDemoFlow(fixture);
});
