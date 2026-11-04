import { describe, expect, it } from "vitest";
import {
  Areas,
  ContractEvent,
  ContractLimits,
  ContractResult,
  Events,
  eventForArea,
  isSignature,
  isTerminalPhase,
  otherArea,
  startState,
  type Signature,
} from "../src/index.js";

const signature = (area: string, signed: boolean, reason: string | null = null): Signature => ({
  area,
  signed,
  by: "Ana",
  reason,
  at: "2026-01-01T10:00:00.000Z",
});

describe("areas and events", () => {
  it("names the external events (shared by the function and the web app)", () => {
    expect(Events.legalSignature).toBe("LEGAL_SIGNATURE");
    expect(Events.financeSignature).toBe("FINANCE_SIGNATURE");
  });

  it("maps an area to its event and to the other area", () => {
    expect(eventForArea(Areas.legal)).toBe(Events.legalSignature);
    expect(eventForArea(Areas.finance)).toBe(Events.financeSignature);
    expect(() => eventForArea("rh")).toThrow();
    expect(otherArea(Areas.legal)).toBe(Areas.finance);
    expect(otherArea(Areas.finance)).toBe(Areas.legal);
    expect(Areas.isValid("legal")).toBe(true);
    expect(Areas.isValid("rh")).toBe(false);
    expect(Areas.isValid(undefined)).toBe(false);
  });
});

describe("ContractResult", () => {
  it("archives with both signatures and a reference derived from the id", () => {
    const r = ContractResult.archived("abcdef12-3456", signature("legal", true), signature("finance", true));
    expect(r).toMatchObject({
      contractId: "abcdef12-3456",
      end: "Archived",
      reference: "ARC-ABCDEF12",
      refusedBy: null,
      otherArea: null,
    });
    expect(r.signatures.map((a) => a.area)).toEqual(["legal", "finance"]);
  });

  it("cancels with the refusing area and reason; revoked when the other had signed, withdrawn otherwise", () => {
    const refusal = signature("finance", false, "valor errado");
    const revoked = ContractResult.cancelled("c1", refusal, true);
    expect(revoked).toMatchObject({
      end: "Cancelled",
      reference: null,
      refusedBy: "finance",
      reason: "valor errado",
      otherArea: "Revoked",
    });
    expect(ContractResult.cancelled("c1", refusal, false).otherArea).toBe("Withdrawn");
  });
});

describe("ContractEvent", () => {
  it("builds the progress events", () => {
    expect(ContractEvent.started("c1", "T")).toEqual({ contractId: "c1", stage: "Started", title: "T" });
    expect(ContractEvent.signatureRequested("c1", "T", "legal")).toMatchObject({
      stage: "SignatureRequested",
      area: "legal",
    });
    expect(ContractEvent.failed("c1", "boom")).toMatchObject({ stage: "Failed", error: "boom" });
  });

  it("survives JSON (the same camelCase shape the .NET demo sends)", () => {
    const evt = ContractEvent.cancelled(
      "c1",
      ContractResult.cancelled("c1", signature("legal", false, "missing clause"), false),
    );
    expect(JSON.parse(JSON.stringify(evt))).toEqual(evt);
  });
});

describe("startState", () => {
  it("is enabled with no contract or a finished one, disabled while active", () => {
    expect(startState(undefined)).toEqual({ label: "Send for signature", enabled: true });
    for (const phase of ["Archived", "Cancelled", "Failed"] as const) {
      expect(isTerminalPhase(phase)).toBe(true);
      expect(startState({ phase }).enabled).toBe(true);
    }
    for (const phase of ["Starting", "Waiting"] as const) expect(startState({ phase }).enabled).toBe(false);
  });

  it("has a default title", () => {
    expect(ContractLimits.defaultTitle).toBe("Service agreement");
  });
});

describe("deadline", () => {
  it("tells a signature from the undefined of the deadline", () => {
    expect(isSignature({ area: "legal", signed: true, by: "Ana", reason: null, at: "x" })).toBe(true);
    for (const v of [undefined, null, {}, { area: "sales", signed: true }, "legal"]) expect(isSignature(v)).toBe(false);
  });

  it("expires with the signature already given, if any", () => {
    const signature = { area: "finance", signed: true, by: "Bia", reason: null, at: "x" };
    expect(ContractResult.expired("c1", signature)).toMatchObject({
      end: "Expired",
      signatures: [signature],
      reference: null,
    });
    expect(ContractResult.expired("c1", null).signatures).toEqual([]);
    expect(isTerminalPhase("Expired")).toBe(true);
  });
});
