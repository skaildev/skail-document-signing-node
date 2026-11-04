import { beforeEach, describe, expect, it } from "vitest";
import { ContractEvent, ContractLimits, type Signature } from "@skail-document-signing/contracts";
import { createApp } from "../src/app.js";
import { ContractStore } from "../src/contract-store.js";
import { SkailGatewayError, type SkailGateway } from "../src/gateway.js";

class FakeGateway implements SkailGateway {
  triggers: Array<[string, string, number]> = [];
  fires: Array<[string, Signature]> = [];
  failTrigger = false;
  failFire = false;
  async trigger(id: string, title: string, deadlineSeconds: number) {
    if (this.failTrigger) throw new SkailGatewayError("skail down");
    this.triggers.push([id, title, deadlineSeconds]);
  }
  async fireSignature(id: string, a: Signature) {
    if (this.failFire) throw new SkailGatewayError("skail down");
    this.fires.push([id, a]);
  }
}

let gw: FakeGateway;
let store: ContractStore;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  gw = new FakeGateway();
  store = new ContractStore();
  app = createApp({ store, gateway: gw, monitorUrl: "http://monitor" });
});

const start = async (payload?: unknown) => {
  const res = await app.inject({ method: "POST", url: "/api/contracts", payload: payload as object });
  return { res, body: res.json() };
};
const sign = (id: string, payload: object) =>
  app.inject({ method: "POST", url: `/api/contracts/${id}/signatures`, payload });

describe("web API", () => {
  it("serves config and healthz", async () => {
    expect((await app.inject("/healthz")).body).toBe("ok");
    expect((await app.inject("/api/config")).json()).toEqual({
      defaultTitle: ContractLimits.defaultTitle,
      monitorUrl: "http://monitor",
    });
  });

  it("triggers with the default, informed or blank title", async () => {
    expect((await start()).body).toMatchObject({ title: ContractLimits.defaultTitle, phase: "Starting", active: true });
    expect((await start({ title: "  Supply agreement " })).body.title).toBe("Supply agreement");
    expect((await start({ title: "   " })).body.title).toBe(ContractLimits.defaultTitle);
    expect(gw.triggers.map((t) => t[1])).toEqual([
      ContractLimits.defaultTitle,
      "Supply agreement",
      ContractLimits.defaultTitle,
    ]);
  });

  it("sends the deadline to the function and keeps it in the state", async () => {
    const custom = createApp({ store: new ContractStore(), gateway: gw, deadlineSeconds: 604800 });
    const res = await custom.inject({ method: "POST", url: "/api/contracts", payload: {} });
    expect(res.json()).toMatchObject({ deadlineSeconds: 604800, startedAt: null });
    expect(gw.triggers.at(-1)![2]).toBe(604800);
    expect((await start()).body.deadlineSeconds).toBe(120);
    expect(gw.triggers.at(-1)![2]).toBe(120);
  });

  it("rejects a too long title (400) and reports a trigger failure (502) without keeping the contract", async () => {
    expect((await start({ title: "x".repeat(121) })).res.statusCode).toBe(400);
    gw.failTrigger = true;
    const { res } = await start();
    expect(res.statusCode).toBe(502);
  });

  it("fires the decision of each area with the area set by the route payload, the time stamped by the web", async () => {
    const { body } = await start();
    const res = await sign(body.contractId, { area: "finance", signedBy: "Bia", signed: true });
    expect(res.statusCode).toBe(200);
    expect(gw.fires[0]![1]).toMatchObject({ area: "finance", signed: true, by: "Bia", reason: null });
    expect(Date.parse(gw.fires[0]![1].at)).not.toBeNaN();
    expect(res.json().finance.status).toBe("Signed");
    await sign(body.contractId, { area: "legal", signed: false, reason: "too expensive" });
    expect(gw.fires[1]![1]).toMatchObject({ area: "legal", signed: false, by: "Legal team", reason: "too expensive" });
  });

  it("400 for an invalid area, 404 for an unknown contract", async () => {
    const { body } = await start();
    expect((await sign(body.contractId, { area: "rh" })).statusCode).toBe(400);
    expect((await sign("nope", { area: "legal" })).statusCode).toBe(404);
  });

  it("409 on a second decision of the same area (no second fire) and after the contract ended", async () => {
    const { body } = await start();
    await sign(body.contractId, { area: "legal", signed: true });
    expect((await sign(body.contractId, { area: "legal", signed: false })).statusCode).toBe(409);
    expect(gw.fires).toHaveLength(1);
    store.apply(ContractEvent.failed(body.contractId, "x"));
    expect((await sign(body.contractId, { area: "finance", signed: true })).statusCode).toBe(409);
    expect(gw.fires).toHaveLength(1);
  });

  it("a failed fire (502) leaves the decision unmarked so the area can try again", async () => {
    const { body } = await start();
    gw.failFire = true;
    expect((await sign(body.contractId, { area: "legal", signed: true })).statusCode).toBe(502);
    gw.failFire = false;
    expect((await sign(body.contractId, { area: "legal", signed: true })).statusCode).toBe(200);
  });

  it("accepts worker events and returns the state", async () => {
    const { body } = await start();
    const res = await app.inject({
      method: "POST",
      url: `/internal/contracts/${body.contractId}/events`,
      payload: ContractEvent.started("x", "T"),
    });
    expect(res.statusCode).toBe(204);
    expect((await app.inject(`/api/contracts/${body.contractId}`)).json().phase).toBe("Waiting");
    expect((await app.inject("/api/contracts/nope")).statusCode).toBe(404);
  });

  it("streams the current state first and ends at a terminal phase", async () => {
    const { body } = await start();
    store.apply(ContractEvent.failed(body.contractId, "x"));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/contracts/${body.contractId}/stream`);
    const text = await res.text();
    expect(text).toMatch(/^data: /);
    expect(JSON.parse(text.slice(6))).toMatchObject({ phase: "Failed", active: false });
    await app.close();
  });
});
