import { useEffect, useState } from "react";
import type { ContractView } from "@skail-document-signing/contracts";

/** Visual countdown only: the real deadline is the durable delay inside the skail function. */
export function Countdown({ contract }: { contract: ContractView | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!contract || contract.phase !== "Waiting" || !contract.startedAt) return null;
  const left = Math.max(0, contract.deadlineSeconds - (now - new Date(contract.startedAt).getTime()) / 1000);
  return <span className="countdown">deadline in {Math.ceil(left)}s</span>;
}
