import type { ContractView } from "@skail-document-signing/contracts";

/** Overall state of the page, derived from the phase and from which areas still owe an answer. */
export function overallLabel(contract: ContractView | undefined): string {
  if (!contract) return "Idle";
  switch (contract.phase) {
    case "Archived":
    case "Cancelled":
    case "Expired":
    case "Failed":
      return contract.phase;
    case "Starting":
      return "Starting…";
    case "Waiting": {
      const legalDone = contract.legal.status !== "Pending";
      const financeDone = contract.finance.status !== "Pending";
      if (legalDone && !financeDone) return "Waiting for Finance";
      if (financeDone && !legalDone) return "Waiting for Legal";
      return "Waiting for both";
    }
  }
}

export function StatusBadge({ contract }: { contract: ContractView | undefined }) {
  const kind = !contract
    ? "idle"
    : contract.phase === "Failed" || contract.phase === "Cancelled" || contract.phase === "Expired"
      ? "failed"
      : contract.phase === "Archived"
        ? "done"
        : "active";
  return <span className={`badge ${kind}`}>{overallLabel(contract)}</span>;
}
