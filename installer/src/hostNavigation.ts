export type HostAction = "install" | "teardown";

export function reloadCommanderHost(
  managerId: string,
  action: HostAction,
  runId: string,
  reload: () => void = () => window.parent.location.reload(),
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
    try { reload(); return true; } catch { return false; }
  }
}
