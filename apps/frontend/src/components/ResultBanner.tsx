import { Areas, type ContractView } from "@skail-document-signing/contracts";

export function ResultBanner({ contract }: { contract: ContractView }) {
  const r = contract.result;
  if (!r) return null;

  if (r.end === "Archived") {
    return (
      <p role="status" aria-label="Result" className="result done">
        <strong>Archived</strong> · reference {r.reference} · signed by{" "}
        {r.signatures.map((a) => `${Areas.label(a.area)} (${a.by})`).join(" and ")}
      </p>
    );
  }
  if (r.end === "Expired") {
    const signed = r.signatures.map((a) => `${Areas.label(a.area)} signature revoked`);
    return (
      <p role="status" aria-label="Result" className="result failed">
        <strong>Expired</strong> · no answer before the deadline
        {signed.length ? ` · ${signed.join(", ")}` : ""}
      </p>
    );
  }
  const other = r.otherArea === "Revoked" ? "signature revoked" : "request withdrawn";
  return (
    <p role="status" aria-label="Result" className="result failed">
      <strong>Cancelled</strong> · refused by {Areas.label(r.refusedBy ?? "")}
      {r.reason ? ` (${r.reason})` : ""} · the other area: {other}
    </p>
  );
}
