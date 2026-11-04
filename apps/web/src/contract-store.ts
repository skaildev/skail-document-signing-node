import {
  Areas,
  isTerminalPhase,
  otherArea,
  type Signature,
  type AreaView,
  type ContractEvent,
  type ContractResult,
  type ContractState,
} from "@skail-document-signing/contracts";

export type DecisionOutcome = "Accepted" | "Duplicate" | "Finished" | "NotFound";

interface Subscriber {
  onState: (state: ContractState) => void;
  onClose: () => void;
}

const newArea = (area: string): AreaView => ({
  area,
  status: "Pending",
  requested: false,
  by: null,
  reason: null,
  at: null,
});

const withArea = (c: ContractState, area: string, change: (a: AreaView) => AreaView): ContractState =>
  area === Areas.legal ? { ...c, legal: change(c.legal) } : { ...c, finance: change(c.finance) };

const areaOf = (c: ContractState, area: string): AreaView => (area === Areas.legal ? c.legal : c.finance);

/**
 * In-memory state of the contracts. The durable state lives in skail; this is only the UI view and the
 * "one decision per area" guard. Decisions are registered here when the click arrives (before the fire),
 * and the final result comes from the worker.
 */
export class ContractStore {
  readonly #contracts = new Map<string, ContractState>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  create(contractId: string, title: string, deadlineSeconds: number): ContractState {
    const contract: ContractState = {
      contractId,
      title,
      deadlineSeconds,
      startedAt: null,
      phase: "Starting",
      legal: newArea(Areas.legal),
      finance: newArea(Areas.finance),
      timeline: [],
      result: null,
      error: null,
    };
    this.#contracts.set(contractId, contract);
    return contract;
  }

  get(contractId: string): ContractState | undefined {
    return this.#contracts.get(contractId);
  }

  remove(contractId: string): void {
    this.#contracts.delete(contractId);
    this.#close(contractId);
  }

  /** The first decision of an area wins; a second one, or one after the end, is refused so no second event is fired. */
  tryDecide(contractId: string, a: Signature): DecisionOutcome {
    const contract = this.#contracts.get(contractId);
    if (!contract) return "NotFound";
    if (isTerminalPhase(contract.phase)) return "Finished";
    if (areaOf(contract, a.area).status !== "Pending") return "Duplicate";

    const reason = a.signed || !a.reason?.trim() ? "" : `: ${a.reason}`;
    const next = withArea(contract, a.area, (v) => ({
      ...v,
      status: a.signed ? "Signed" : "Refused",
      by: a.by,
      reason: a.reason,
      at: a.at,
    }));
    this.#publish(
      this.#add(
        next,
        a.signed ? "Signed" : "Refused",
        a.area,
        `${Areas.label(a.area)} ${a.signed ? "signed" : "refused"} (${a.by})${reason}`,
      ),
    );
    return "Accepted";
  }

  /** Undoes tryDecide when the fire failed, so the same area can try again. */
  release(contractId: string, area: string): void {
    const contract = this.#contracts.get(contractId);
    if (!contract || isTerminalPhase(contract.phase)) return;
    const current = areaOf(contract, area);
    if (current.status !== "Signed" && current.status !== "Refused") return;

    const timeline = [...contract.timeline];
    const last = timeline
      .map((t) => t.area === area && (t.kind === "Signed" || t.kind === "Refused"))
      .lastIndexOf(true);
    if (last >= 0) timeline.splice(last, 1);
    this.#publish(
      withArea({ ...contract, timeline }, area, () => ({ ...newArea(area), requested: current.requested })),
    );
  }

  /** @returns true when the event changed the contract; false when ignored (unknown or finished contract, duplicate). */
  apply(event: ContractEvent): boolean {
    const contract = this.#contracts.get(event.contractId);
    if (!contract || isTerminalPhase(contract.phase)) return false;

    let next: ContractState | null = null;
    switch (event.stage) {
      case "Started":
        if (contract.phase === "Starting")
          next = this.#add(
            { ...contract, phase: "Waiting", startedAt: this.now() },
            "Started",
            null,
            `Sent for signature to Legal and Finance (deadline ${contract.deadlineSeconds}s)`,
          );
        break;
      case "SignatureRequested":
        if (Areas.isValid(event.area) && !areaOf(contract, event.area).requested) {
          next = this.#add(
            withArea(contract, event.area, (a) => ({ ...a, requested: true })),
            "Requested",
            event.area,
            `Signature requested from ${Areas.label(event.area)}`,
          );
        }
        break;
      case "Archived":
        if (event.result)
          next = this.#add(
            { ...contract, phase: "Archived", result: event.result },
            "Archived",
            null,
            `Contract archived (${event.result.reference})`,
          );
        break;
      case "Cancelled":
        if (event.result) next = this.#cancel(contract, event.result);
        break;
      case "Expired":
        if (event.result) next = this.#expire(contract, event.result);
        break;
      case "Failed": {
        const error = event.error ?? "unknown error";
        next = this.#add({ ...contract, phase: "Failed", error }, "Failed", null, error);
        break;
      }
    }
    if (!next) return false;
    this.#publish(next);
    return true;
  }

  /** @returns the unsubscribe function. `onClose` is called when the contract ends or is removed. */
  subscribe(contractId: string, onState: (state: ContractState) => void, onClose: () => void): () => void {
    const subscriber: Subscriber = { onState, onClose };
    let set = this.#subscribers.get(contractId);
    if (!set) this.#subscribers.set(contractId, (set = new Set()));
    set.add(subscriber);
    return () => void this.#subscribers.get(contractId)?.delete(subscriber);
  }

  #cancel(contract: ContractState, r: ContractResult): ContractState {
    let next: ContractState = { ...contract, phase: "Cancelled", result: r };
    if (r.refusedBy && Areas.isValid(r.refusedBy) && r.otherArea) {
      // the area that did not refuse: its signature is revoked or its pending request withdrawn
      const outcome = r.otherArea;
      next = withArea(next, otherArea(r.refusedBy), (a) => ({ ...a, status: outcome }));
    }
    const reason = r.reason?.trim() ? ` (${r.reason})` : "";
    return this.#add(next, "Cancelled", null, `Contract cancelled: ${Areas.label(r.refusedBy ?? "")} refused${reason}`);
  }

  #expire(contract: ContractState, r: ContractResult): ContractState {
    // the area that signed has its signature revoked; the areas that did not answer have their requests withdrawn
    const signed = new Set(r.signatures.map((s) => s.area));
    let next: ContractState = { ...contract, phase: "Expired", result: r };
    for (const area of [Areas.legal, Areas.finance]) {
      next = withArea(next, area, (a) => ({ ...a, status: signed.has(area) ? "Revoked" : "Withdrawn" }));
    }
    const missing = [Areas.legal, Areas.finance].filter((area) => !signed.has(area)).map(Areas.label);
    return this.#add(next, "Expired", null, `Contract expired: ${missing.join(" and ")} did not answer in time`);
  }

  #add(contract: ContractState, kind: string, area: string | null, text: string): ContractState {
    return { ...contract, timeline: [...contract.timeline, { kind, area, text, at: this.now() }] };
  }

  #publish(state: ContractState): void {
    this.#contracts.set(state.contractId, state);
    for (const subscriber of [...(this.#subscribers.get(state.contractId) ?? [])]) subscriber.onState(state);
    if (isTerminalPhase(state.phase)) this.#close(state.contractId);
  }

  #close(contractId: string): void {
    const set = this.#subscribers.get(contractId);
    if (!set) return;
    this.#subscribers.delete(contractId);
    for (const subscriber of set) subscriber.onClose();
  }
}
