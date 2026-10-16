import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import type { RunItem } from "@ezenki/deploy-commander-installer-interface";
import { installationState, startInstall, type InstallInput, type InstallationState } from "./installer";
import type { CommanderBridge } from "./commander";

interface InstallAppProps {
  bridge: CommanderBridge;
  defaults: InstallInput;
}

export function InstallApp({ bridge, defaults }: InstallAppProps) {
  const { caller } = bridge;
  const [values, setValues] = useState(defaults);
  const [state, setState] = useState<InstallationState>("ready");
  const [installRun, setInstallRun] = useState<RunItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [install, teardown] = await Promise.all([
      caller.getLatestRun({ action: "install" }),
      caller.getLatestRun({ action: "teardown" }),
    ]);
    setInstallRun(install);
    setState(installationState(install, teardown));
  }, [caller]);

  useEffect(() => {
    let alive = true;
    void refresh().catch((cause) => { if (alive) setError(message(cause)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; bridge.wire.end(); };
  }, [bridge, refresh]);

  const set = (key: keyof InstallInput) => (event: ChangeEvent<HTMLInputElement>) => setValues((old) => ({ ...old, [key]: event.target.value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const started = await startInstall(caller, values);
      setInstallRun({ action: "install", status: started.status, id: started.id, queued_at: started.queued_at, created_at: started.queued_at, updated_at: started.queued_at });
      setState("installing");
      await refresh();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };

  return <main className="install-shell">
    <header className="brand"><span className="brand-mark">C</span><span>Cloudflare Manager<small>Deploy Commander installer</small></span></header>
    <section className="hero"><div className="eyebrow">OBJECT STORAGE · EDGE DELIVERY</div><h1>Install Cloudflare Manager</h1><p>Deploy the manager service once. After it is healthy, Deploy Commander opens the management interface.</p></section>
    <section className="panel" aria-labelledby="install-title">
      <div className="panel-heading"><div><h2 id="install-title">Manager service</h2><p>Confirm the service, runner, and OAuth configuration before installation.</p></div><span className={`status-pill status-${state}`}>{loading ? "Loading status" : stateLabel(state)}</span></div>
      {installRun && <div className="run-summary" aria-label="install run status"><strong>{statusLabel(installRun.status)}</strong><span>Run {installRun.id}</span><p>Run events will appear here.</p></div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <form className="install-form" onSubmit={(event) => void submit(event)}>
        <label>Backend image<input required value={values.backendImage} onChange={set("backendImage")} placeholder="ezenki/cloudflare-manager:latest" /></label>
        <label>Runner image<input required value={values.runnerImage} onChange={set("runnerImage")} placeholder="ezenki/deploy-commander-runner:1.2.3" /></label>
        <label>Cloudflare OAuth client ID<input required value={values.clientId} onChange={set("clientId")} autoComplete="off" /></label>
        <label>Manager public origin<input required type="url" value={values.publicOrigin} onChange={set("publicOrigin")} placeholder="https://cf-manager.example.com" /></label>
        <label>Deploy Commander origin<input required type="url" value={values.commanderOrigin} onChange={set("commanderOrigin")} placeholder="https://commander.example.com" /></label>
        <p className="form-hint">Use HTTPS origins on the same site. Register the callback as <code>{values.publicOrigin.replace(/\/$/, "") || "https://manager.example.com"}/auth/callback</code>.</p>
        <button className="button" disabled={loading || busy || state !== "ready"} type="submit">{busy ? "Starting install…" : state === "ready" ? "Start installation" : stateLabel(state)}</button>
      </form>
    </section>
    <footer>Cloudflare Manager · Published through Deploy Commander</footer>
  </main>;
}

function stateLabel(state: InstallationState): string {
  return ({ ready: "Not installed", installing: "Install run active", installed: "Installed", "tearing-down": "Teardown active" })[state];
}

function statusLabel(status: number): string {
  return (["Queued", "Running", "Done", "Failed"][status] ?? "Unknown");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Installer request failed";
}
