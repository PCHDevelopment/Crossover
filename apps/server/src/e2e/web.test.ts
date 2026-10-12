import { describe } from "vitest";
import {
  registerWebCollaborationStart,
  registerWebDecisionsAndInbox,
  registerWebOwnerRoleChanges,
  registerWebTaskReview,
} from "./web-collaboration.js";
import { registerWebEditorTests } from "./web-editor.js";
import { registerWebFixture } from "./web-fixture.js";
import { registerWebWorkspaceTests } from "./web-workspace.js";

const fixture = registerWebFixture();

describe.skipIf(!fixture.executablePath && !fixture.inCi)("web app in a browser", () => {
  registerWebCollaborationStart(fixture);
  registerWebOwnerRoleChanges(fixture);
  registerWebTaskReview(fixture);
  registerWebEditorTests(fixture);
  registerWebWorkspaceTests(fixture);
  registerWebDecisionsAndInbox(fixture);
});
