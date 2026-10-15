import { useState, type ChangeEvent, type FormEvent } from "react";
import type { InstallInput } from "../installer";
import type { RunHistory } from "../teardown";

interface InstallPanelProps {
  defaults: InstallInput;
  history: RunHistory | null;
  active: boolean;
  installed: boolean;
  onInstall(input: InstallInput): Promise<void>;
}

export function InstallPanel({ defaults, history, active, installed, onInstall }: InstallPanelProps) {
  const [values, setValues] = useState<InstallInput>(defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof InstallInput) => (event: ChangeEvent<HTMLInputElement>) => setValues((old) => ({ ...old, [key]: event.target.value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try { await onInstall(values); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Install run could not start"); }
    finally { setBusy(false); }
  };

  return <section className="panel panel-wide" aria-labelledby="install-title">
    <div className="panel-kicker">MANAGER SERVICE</div>
    <div className="panel-heading">
      <div>
        <h1 id="install-title">{installed ? "Manager service status" : "Install Cloudflare Manager"}</h1>
        <p>{installed ? "The service and its redirect are managed by Deploy Commander." : "Deploy the Go service once. The published interface stays available while setup runs."}</p>
      </div>
      <span className={`status-pill ${installed ? "status-live" : "status-neutral"}`}>{installed ? "Installed" : active ? "Run in progress" : "Not installed"}</span>
    </div>
    {history && <RunSummary history={history} />}
    {!installed && <form className="install-form" onSubmit={submit}>
      <label>Backend image<input required value={values.backendImage} onChange={set("backendImage")} placeholder="ghcr.io/org/cloudflare-manager:1.0.0" /></label>
      <label>Runner image<input required value={values.runnerImage} onChange={set("runnerImage")} placeholder="ezenki/deploy-commander-runner:1.2.3" /></label>
      <label>Cloudflare OAuth client ID<input required value={values.clientId} onChange={set("clientId")} autoComplete="off" /></label>
      <label>Manager public origin<input required type="url" value={values.publicOrigin} onChange={set("publicOrigin")} placeholder="https://cf-manager.example.com" /></label>
      <label>Deploy Commander origin<input required type="url" value={values.commanderOrigin} onChange={set("commanderOrigin")} placeholder="https://commander.example.com" /></label>
      <p className="form-hint">Use HTTPS origins on the same site. Register the callback as <code>{values.publicOrigin.replace(/\/$/, "") || "https://manager.example.com"}/auth/callback</code>.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="button button-primary" disabled={active || busy} type="submit">{busy ? "Starting install…" : active ? "Install run active" : "Start installation"}</button>
    </form>}
  </section>;
}

export function RunSummary({ history }: { history: RunHistory }) {
  const { run, updates } = history;
  const status = ["Queued", "Running", "Done", "Failed"][run.status] ?? "Unknown";
  return <div className="run-summary" aria-label={`${run.action} run status`}>
    <div><span className="muted-label">Latest {run.action} run</span><strong className={`run-status run-status-${run.status}`}>{status}</strong><span className="run-id">{run.id}</span></div>
    <div className="run-messages">
      {updates.events.events.slice(-2).map((event) => <p key={`event-${event.seq}`}>{event.message}</p>)}
      {updates.logs.items.slice(-2).map((log) => <p key={`log-${log.seq}`}>{log.message}</p>)}
      {!updates.events.events.length && !updates.logs.items.length && <p>Run updates will appear here.</p>}
    </div>
  </div>;
}
