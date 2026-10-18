export type HostAction = "install" | "teardown";

export function reloadCurrentInterface(
  managerId: string,
  action: HostAction,
  runId: string,
  reload: () => void = () => window.location.reload(),
): boolean {
  const key = `cloudflare-manager:host-reload:${managerId}:${action}:${runId}`;
  try {
    if (sessionStorage.getItem(key)) return true;
    sessionStorage.setItem(key, "1");
    try {
      reload();
      return true;
    } catch {
      sessionStorage.removeItem(key);
      return false;
    }
  } catch {
    return false;
  }
}
