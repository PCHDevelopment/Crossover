/** Read the GitHub install callback status and remove its one-time query state. */
export function consumeGitHubInstallNotice(search: string): {
  notice?: string;
  search: string;
} {
  const params = new URLSearchParams(search);
  if (params.get("github_install") !== "failed") return { search };

  const reason = params.get("github_install_reason");
  const notice =
    reason === "canceled" || reason === "access_denied"
      ? "GitHub installation was canceled. You can connect GitHub again from Owner controls."
      : reason === "unavailable"
        ? "Crossover could not finish connecting GitHub. Please try again."
        : "GitHub installation could not be completed. You can try connecting again from Owner controls.";
  params.delete("github_install");
  params.delete("github_install_reason");
  const remaining = params.toString();
  return { notice, search: remaining ? `?${remaining}` : "" };
}
