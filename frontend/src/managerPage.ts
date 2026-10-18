export type ManagerPage = "home" | "teardown";

export function managerPageFromPath(pathname: string): ManagerPage {
  return /^\/teardown\/?$/.test(pathname) ? "teardown" : "home";
}

export function navigateManagerPage(page: ManagerPage, mode: "push" | "replace" = "push"): void {
  const pathname = page === "teardown" ? "/teardown" : "/";
  const url = `${pathname}${window.location.search}${window.location.hash}`;
  if (mode === "replace") window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}
