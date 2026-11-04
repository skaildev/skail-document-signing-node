import { Areas, ContractEvent, ContractResult, type Signature } from "@skail-document-signing/contracts";
import type { ProgressNotifier } from "./web.js";

/**
 * The I/O behind the commands, as plain async methods. The command wrappers only delegate here, so the logic is
 * unit tested without the skail runtime. The web app plays the legal and finance inboxes: delivering a request is
 * the event it receives, and if it cannot be delivered the method throws and skail retries the command.
 */
export class ContractOperations {
  constructor(private readonly notifier: ProgressNotifier) {}

  /** Idempotent: the web app records one request per contract and area. */
  async requestSignature(contractId: string, title: string, area: string): Promise<void> {
    if (!Areas.isValid(area)) throw new Error(`unknown area '${area}'`);
    await this.notifier.notify(ContractEvent.signatureRequested(contractId, title, area));
  }

  /** Idempotent: the result derives from the arguments, and the web app ignores a repeated stage. */
  async archive(contractId: string, first: Signature, second: Signature): Promise<ContractResult> {
    if (!first.signed || !second.signed) throw new Error("only a contract with both signatures can be archived");
    const result = ContractResult.archived(contractId, first, second);
    await this.notifier.notify(ContractEvent.archived(contractId, result));
    return result;
  }

  /** Compensation: a signature already given is revoked, a request still pending is withdrawn. Idempotent. */
  async cancel(contractId: string, refusal: Signature, otherAlreadySigned: boolean): Promise<ContractResult> {
    if (refusal.signed) throw new Error("only a refusal cancels the contract");
    const result = ContractResult.cancelled(contractId, refusal, otherAlreadySigned);
    await this.notifier.notify(ContractEvent.cancelled(contractId, result));
    return result;
  }

  /** Compensation when the deadline passes. Idempotent for the same reasons as cancel. */
  async expire(contractId: string, signature: Signature | null): Promise<ContractResult> {
    if (signature && !signature.signed) throw new Error("a refusal cancels the contract; it does not expire it");
    const result = ContractResult.expired(contractId, signature);
    await this.notifier.notify(ContractEvent.expired(contractId, result));
    return result;
  }

  reportStatus(evt: ContractEvent): Promise<void> {
    return this.notifier.notify(evt);
  }
}
