import { randomUUID } from "node:crypto";
import { Areas, eventFor, label, type Signature } from "./model.js";
import type { SkailApiClient } from "./skail-api.js";
import type { Timeline, TimelineEntry } from "./timeline.js";

export const TITLE = "Service agreement";
/** Time both areas have to answer: 2 minutes in the demo; a real contract would use days. */
export const DEADLINE_SECONDS = 120;

/**
 * Plays the two areas for the page: it sends the contract for signature and turns each button into the area's event.
 * It follows one contract at a time, the last one sent (or the one given on the command line).
 */
export class ContractDesk {
  private contractId: string | null = null;
  private sentAt: number | null = null;
  private readonly decisions = new Map<string, boolean>(); // area -> signed

  constructor(
    private readonly skail: SkailApiClient,
    private readonly timeline: Timeline,
  ) {}

  /** Follows a contract that already exists, to see it resume. */
  follow(id: string): void {
    this.contractId = id;
    this.sentAt = null;
    this.decisions.clear();
  }

  async send(): Promise<string> {
    const id = randomUUID();
    await this.skail.trigger(id, TITLE, DEADLINE_SECONDS);
    this.contractId = id;
    this.sentAt = Date.now();
    this.decisions.clear();
    return id;
  }

  /** Sends an area's decision. Each area answers once: the first decision wins. */
  async decide(area: string, signed: boolean): Promise<boolean> {
    const id = this.contractId;
    if (!id || (area !== Areas.legal && area !== Areas.finance) || this.decisions.has(area)) return false;
    this.decisions.set(area, signed);

    const signature: Signature = {
      area,
      signed,
      by: `${label(area)} team`,
      reason: signed ? null : "refused in the demo",
      at: new Date().toISOString(),
    };
    await this.skail.fireSignature(id, signature);
    this.timeline.add(id, `${label(area)} ${signed ? "signed" : "refused"}: ${eventFor(area)} sent`, `sent:${area}`);
    return true;
  }

  /** What the page shows: the contract, each area and the timeline of the run. */
  view(): unknown {
    const id = this.contractId;
    if (!id) return { contract: null };

    const entries = this.timeline.for(id);
    const end = [...entries].reverse().find((e) => e.step?.startsWith("end:"))?.step?.slice(4) ?? null;
    return {
      contract: {
        id,
        title: TITLE,
        deadline: this.sentAt ? new Date(this.sentAt + DEADLINE_SECONDS * 1000).toISOString() : null,
        end,
      },
      areas: [Areas.legal, Areas.finance].map((area) => ({
        area,
        label: label(area),
        status: this.areaStatus(area, entries),
        canDecide: end === null && !this.decisions.has(area),
      })),
      timeline: entries.map((e) => ({ at: e.at, text: e.text })),
    };
  }

  private areaStatus(area: string, entries: TimelineEntry[]): string {
    if (entries.some((e) => e.step === `revoked:${area}`)) return "revoked";
    if (entries.some((e) => e.step === `withdrawn:${area}`)) return "withdrawn";
    const signed = this.decisions.get(area);
    if (signed !== undefined) return signed ? "signed" : "refused";
    return "pending";
  }
}
