import { describe, expect, it } from "vitest";
import { SkailApiGateway, SkailGatewayError, type SkailOptions } from "../src/gateway.js";

const options: SkailOptions = {
  baseUrl: "https://skail.test/",
  namespace: "t/e",
  key: "k",
  workload: "document-signing:v0.0.1",
};
const signature = { area: "legal", signed: true, by: "Ana", reason: null, at: "2026-01-01T10:00:00.000Z" };

function gateway(answers: Array<number | Error>, opts = options) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const gw = new SkailApiGateway(
    opts,
    async (url, init) => {
      calls.push({ url, init: init! });
      const next = answers.shift() ?? 200;
      if (next instanceof Error) throw next;
      return new Response(null, { status: next });
    },
    () => 0,
  );
  return { gw, calls };
}

describe("SkailApiGateway", () => {
  it("triggers SignContract with [id, title, deadlineSeconds] and the skail headers", async () => {
    const { gw, calls } = gateway([200]);
    await gw.trigger("id 1", "Agreement", 120);
    expect(calls[0]!.url).toBe("https://skail.test/api/v1/trigger/document-signing/v0.0.1/SignContract/id%201");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(["id 1", "Agreement", 120]);
    expect(calls[0]!.init.headers).toMatchObject({
      "skail-key": "k",
      authorization: "Bearer k",
      "skail-namespace": "t/e",
    });
  });

  it("fires the area's event with the Signature JSON as body", async () => {
    const { gw, calls } = gateway([200, 200]);
    await gw.fireSignature("c1", signature);
    await gw.fireSignature("c1", { ...signature, area: "finance" });
    expect(calls[0]!.url).toBe("https://skail.test/api/v1/fire/LEGAL_SIGNATURE/c1");
    expect(calls[1]!.url).toBe("https://skail.test/api/v1/fire/FINANCE_SIGNATURE/c1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(signature);
  });

  it("retries 429/5xx/network with the same id and body, then gives up", async () => {
    const ok = gateway([503, new Error("reset"), 429, 200]);
    await ok.gw.fireSignature("c1", signature);
    expect(ok.calls).toHaveLength(4);
    expect(new Set(ok.calls.map((c) => c.url + c.init.body)).size).toBe(1);

    const down = gateway([500, 500, 500, 500, 500]);
    await expect(down.gw.fireSignature("c1", signature)).rejects.toThrow(/giving up after 5/);
  });

  it("does not retry 401/403 and points at the key", async () => {
    const { gw, calls } = gateway([401]);
    await expect(gw.trigger("c1", "T", 120)).rejects.toThrow(/SKAIL_KEY/);
    expect(calls).toHaveLength(1);
  });

  it("fails before calling when SKAIL_BASE_URL or SKAIL_WORKLOAD are wrong", async () => {
    const a = gateway([], { ...options, baseUrl: "" });
    await expect(a.gw.trigger("c1", "T", 120)).rejects.toBeInstanceOf(SkailGatewayError);
    const b = gateway([], { ...options, workload: "nover" });
    await expect(b.gw.trigger("c1", "T", 120)).rejects.toThrow(/name:version/);
    expect(a.calls.length + b.calls.length).toBe(0);
  });
});
