import { describe, expect, it } from "vitest";
import { consumeGitHubInstallNotice } from "./github-install-notice.js";

describe("GitHub install callback notice", () => {
  it("shows a failure message and clears the callback status from the URL", () => {
    expect(consumeGitHubInstallNotice("?github_install=failed")).toEqual({
      notice:
        "GitHub installation could not be completed. You can try connecting again from Owner controls.",
      search: "",
    });
  });

  it("uses a safe known reason and preserves unrelated query parameters", () => {
    expect(
      consumeGitHubInstallNotice(
        "?tab=integrations&github_install=failed&github_install_reason=canceled",
      ),
    ).toEqual({
      notice: "GitHub installation was canceled. You can connect GitHub again from Owner controls.",
      search: "?tab=integrations",
    });
  });

  it("does not display unrecognized reasons or alter unrelated URLs", () => {
    expect(consumeGitHubInstallNotice("?github_install=success&tab=rooms")).toEqual({
      search: "?github_install=success&tab=rooms",
    });
    expect(
      consumeGitHubInstallNotice("?github_install=failed&github_install_reason=private-error"),
    ).toMatchObject({ notice: expect.not.stringContaining("private-error"), search: "" });
  });
});
