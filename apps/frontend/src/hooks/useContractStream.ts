import { useEffect } from "react";
import { isTerminalPhase, type ContractView } from "@skail-document-signing/contracts";

/**
 * Follows a contract through SSE. EventSource reconnects by itself and the stream starts with the current
 * snapshot, so no update is lost. Closes at a terminal phase.
 */
export function useContractStream(
  contractId: string | undefined,
  onState: (contract: ContractView) => void,
  onTerminal: () => void,
) {
  useEffect(() => {
    if (!contractId) return;
    const source = new EventSource(`/api/contracts/${contractId}/stream`);
    source.onmessage = (event) => {
      const contract = JSON.parse(event.data) as ContractView;
      onState(contract);
      if (isTerminalPhase(contract.phase)) {
        source.close();
        onTerminal();
      }
    };
    return () => source.close();
    // callbacks are stable (state setters); the stream only depends on the contract id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);
}
