import { useCallback, useEffect, useState } from "react";
import { ContractLimits, isTerminalPhase, startState, type ContractView } from "@skail-document-signing/contracts";
import { decide, getConfig, getContract, startContract } from "./api";
import { AreaCard } from "./components/AreaCard";
import { ContractForm } from "./components/ContractForm";
import { Countdown } from "./components/Countdown";
import { ResultBanner } from "./components/ResultBanner";
import { StatusBadge } from "./components/StatusBadge";
import { Timeline } from "./components/Timeline";
import { useContractStream } from "./hooks/useContractStream";

const KEY = "document-signing.contractId";

export function App() {
  const [contract, setContract] = useState<ContractView | undefined>();
  const [title, setTitle] = useState<string>(ContractLimits.defaultTitle);
  const [monitorUrl, setMonitorUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = useCallback(() => localStorage.removeItem(KEY), []);
  const active = contract && !isTerminalPhase(contract.phase) ? contract.contractId : undefined;
  useContractStream(active, setContract, forget);

  useEffect(() => {
    getConfig().then(
      (config) => {
        setMonitorUrl(config.monitorUrl);
        setTitle((current) => (current === ContractLimits.defaultTitle ? config.defaultTitle : current));
      },
      () => {},
    );
  }, []);

  // reload keeps the controls right: the state always comes from the server
  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (!saved) return;
    getContract(saved).then((restored) => {
      if (!restored) return forget();
      setContract(restored);
      setTitle(restored.title);
      if (isTerminalPhase(restored.phase)) forget();
    }, forget);
  }, [forget]);

  const ui = startState(contract);

  async function onSend() {
    setBusy(true);
    setError(null);
    try {
      const started = await startContract(title);
      localStorage.setItem(KEY, started.contractId);
      setContract(started);
    } catch (e) {
      setError(`Could not start: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onDecide(area: string, signed: boolean, signedBy: string, reason: string) {
    if (!contract) return;
    setBusy(true);
    setError(null);
    try {
      setContract(
        await decide(contract.contractId, {
          area,
          signedBy: signedBy.trim(),
          signed,
          ...(signed || !reason.trim() ? {} : { reason: reason.trim() }),
        }),
      );
    } catch (e) {
      setError(`Could not send the decision: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const live = contract?.active ?? false;

  return (
    <main>
      <header>
        <h1>Document signing</h1>
        <p className="subtitle">
          A skail function sends the contract to Legal and Finance at the same time and waits for both signatures, in
          any order, until a deadline. The second signature archives it, a refusal cancels it at once, and the deadline
          expires it.
        </p>
      </header>

      <ContractForm title={title} ui={ui} busy={busy} onTitle={setTitle} onSend={onSend} />

      <section className="status">
        <StatusBadge contract={contract} />
        <Countdown contract={contract} />
        {contract && <strong>{contract.title}</strong>}
        {monitorUrl && (
          <a href={monitorUrl} target="_blank" rel="noopener noreferrer">
            Open the skail Monitor
          </a>
        )}
      </section>

      {(error ?? contract?.error) && <p className="error">{error ?? contract?.error}</p>}
      {contract && <ResultBanner contract={contract} />}

      {contract ? (
        <div className="areas">
          <AreaCard
            title="Legal"
            view={contract.legal}
            active={live}
            busy={busy}
            onDecide={(s, by, r) => onDecide("legal", s, by, r)}
          />
          <AreaCard
            title="Finance"
            view={contract.finance}
            active={live}
            busy={busy}
            onDecide={(s, by, r) => onDecide("finance", s, by, r)}
          />
        </div>
      ) : (
        <div className="areas">
          <AreaCard
            title="Legal"
            view={{ area: "legal", status: "Pending", requested: false, by: null, reason: null, at: null }}
            active={false}
            busy={false}
            onDecide={() => {}}
          />
          <AreaCard
            title="Finance"
            view={{ area: "finance", status: "Pending", requested: false, by: null, reason: null, at: null }}
            active={false}
            busy={false}
            onDecide={() => {}}
          />
        </div>
      )}

      <h2>Timeline</h2>
      <Timeline entries={contract?.timeline ?? []} />

      <footer>
        Contract <code>{contract?.contractId ?? "-"}</code>
      </footer>
    </main>
  );
}
