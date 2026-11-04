import { useState } from "react";
import type { AreaView } from "@skail-document-signing/contracts";

interface Props {
  title: "Legal" | "Finance";
  view: AreaView;
  /** The contract is still active (the buttons only make sense while it is). */
  active: boolean;
  busy: boolean;
  onDecide: (signed: boolean, signedBy: string, reason: string) => void;
}

export function AreaCard({ title, view, active, busy, onDecide }: Props) {
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const pending = view.status === "Pending";
  const canDecide = pending && active;
  const id = `${view.area}`;

  return (
    <section className="area" role="region" aria-label={title}>
      <h2>
        {title} <span className={`pill ${view.status}`}>{view.status}</span>
      </h2>
      <p className="meta">
        {view.requested ? "Signature requested" : "Not requested yet"}
        {view.by ? ` · ${view.by}` : ""}
        {view.at ? ` · ${new Date(view.at).toLocaleTimeString("en-US")}` : ""}
        {view.reason ? ` · ${view.reason}` : ""}
      </p>
      {pending ? (
        <>
          <label htmlFor={`by-${id}`}>Signed by</label>
          <input
            id={`by-${id}`}
            value={by}
            disabled={!canDecide || busy}
            onChange={(e) => setBy(e.target.value)}
            placeholder={`${title} team`}
          />
          <label htmlFor={`reason-${id}`}>Reason</label>
          <input
            id={`reason-${id}`}
            value={reason}
            disabled={!canDecide || busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder="only for a refusal"
          />
          <div className="actions">
            <button type="button" disabled={!canDecide || busy} onClick={() => onDecide(true, by, reason)}>
              Sign
            </button>
            <button
              type="button"
              className="refuse"
              disabled={!canDecide || busy}
              onClick={() => onDecide(false, by, reason)}
            >
              Refuse
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
