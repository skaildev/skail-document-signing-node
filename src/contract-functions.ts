import { Skail, SkailCommand, SkailFunction } from "@skail/runtime";
import { Areas, Events, isSignature, label, otherArea, type Signature } from "./model.js";

// Method names are PascalCase on purpose: the skail address is <workload>/<method>, and the trigger calls
// <workload>/SignContract.
export class ContractFunctions {
  /**
   * Sends the contract to Legal and Finance at the same time and waits for both signatures, in any order, until a
   * deadline. The second signature archives it, a refusal cancels it at once, and the deadline expires it. The deadline
   * is an argument, so the same code serves the demo (2 minutes) and a real contract (days).
   * The name and the parameters are the trigger contract: ["{contractId}", "{title}", {deadlineSeconds}].
   */
  @SkailFunction()
  async SignContract(contractId: string, title: string, deadlineSeconds: number): Promise<string> {
    await this.RequestSignature(contractId, title, Areas.legal);
    await this.RequestSignature(contractId, title, Areas.finance);

    // the two waits and the deadline are created once, without await, and reused below
    const legal = Skail.waitForEvent<Signature>(Events.legalSignature, contractId);
    const finance = Skail.waitForEvent<Signature>(Events.financeSignature, contractId);
    const deadline = Skail.delaySeconds(deadlineSeconds);

    // whenAny returns the value of the winner: the signature, with the area that answered, or undefined for the deadline
    const first = await Skail.whenAny([legal, finance, deadline]);
    if (!isSignature(first)) return this.ExpireContract(contractId, null);
    if (!first.signed) return this.CancelContract(contractId, first, false);

    const second = await Skail.whenAny([first.area === Areas.legal ? finance : legal, deadline]);
    if (!isSignature(second)) return this.ExpireContract(contractId, first);
    if (!second.signed) return this.CancelContract(contractId, second, true);

    return this.ArchiveContract(contractId, first, second);
  }

  // The commands are the I/O: here they only report what would happen in the signature and archive systems, to the
  // console and to the page.
  // A completed command never runs again, so a replay does not ask the areas again nor print the same line twice.

  @SkailCommand({ retryCount: 3 })
  async RequestSignature(contractId: string, title: string, area: string): Promise<void> {
    await report(contractId, `${label(area)}: signature requested for "${title}"`, `requested:${area}`);
  }

  @SkailCommand({ retryCount: 3 })
  async ArchiveContract(contractId: string, first: Signature, second: Signature): Promise<string> {
    const reference = `ARC-${contractId.slice(0, 8).toUpperCase()}`;
    await report(contractId, `archived as ${reference}, signed by ${first.by} and ${second.by}`, "end:archived");
    return `archived ${reference}`;
  }

  /** Compensation: the signature the other area already gave is revoked, or its pending request is withdrawn. */
  @SkailCommand({ retryCount: 3 })
  async CancelContract(contractId: string, refusal: Signature, otherAlreadySigned: boolean): Promise<string> {
    const other = otherArea(refusal.area);
    await report(
      contractId,
      otherAlreadySigned ? `↩ ${label(other)}: signature revoked` : `↩ ${label(other)}: request withdrawn`,
      otherAlreadySigned ? `revoked:${other}` : `withdrawn:${other}`,
    );
    await report(contractId, `cancelled: ${label(refusal.area)} refused (${refusal.reason})`, "end:cancelled");
    return "cancelled";
  }

  /** Compensation: the signature already given, if any, is revoked and the pending requests are withdrawn. */
  @SkailCommand({ retryCount: 3 })
  async ExpireContract(contractId: string, signature: Signature | null): Promise<string> {
    for (const area of [Areas.legal, Areas.finance]) {
      const revoked = signature?.area === area;
      await report(
        contractId,
        revoked ? `↩ ${label(area)}: signature revoked` : `↩ ${label(area)}: request withdrawn`,
        revoked ? `revoked:${area}` : `withdrawn:${area}`,
      );
    }
    await report(contractId, "expired: the deadline passed", "end:expired");
    return "expired";
  }
}

/**
 * Reports a step to the app, which prints it and shows it on the page. Commands run in an isolated VM, so they reach the
 * app over HTTP on a local port, whose address is in DEMO_INTERNAL_URL.
 */
async function report(contractId: string, text: string, step: string): Promise<void> {
  const response = await fetch(`${process.env.DEMO_INTERNAL_URL}/internal/timeline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: contractId, text, step }),
  });
  if (!response.ok) throw new Error(`the app answered ${response.status} to the timeline`);
}
