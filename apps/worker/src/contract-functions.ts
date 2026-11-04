import { Skail, SkailCommand, SkailFunction, SkailNonDeterministicError } from "@skail/runtime";
import {
  Areas,
  ContractEvent,
  Events,
  isSignature,
  type Signature,
  type ContractResult,
} from "@skail-document-signing/contracts";
import type { ContractOperations } from "./contract-operations.js";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The method names are PascalCase on purpose: the skail route is <workload>/<method>, and the web app triggers
// <workload>/SignContract.
export class ContractFunctions {
  constructor(private readonly operations: ContractOperations) {}

  /**
   * Sends the contract to legal and finance at the same time and waits for both signatures, in any order, until a
   * deadline. The second signature archives it, a refusal cancels it at once, and the deadline expires it. The
   * deadline is an argument, so the same code serves the demo (2 minutes) and a real contract (days).
   */
  @SkailFunction()
  async SignContract(contractId: string, title: string, deadlineSeconds: number): Promise<ContractResult> {
    try {
      await this.ReportStatus(ContractEvent.started(contractId, title));
      await this.RequestSignature(contractId, title, Areas.legal);
      await this.RequestSignature(contractId, title, Areas.finance);

      // The two waits and the deadline are created once, without await, and reused below.
      const legal = Skail.waitForEvent<Signature>(Events.legalSignature, contractId);
      const finance = Skail.waitForEvent<Signature>(Events.financeSignature, contractId);
      const deadline = Skail.delaySeconds(deadlineSeconds);

      // whenAny returns the value of the winner: the signature, with the area that answered, or undefined for
      // the deadline.
      const first = await Skail.whenAny([legal, finance, deadline]);
      if (!isSignature(first)) return await this.ExpireContract(contractId, null);
      if (!first.signed) return await this.CancelContract(contractId, first, false);

      const second = await Skail.whenAny([first.area === Areas.legal ? finance : legal, deadline]);
      if (!isSignature(second)) return await this.ExpireContract(contractId, first);
      if (!second.signed) return await this.CancelContract(contractId, second, true);

      return await this.ArchiveContract(contractId, first, second);
    } catch (error) {
      if (!(error instanceof SkailNonDeterministicError))
        await this.ReportStatus(ContractEvent.failed(contractId, errorMessage(error)));
      throw error;
    }
  }

  // The commands only delegate to ContractOperations, so their logic is tested without skail.

  @SkailCommand({ retryCount: 3 })
  async RequestSignature(contractId: string, title: string, area: string): Promise<void> {
    await this.operations.requestSignature(contractId, title, area);
  }

  /** Compensation: the signature the other area already gave is revoked, or its pending request is withdrawn. */
  @SkailCommand({ retryCount: 3 })
  async CancelContract(contractId: string, refusal: Signature, otherAlreadySigned: boolean): Promise<ContractResult> {
    return this.operations.cancel(contractId, refusal, otherAlreadySigned);
  }

  /** Compensation: the signature already given, if any, is revoked and the pending requests are withdrawn. */
  @SkailCommand({ retryCount: 3 })
  async ExpireContract(contractId: string, signature: Signature | null): Promise<ContractResult> {
    return this.operations.expire(contractId, signature);
  }

  @SkailCommand({ retryCount: 3 })
  async ArchiveContract(contractId: string, first: Signature, second: Signature): Promise<ContractResult> {
    return this.operations.archive(contractId, first, second);
  }

  /** Idempotent: the web app ignores a repeated event (same contract and stage). */
  @SkailCommand({ retryCount: 3 })
  async ReportStatus(evt: ContractEvent): Promise<void> {
    await this.operations.reportStatus(evt);
  }
}
