import { beforeEach, describe, expect, it } from "vitest";
import { Areas, ContractEvent, ContractResult, type Signature } from "@skail-document-signing/contracts";
import { ContractStore } from "../src/contract-store.js";

const dec = (area: string, signed: boolean, reason: string | null = null): Signature => ({
  area,
  signed,
  by: "Ana",
  reason,
  at: "2026-01-01T10:00:00.000Z",
});

let store: ContractStore;
beforeEach(() => {
  store = new ContractStore(() => "2026-01-01T00:00:00.000Z");
  store.create("c1", "Agreement", 120);
});

describe("ContractStore", () => {
  it("starts Starting with both areas Pending, then Waiting after Started", () => {
    expect(store.get("c1")).toMatchObject({
      phase: "Starting",
      legal: { status: "Pending" },
      finance: { status: "Pending" },
    });
    expect(store.apply(ContractEvent.started("c1", "Agreement"))).toBe(true);
    expect(store.get("c1")!.phase).toBe("Waiting");
    expect(store.apply(ContractEvent.started("c1", "Agreement"))).toBe(false);
  });

  it("records a request once per area (duplicates ignored)", () => {
    expect(store.apply(ContractEvent.signatureRequested("c1", "T", Areas.legal))).toBe(true);
    expect(store.apply(ContractEvent.signatureRequested("c1", "T", Areas.legal))).toBe(false);
    expect(store.get("c1")!.legal.requested).toBe(true);
    expect(store.get("c1")!.finance.requested).toBe(false);
  });

  it("registers a decision per area; the same area cannot decide twice", () => {
    expect(store.tryDecide("c1", dec(Areas.legal, true))).toBe("Accepted");
    expect(store.tryDecide("c1", dec(Areas.legal, false))).toBe("Duplicate");
    expect(store.get("c1")!.legal).toMatchObject({ status: "Signed", by: "Ana" });
    expect(store.tryDecide("nope", dec(Areas.legal, true))).toBe("NotFound");
  });

  it("free order: both orders reach Archived with both areas Signed", () => {
    for (const order of [
      [Areas.legal, Areas.finance],
      [Areas.finance, Areas.legal],
    ]) {
      const id = `o-${order[0]}`;
      store.create(id, "T", 120);
      store.apply(ContractEvent.started(id, "T"));
      const [a, b] = order as [string, string];
      store.tryDecide(id, dec(a, true));
      expect(store.get(id)!.phase).toBe("Waiting"); // not archived by the web alone
      store.tryDecide(id, dec(b, true));
      store.apply(ContractEvent.archived(id, ContractResult.archived(id, dec(a, true), dec(b, true))));
      expect(store.get(id)).toMatchObject({
        phase: "Archived",
        legal: { status: "Signed" },
        finance: { status: "Signed" },
      });
    }
  });

  it("stamps startedAt and shows the deadline when the worker reports Started", () => {
    store.apply(ContractEvent.started("c1", "Agreement"));
    expect(store.get("c1")).toMatchObject({ deadlineSeconds: 120, startedAt: "2026-01-01T00:00:00.000Z" });
    expect(store.get("c1")!.timeline.at(-1)!.text).toBe("Sent for signature to Legal and Finance (deadline 120s)");
  });

  it("expired: the area that signed is Revoked, the one that did not answer is Withdrawn, and decisions are refused", () => {
    store.apply(ContractEvent.started("c1", "Agreement"));
    store.tryDecide("c1", dec(Areas.finance, true));
    store.apply(ContractEvent.expired("c1", ContractResult.expired("c1", dec(Areas.finance, true))));
    expect(store.get("c1")).toMatchObject({
      phase: "Expired",
      legal: { status: "Withdrawn" },
      finance: { status: "Revoked" },
    });
    expect(store.get("c1")!.timeline.at(-1)!.text).toBe("Contract expired: Legal did not answer in time");
    expect(store.tryDecide("c1", dec(Areas.legal, true))).toBe("Finished");

    store.create("c3", "T", 120);
    store.apply(ContractEvent.expired("c3", ContractResult.expired("c3", null)));
    expect(store.get("c3")!.timeline.at(-1)!.text).toBe("Contract expired: Legal and Finance did not answer in time");
  });

  it("refusal first: the other area is Withdrawn; refusal second: the other is Revoked", () => {
    store.create("c2", "T", 120);
    store.tryDecide("c1", dec(Areas.legal, false, "missing clause"));
    store.apply(
      ContractEvent.cancelled("c1", ContractResult.cancelled("c1", dec(Areas.legal, false, "missing clause"), false)),
    );
    expect(store.get("c1")).toMatchObject({
      phase: "Cancelled",
      legal: { status: "Refused" },
      finance: { status: "Withdrawn" },
    });

    store.tryDecide("c2", dec(Areas.legal, true));
    store.tryDecide("c2", dec(Areas.finance, false, "too expensive"));
    store.apply(
      ContractEvent.cancelled("c2", ContractResult.cancelled("c2", dec(Areas.finance, false, "too expensive"), true)),
    );
    expect(store.get("c2")).toMatchObject({
      phase: "Cancelled",
      legal: { status: "Revoked" },
      finance: { status: "Refused" },
    });
  });

  it("refuses decisions after the end and ignores events for a finished contract", () => {
    store.apply(ContractEvent.failed("c1", "boom"));
    expect(store.get("c1")).toMatchObject({ phase: "Failed", error: "boom" });
    expect(store.tryDecide("c1", dec(Areas.legal, true))).toBe("Finished");
    expect(store.apply(ContractEvent.started("c1", "x"))).toBe(false);
  });

  it("release undoes a decision when the fire failed, so the area can retry", () => {
    store.tryDecide("c1", dec(Areas.legal, true));
    store.release("c1", Areas.legal);
    expect(store.get("c1")!.legal.status).toBe("Pending");
    expect(store.get("c1")!.timeline.some((t) => t.kind === "Signed")).toBe(false);
    expect(store.tryDecide("c1", dec(Areas.legal, true))).toBe("Accepted");
  });

  it("keeps the timeline in arrival order and notifies subscribers, closing them at the end", () => {
    const seen: string[] = [];
    let closed = false;
    store.subscribe(
      "c1",
      (s) => seen.push(s.phase),
      () => (closed = true),
    );
    store.apply(ContractEvent.started("c1", "T"));
    store.tryDecide("c1", dec(Areas.finance, true));
    store.apply(ContractEvent.failed("c1", "x"));
    expect(seen).toEqual(["Waiting", "Waiting", "Failed"]);
    expect(closed).toBe(true);
    expect(store.get("c1")!.timeline.map((t) => t.kind)).toEqual(["Started", "Signed", "Failed"]);
  });
});
