// Shared by web, worker and front end. It also goes into the skail bundle, so it has only types, constants
// and pure functions: no Node I/O imports, which the skail build rejects.

/** The two areas that sign. Plain strings (not an enum): Signature is the payload of an external event. */
export const Areas = {
  legal: "legal",
  finance: "finance",
  isValid: (area: unknown): area is string => area === "legal" || area === "finance",
  /** English label used by the page and by the default signer name. */
  label: (area: string): string => (area === "legal" ? "Legal" : "Finance"),
} as const;

/** External event names, shared by the function (waitForEvent) and the web app (fire). */
export const Events = {
  legalSignature: "LEGAL_SIGNATURE",
  financeSignature: "FINANCE_SIGNATURE",
} as const;

export const ContractLimits = {
  defaultTitle: "Service agreement",
  maxTitleLength: 120,
  /** Time both areas have to answer: 2 minutes in the demo; a real contract would use days. */
  defaultDeadlineSeconds: 120,
  maxDeadlineSeconds: 60 * 60 * 24 * 366,
} as const;

export function eventForArea(area: string): string {
  switch (area) {
    case Areas.legal:
      return Events.legalSignature;
    case Areas.finance:
      return Events.financeSignature;
    default:
      throw new Error(`unknown area '${area}'`);
  }
}

export function otherArea(area: string): string {
  return area === Areas.legal ? Areas.finance : Areas.legal;
}

/**
 * One area's answer: the payload of the external event. It only carries what the decision needs (never the
 * contract content). `at` (ISO 8601) is stamped by the web app, since the function cannot read the clock, and
 * `area` is set by the web app from the route: the function identifies the winner of whenAny by it.
 */
export interface Signature {
  area: string;
  signed: boolean;
  by: string;
  reason: string | null;
  at: string;
}

// Skail.whenAny returns the value of the winner: undefined for the deadline, the payload for a signature.
export function isSignature(value: unknown): value is Signature {
  return (
    typeof value === "object" &&
    value !== null &&
    Areas.isValid((value as Signature).area) &&
    typeof (value as Signature).signed === "boolean"
  );
}

export type ContractEnd = "Archived" | "Cancelled" | "Expired";

/** What happened to the area that did not refuse when the contract was cancelled. */
export type OtherAreaOutcome = "Revoked" | "Withdrawn";

export interface ContractResult {
  contractId: string;
  end: ContractEnd;
  reference: string | null;
  signatures: Signature[];
  refusedBy: string | null;
  reason: string | null;
  otherArea: OtherAreaOutcome | null;
}

export const ContractResult = {
  /** The reference derives from the id, so a retried command returns the same one. */
  archived(contractId: string, first: Signature, second: Signature): ContractResult {
    return {
      contractId,
      end: "Archived",
      reference: `ARC-${contractId.slice(0, 8).toUpperCase()}`,
      signatures: [first, second],
      refusedBy: null,
      reason: null,
      otherArea: null,
    };
  },

  cancelled(contractId: string, refusal: Signature, otherAlreadySigned: boolean): ContractResult {
    return {
      contractId,
      end: "Cancelled",
      reference: null,
      signatures: [refusal],
      refusedBy: refusal.area,
      reason: refusal.reason,
      otherArea: otherAlreadySigned ? "Revoked" : "Withdrawn",
    };
  },

  /** The deadline passed: the signature already given, if any, is revoked and the pending requests withdrawn. */
  expired(contractId: string, signature: Signature | null): ContractResult {
    return {
      contractId,
      end: "Expired",
      reference: null,
      signatures: signature ? [signature] : [],
      refusedBy: null,
      reason: null,
      otherArea: null,
    };
  },
};

export type ContractStage = "Started" | "SignatureRequested" | "Archived" | "Cancelled" | "Expired" | "Failed";

/** Progress reported by the worker to the web app. The decisions themselves go straight to skail. */
export interface ContractEvent {
  contractId: string;
  stage: ContractStage;
  title?: string | null;
  area?: string | null;
  result?: ContractResult | null;
  error?: string | null;
}

export const ContractEvent = {
  started: (contractId: string, title: string): ContractEvent => ({ contractId, stage: "Started", title }),
  signatureRequested: (contractId: string, title: string, area: string): ContractEvent => ({
    contractId,
    stage: "SignatureRequested",
    title,
    area,
  }),
  archived: (contractId: string, result: ContractResult): ContractEvent => ({ contractId, stage: "Archived", result }),
  cancelled: (contractId: string, result: ContractResult): ContractEvent => ({
    contractId,
    stage: "Cancelled",
    result,
  }),
  expired: (contractId: string, result: ContractResult): ContractEvent => ({ contractId, stage: "Expired", result }),
  failed: (contractId: string, error: string): ContractEvent => ({ contractId, stage: "Failed", error }),
};

// ---- web view (what GET /api/contracts/{id} and the SSE stream return) ----

export type ContractPhase = "Starting" | "Waiting" | "Archived" | "Cancelled" | "Expired" | "Failed";
export type AreaStatus = "Pending" | "Signed" | "Refused" | "Revoked" | "Withdrawn";

export interface AreaView {
  area: string;
  status: AreaStatus;
  requested: boolean;
  by: string | null;
  reason: string | null;
  at: string | null;
}

export interface TimelineEntry {
  kind: string;
  area: string | null;
  text: string;
  at: string;
}

export interface ContractState {
  contractId: string;
  title: string;
  deadlineSeconds: number;
  /** ISO 8601, stamped when the worker reports Started: the page countdown reads it. */
  startedAt: string | null;
  phase: ContractPhase;
  legal: AreaView;
  finance: AreaView;
  timeline: TimelineEntry[];
  result: ContractResult | null;
  error: string | null;
}

export interface ContractView extends ContractState {
  active: boolean;
}

export interface AppConfig {
  defaultTitle: string;
  monitorUrl: string | null;
}

export function isTerminalPhase(phase: ContractPhase): boolean {
  return phase === "Archived" || phase === "Cancelled" || phase === "Expired" || phase === "Failed";
}

export interface UiState {
  label: string;
  enabled: boolean;
}

/** The title field and the send button are available only when there is no contract in progress. */
export function startState(contract: Pick<ContractState, "phase"> | undefined): UiState {
  return !contract || isTerminalPhase(contract.phase)
    ? { label: "Send for signature", enabled: true }
    : { label: "Waiting for signatures…", enabled: false };
}
