import { useState, type FormEvent } from "react";
import type { RunItem } from "@ezenki/deploy-commander-installer-interface";
import type { TeardownSnapshot } from "../runHistory";

export interface TeardownPageProps {
  run: TeardownSnapshot | null;
  installRun: RunItem | null;
  starting: boolean;
  startError: string;
  reloadBlocked: boolean;
  onBack: () => void;
  onStart: () => Promise<void>;
  onReload: () => void;
}

export function TeardownPage({ run, installRun, starting, startError, reloadBlocked, onBack, onStart, onReload }: TeardownPageProps) {
  const [confirmation, setConfirmation] = useState("");
  const laterInstall = isLaterInstall(installRun, run?.run);
  const currentRun = laterInstall ? null : run;
  const active = isActive(currentRun?.run.status) || isActive(installRun?.status) || starting;
  const alreadyRemoved = currentRun?.run.status === 2 && !laterInstall;
  const canSubmit = confirmation.trim() === "cloudflare" && !active && !alreadyRemoved;
  const status = getStatusMessage(currentRun, starting, startError);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) void onStart();
  };

  return <section className="teardown-page">
    <button className="text-button teardown-back" type="button" onClick={onBack}>Back to manager</button>
    <section className="panel teardown-panel" aria-labelledby="teardown-title">
      <div className="panel-kicker">REMOVE MANAGER SERVICE</div>
      <h1 id="teardown-title">Tear down Cloudflare Manager</h1>
      <p className="teardown-intro">This removes the manager service and clears its Deploy Commander redirect. Cloudflare buckets and domains stay in your account. Application access keys may remain active and need separate revocation.</p>
      <form className="teardown-form" onSubmit={submit}>
        <label htmlFor="teardown-confirmation">Type <code>cloudflare</code> to confirm</label>
        <input id="teardown-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} />
        <button className="button button-danger" type="submit" disabled={!canSubmit}>{starting ? "Starting teardown…" : "Tear down"}</button>
      </form>
      {(status || reloadBlocked) && <div className={`teardown-message ${status?.kind ?? "teardown-message-info"}`} role="status" aria-live="polite">
        <strong>{reloadBlocked ? "Reload the manager page" : status?.title}</strong>
        {status?.message && <p>{status.message}</p>}
        {currentRun?.lastEvent?.message && <p className="teardown-event">{currentRun.lastEvent.message}</p>}
        {reloadBlocked && <button className="button button-secondary" type="button" onClick={onReload}>Reload interface</button>}
      </div>}
    </section>
  </section>;
}

function getStatusMessage(run: TeardownSnapshot | null, starting: boolean, startError: string): { kind: string; title: string; message: string } | null {
  if (startError) return { kind: "teardown-message-error", title: "Could not start teardown", message: startError };
  if (starting) return { kind: "teardown-message-info", title: "Starting teardown", message: "Deploy Commander is starting the teardown run." };
  if (!run) return null;
  switch (run.run.status) {
    case 0: return { kind: "teardown-message-info", title: "Teardown queued", message: "Deploy Commander will remove the manager service." };
    case 1: return { kind: "teardown-message-info", title: "Removing manager service", message: "Teardown is running in Deploy Commander." };
    case 2: return { kind: "teardown-message-success", title: "Teardown completed", message: "Returning to the manager installer." };
    case 3: return { kind: "teardown-message-error", title: "Teardown failed", message: "The manager is still available. Review the latest update and retry." };
    default: return { kind: "teardown-message-info", title: "Teardown status unavailable", message: "Check the run in Deploy Commander before trying again." };
  }
}

function isLaterInstall(install: RunItem | null, teardown?: RunItem): boolean {
  if (!install || !teardown || !install.queued_at || !teardown.queued_at) return false;
  const installTime = Date.parse(install.queued_at);
  const teardownTime = Date.parse(teardown.queued_at);
  return Number.isFinite(installTime) && Number.isFinite(teardownTime) && installTime > teardownTime;
}

function isActive(status: number | undefined): boolean {
  return status === 0 || status === 1;
}
