import { describe, expect, it } from "vitest";
import { Areas, type Signature, type ContractEvent } from "@skail-document-signing/contracts";
import { ContractOperations } from "../src/contract-operations.js";

const signature = (area: string, signed: boolean, reason: string | null = null): Signature => ({
  area,
  signed,
  by: "Ana",
  reason,
  at: "2026-01-01T10:00:00.000Z",
});

function setup() {
  const events: ContractEvent[] = [];
  const ops = new ContractOperations({ notify: async (e) => void events.push(e) });
  return { events, ops };
}

describe("ContractOperations", () => {
  it("requests the signature of the right area", async () => {
    const { ops, events } = setup();
    await ops.requestSignature("c1", "T", Areas.finance);
    expect(events).toEqual([{ contractId: "c1", stage: "SignatureRequested", title: "T", area: "finance" }]);
  });

  it("rejects an unknown area and throws when the delivery fails", async () => {
    const { ops } = setup();
    await expect(ops.requestSignature("c1", "T", "rh")).rejects.toThrow(/rh/);
    const broken = new ContractOperations({
      notify: async () => {
        throw new Error("down");
      },
    });
    await expect(broken.requestSignature("c1", "T", Areas.legal)).rejects.toThrow("down");
  });

  it("archives with both signatures, idempotently", async () => {
    const { ops, events } = setup();
    const a = signature("legal", true);
    const b = signature("finance", true);
    const first = await ops.archive("abcdef123", a, b);
    const second = await ops.archive("abcdef123", a, b);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ end: "Archived", reference: "ARC-ABCDEF12" });
    expect(events.map((e) => e.stage)).toEqual(["Archived", "Archived"]);
    await expect(ops.archive("c1", a, signature("finance", false))).rejects.toThrow();
  });

  it("cancels: revokes when the other had signed, withdraws otherwise; reports area and reason", async () => {
    const { ops, events } = setup();
    const refusal = signature("finance", false, "too expensive");
    expect(await ops.cancel("c1", refusal, true)).toMatchObject({
      end: "Cancelled",
      refusedBy: "finance",
      reason: "too expensive",
      otherArea: "Revoked",
    });
    expect(await ops.cancel("c1", refusal, false)).toMatchObject({ otherArea: "Withdrawn" });
    expect(events.every((e) => e.stage === "Cancelled")).toBe(true);
    await expect(ops.cancel("c1", signature("legal", true), false)).rejects.toThrow();
  });

  it("forwards notifications", async () => {
    const { ops, events } = setup();
    await ops.reportStatus({ contractId: "c1", stage: "Started", title: "T" });
    expect(events).toHaveLength(1);
  });
});
