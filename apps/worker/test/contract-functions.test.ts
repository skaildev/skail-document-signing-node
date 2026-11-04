import { beforeEach, describe, expect, it } from "vitest";
import { EventType, type Provider } from "@skail/runtime";
import { createSkailWorker, type SkailWorker } from "@skail/runtime/testing";
import { InMemorySkailPlatform } from "@skail/testing";
import {
  Areas,
  Events,
  eventForArea,
  type Signature,
  type ContractEvent,
  type ContractResult,
} from "@skail-document-signing/contracts";
import { ContractFunctions } from "../src/contract-functions.js";
import { ContractOperations } from "../src/contract-operations.js";
import type { ProgressNotifier } from "../src/web.js";

const WORKLOAD = "document-signing:v0.0.1";
const ID = "contract-1";

const signature = (area: string, signed = true, reason: string | null = null): Signature => ({
  area,
  signed,
  by: `${area} user`,
  reason,
  at: "2026-01-01T10:00:00.000Z",
});

class Harness {
  readonly events: ContractEvent[] = [];
  failNotify = 0; // transient failures of the notifier before succeeding
  alwaysFailRequest = false;
  readonly platform = new InMemorySkailPlatform();
  readonly worker: SkailWorker;

  constructor() {
    const notifier: ProgressNotifier = {
      notify: async (event) => {
        if (this.alwaysFailRequest && event.stage === "SignatureRequested") throw new Error("web down");
        if (this.failNotify > 0 && event.stage === "SignatureRequested") {
          this.failNotify--;
          throw new Error("transient");
        }
        this.events.push(event);
      },
    };
    const providers: Provider[] = [
      { token: ContractFunctions, useFactory: () => new ContractFunctions(new ContractOperations(notifier)) },
    ];
    this.worker = createSkailWorker({
      workload: WORKLOAD,
      types: [ContractFunctions],
      providers,
      sidecar: this.platform,
    });
  }

  start(id = ID) {
    this.platform.start(`${WORKLOAD}/SignContract`, [id, "Agreement X", 120], id);
  }

  async run() {
    return this.worker.runActivation((await this.platform.consume())!);
  }

  /** What the web app does on a click: fire the event of the area with the Signature as payload. */
  sign(a: Signature, id = ID) {
    this.platform.signal(eventForArea(a.area), id, a);
  }

  /** Completes the deadline, as the clock would, and runs the worker. */
  async expire() {
    const delays = this.platform.history(ID).filter((f) => f.eventType === EventType.Delay && !f.targetResult);
    expect(delays).toHaveLength(1);
    this.platform.complete(ID, delays[0]!.index);
    return this.run();
  }

  pendingWaits() {
    return this.platform.history(ID).filter((f) => f.eventType === EventType.WaitExternalEvent && !f.targetResult);
  }

  stages(stage: ContractEvent["stage"]) {
    return this.events.filter((e) => e.stage === stage);
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

const result = (outcome: Awaited<ReturnType<Harness["run"]>>) => (outcome as { result: ContractResult }).result;

describe("SignContract", () => {
  it("notifies Started, requests both areas once and hibernates on two waits and one deadline", async () => {
    h.start();
    expect((await h.run()).status).toBe("hibernated");

    expect(h.stages("Started")).toHaveLength(1);
    expect(h.stages("SignatureRequested").map((e) => e.area)).toEqual([Areas.legal, Areas.finance]);
    expect(h.pendingWaits()).toHaveLength(2);
    expect(h.platform.history(ID).filter((f) => f.eventType === EventType.Delay)).toHaveLength(1);
  });

  it("expires when nobody answers before the deadline, withdrawing both requests", async () => {
    h.start();
    await h.run();

    const outcome = await h.expire();
    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({ end: "Expired", signatures: [], refusedBy: null });
    expect(h.stages("Expired")).toHaveLength(1);
  });

  it("expires when only one area answers: the same deadline serves the second wait, and the signature is revoked", async () => {
    h.start();
    await h.run();
    h.sign(signature(Areas.finance));
    expect((await h.run()).status).toBe("hibernated");

    const outcome = await h.expire();
    expect(result(outcome)).toMatchObject({ end: "Expired" });
    expect(result(outcome).signatures.map((a) => a.area)).toEqual([Areas.finance]);
    expect(h.platform.history(ID).filter((f) => f.eventType === EventType.Delay)).toHaveLength(1);
    expect(h.stages("Archived")).toHaveLength(0);
  });

  it("legal then finance: archives only when the second signature arrives", async () => {
    h.start();
    await h.run();

    h.sign(signature(Areas.legal));
    expect((await h.run()).status).toBe("hibernated"); // not archived yet
    expect(h.stages("Archived")).toHaveLength(0);
    expect(h.stages("Cancelled")).toHaveLength(0);

    h.sign(signature(Areas.finance));
    const outcome = await h.run();
    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({ end: "Archived", reference: "ARC-CONTRACT" });
    expect(result(outcome).signatures.map((a) => a.area)).toEqual([Areas.legal, Areas.finance]);
    expect(h.stages("Archived")).toHaveLength(1);
  });

  it("finance then legal: same outcome (free order), the first one is the one that arrived first", async () => {
    h.start();
    await h.run();
    h.sign(signature(Areas.finance));
    expect((await h.run()).status).toBe("hibernated");
    h.sign(signature(Areas.legal));

    const outcome = await h.run();
    expect(result(outcome)).toMatchObject({ end: "Archived" });
    expect(result(outcome).signatures.map((a) => a.area)).toEqual([Areas.finance, Areas.legal]);
  });

  it.each([Areas.legal, Areas.finance])(
    "a refusal from %s first cancels at once, withdrawing the other request",
    async (area) => {
      h.start();
      await h.run();
      h.sign(signature(area, false, "wrong amount"));

      const outcome = await h.run();
      expect(outcome.status).toBe("completed");
      expect(result(outcome)).toMatchObject({
        end: "Cancelled",
        refusedBy: area,
        reason: "wrong amount",
        otherArea: "Withdrawn",
      });
      expect(h.stages("Cancelled")).toHaveLength(1);
      expect(h.stages("Archived")).toHaveLength(0);
    },
  );

  it.each([
    [Areas.legal, Areas.finance],
    [Areas.finance, Areas.legal],
  ])("%s signs and then %s refuses: cancelled, the signature is revoked", async (first, second) => {
    h.start();
    await h.run();
    h.sign(signature(first));
    await h.run();
    h.sign(signature(second, false, "missing clause"));

    const outcome = await h.run();
    expect(result(outcome)).toMatchObject({ end: "Cancelled", refusedBy: second, otherArea: "Revoked" });
    expect(h.stages("Archived")).toHaveLength(0);
  });

  it("serves a decision fired before the function reached the wait (worker was down)", async () => {
    h.start();
    await h.run(); // requests sent, hibernated on the waits
    h.sign(signature(Areas.legal));
    h.sign(signature(Areas.finance)); // both arrive while nobody runs

    expect(result(await h.run())).toMatchObject({ end: "Archived" });
  });

  it("an event for another contract does not wake this one", async () => {
    h.start();
    await h.run();
    expect(() => h.sign(signature(Areas.legal), "other-contract")).toThrow();
    expect(h.pendingWaits()).toHaveLength(2);
  });

  it("requests the signature once per area even after resuming", async () => {
    h.start();
    await h.run();
    h.sign(signature(Areas.legal));
    await h.run();
    h.sign(signature(Areas.finance));
    await h.run();

    expect(h.stages("SignatureRequested")).toHaveLength(2);
    expect(h.platform.history(ID).filter((f) => f.eventType === EventType.WaitExternalEvent)).toHaveLength(2);
    expect(Object.values(Events)).toHaveLength(2);
  });

  it("retries a request command that failed once", async () => {
    h.failNotify = 1;
    h.start();
    await h.run();
    for (let i = 0; i < 5 && h.stages("SignatureRequested").length < 2; i++) {
      h.platform.enqueue(ID);
      await h.run();
    }
    expect(h.stages("SignatureRequested").map((e) => e.area)).toEqual([Areas.legal, Areas.finance]);
  });
});
