// Types of the demo. This file ends up inside the skail bundle: pure code only, no Node imports.

/** The two areas that sign, as plain strings: they travel in the payload of an external event. */
export const Areas = { legal: "legal", finance: "finance" } as const;
export type Area = (typeof Areas)[keyof typeof Areas];

export const label = (area: string) => (area === Areas.legal ? "Legal" : "Finance");
export const otherArea = (area: string): Area => (area === Areas.legal ? Areas.finance : Areas.legal);

/** External event names, shared by the function (waitForEvent) and the console (fire). */
export const Events = { legalSignature: "LEGAL_SIGNATURE", financeSignature: "FINANCE_SIGNATURE" } as const;
export const eventFor = (area: string) => (area === Areas.legal ? Events.legalSignature : Events.financeSignature);

/**
 * One area's answer, and the payload of its external event. It carries only what the decision needs, never the
 * contract content. `at` is stamped by whoever fires the event, since the function cannot read the clock.
 */
export interface Signature {
  area: string;
  signed: boolean;
  by: string;
  reason: string | null;
  at: string;
}

/** Skail.whenAny returns the value of the winner: the signature for an event, undefined for the deadline. */
export function isSignature(winner: unknown): winner is Signature {
  return winner !== undefined && winner !== null;
}
