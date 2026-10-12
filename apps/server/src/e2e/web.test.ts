import { describe, it } from "vitest";
import {
  registerWebCollaborationStart,
  registerWebDecisionsAndInbox,
  registerWebOwnerRoleChanges,
  registerWebTaskReview,
} from "./web-collaboration.js";
import { registerWebEditorTests } from "./web-editor.js";
import { registerWebFixture } from "./web-fixture.js";
import { registerWebDemoFlow } from "./web-demo-flow.js";
import { registerWebWorkspaceTests } from "./web-workspace.js";

const fixture = registerWebFixture();

describe.skipIf(!fixture.executablePath && !fixture.inCi)("web app in a browser", () => {
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
