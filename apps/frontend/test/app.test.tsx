import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContractResult, type AreaView, type ContractView } from "@skail-document-signing/contracts";
import { App } from "../src/App";

const area = (name: string, patch: Partial<AreaView> = {}): AreaView => ({
  area: name,
  status: "Pending",
  requested: true,
  by: null,
  reason: null,
  at: null,
  ...patch,
});

const view = (patch: Partial<ContractView> = {}): ContractView => {
  const c = {
    contractId: "contract-1",
    title: "Service agreement",
    deadlineSeconds: 120,
    startedAt: null,
    phase: "Waiting" as const,
    legal: area("legal"),
    finance: area("finance"),
    timeline: [],
    result: null,
    error: null,
    ...patch,
  };
  return { ...c, active: !["Archived", "Cancelled", "Expired", "Failed"].includes(c.phase) };
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: ContractView) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let calls: Array<{ url: string; method: string; body?: string }>;
let answers: Record<string, () => Response>;

beforeEach(() => {
  calls = [];
  answers = { "GET /api/config": () => json({ defaultTitle: "Service agreement", monitorUrl: null }) };
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new Error(`unexpected ${method} ${url}`);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const send = () => screen.getByRole("button", { name: /Send for signature|Waiting for signatures…/ });
const card = (name: "Legal" | "Finance") => screen.getByRole("region", { name });

async function started(patch: Partial<ContractView> = {}) {
  answers["POST /api/contracts"] = () => json(view());
  render(<App />);
  await userEvent.click(send());
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  if (Object.keys(patch).length) FakeEventSource.instances[0]!.emit(view(patch));
}

describe("App", () => {
  it("starts idle with the default title and Send enabled; the area buttons are disabled", () => {
    render(<App />);
    expect(send()).toBeEnabled();
    expect(screen.getByLabelText("Contract")).toHaveValue("Service agreement");
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(within(card("Legal")).getByRole("button", { name: "Sign" })).toBeDisabled();
  });

  it("click sends the title; field and button get disabled, the id is remembered and the stream opens", async () => {
    answers["POST /api/contracts"] = () => json(view());
    render(<App />);
    await userEvent.clear(screen.getByLabelText("Contract"));
    await userEvent.type(screen.getByLabelText("Contract"), "Supply agreement");
    await userEvent.click(send());

    await waitFor(() => expect(send()).toHaveTextContent("Waiting for signatures…"));
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toEqual({ title: "Supply agreement" });
    expect(send()).toBeDisabled();
    expect(screen.getByLabelText("Contract")).toBeDisabled();
    expect(localStorage.getItem("document-signing.contractId")).toBe("contract-1");
    expect(FakeEventSource.instances[0]!.url).toBe("/api/contracts/contract-1/stream");
  });

  it("shows the trigger error and keeps Send available", async () => {
    answers["POST /api/contracts"] = () => json({ error: "skail down" }, 502);
    render(<App />);
    await userEvent.click(send());
    expect(await screen.findByText(/skail down/)).toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("shows the overall state according to who is missing", async () => {
    await started();
    const es = FakeEventSource.instances[0]!;
    expect(screen.getByText("Waiting for both", { selector: ".badge" })).toBeInTheDocument();
    es.emit(view({ legal: area("legal", { status: "Signed", by: "Ana" }) }));
    expect(screen.getByText("Waiting for Finance", { selector: ".badge" })).toBeInTheDocument();
    es.emit(view({ finance: area("finance", { status: "Signed", by: "Bia" }) }));
    expect(screen.getByText("Waiting for Legal", { selector: ".badge" })).toBeInTheDocument();
  });

  it("Sign posts the decision of that area with the signer; the buttons of a decided area disappear", async () => {
    await started();
    answers["POST /api/contracts/contract-1/signatures"] = () =>
      json(view({ finance: area("finance", { status: "Signed", by: "Bia" }) }));

    await userEvent.type(within(card("Finance")).getByLabelText("Signed by"), "Bia");
    await userEvent.click(within(card("Finance")).getByRole("button", { name: "Sign" }));

    await waitFor(() =>
      expect(within(card("Finance")).queryByRole("button", { name: "Sign" })).not.toBeInTheDocument(),
    );
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/signatures"))!.body!)).toEqual({
      area: "finance",
      signedBy: "Bia",
      signed: true,
    });
    expect(within(card("Finance")).getByText("Signed")).toBeInTheDocument();
    expect(within(card("Legal")).getByRole("button", { name: "Sign" })).toBeEnabled(); // the other area is still free
    expect(within(card("Legal")).getByText("Pending")).toBeInTheDocument();
  });

  it("Refuse sends signed:false with the reason", async () => {
    await started();
    answers["POST /api/contracts/contract-1/signatures"] = () =>
      json(view({ legal: area("legal", { status: "Refused", reason: "too expensive" }) }));

    await userEvent.type(within(card("Legal")).getByLabelText("Reason"), "too expensive");
    await userEvent.click(within(card("Legal")).getByRole("button", { name: "Refuse" }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/signatures"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/signatures"))!.body!)).toMatchObject({
      area: "legal",
      signed: false,
      reason: "too expensive",
    });
  });

  it("if the fire fails the buttons come back for a new attempt, with the error shown", async () => {
    await started();
    answers["POST /api/contracts/contract-1/signatures"] = () => json({ error: "skail down" }, 502);
    await userEvent.click(within(card("Legal")).getByRole("button", { name: "Sign" }));

    expect(await screen.findByText(/skail down/)).toBeInTheDocument();
    expect(within(card("Legal")).getByRole("button", { name: "Sign" })).toBeEnabled();
  });

  it("Archived shows the reference and re-enables Send; the area buttons are gone", async () => {
    await started();
    const a = { area: "legal", signed: true, by: "Ana", reason: null, at: "2026-01-01T10:00:00Z" };
    const b = { ...a, area: "finance", by: "Bia" };
    FakeEventSource.instances[0]!.emit(
      view({
        phase: "Archived",
        legal: area("legal", { status: "Signed", by: "Ana" }),
        finance: area("finance", { status: "Signed", by: "Bia" }),
        result: ContractResult.archived("contract-1", a, b),
      }),
    );

    expect(screen.getByRole("status", { name: "Result" })).toHaveTextContent("Archived");
    expect(screen.getByRole("status", { name: "Result" })).toHaveTextContent("ARC-CONTRACT");
    expect(send()).toBeEnabled();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(screen.queryByRole("button", { name: "Refuse" })).not.toBeInTheDocument();
  });

  it("Cancelled shows who refused, the reason and what happened to the other area", async () => {
    await started();
    const refusal = { area: "finance", signed: false, by: "Bia", reason: "wrong amount", at: "2026-01-01T10:00:00Z" };
    FakeEventSource.instances[0]!.emit(
      view({
        phase: "Cancelled",
        legal: area("legal", { status: "Revoked", by: "Ana" }),
        finance: area("finance", { status: "Refused", reason: "wrong amount" }),
        result: ContractResult.cancelled("contract-1", refusal, true),
      }),
    );

    const result = screen.getByRole("status", { name: "Result" });
    expect(result).toHaveTextContent("Cancelled");
    expect(result).toHaveTextContent("Finance");
    expect(result).toHaveTextContent("wrong amount");
    expect(result).toHaveTextContent("signature revoked");
    expect(within(card("Legal")).getByText("Revoked")).toBeInTheDocument();
  });

  it("Expired says nobody answered in time and revokes the signature already given", async () => {
    await started();
    const signature = { area: "legal", signed: true, by: "Ana", reason: null, at: "2026-01-01T10:00:00Z" };
    FakeEventSource.instances[0]!.emit(
      view({
        phase: "Expired",
        legal: area("legal", { status: "Revoked", by: "Ana" }),
        finance: area("finance", { status: "Withdrawn" }),
        result: ContractResult.expired("contract-1", signature),
      }),
    );

    const result = screen.getByRole("status", { name: "Result" });
    expect(result).toHaveTextContent("Expired");
    expect(result).toHaveTextContent("Legal signature revoked");
    expect(send()).toBeEnabled();
    expect(within(card("Finance")).getByText("Withdrawn")).toBeInTheDocument();
  });

  it("shows the countdown to the deadline while waiting", async () => {
    await started();
    FakeEventSource.instances[0]!.emit(view({ startedAt: new Date().toISOString(), deadlineSeconds: 120 }));
    expect(await screen.findByText(/deadline in 1[12]\ds/)).toBeInTheDocument();
  });

  it("renders the timeline in arrival order", async () => {
    await started({
      timeline: [
        { kind: "Started", area: null, text: "Sent for signature to Legal and Finance", at: "2026-01-01T10:00:00Z" },
        { kind: "Signed", area: "finance", text: "Finance signed (Bia)", at: "2026-01-01T10:01:00Z" },
      ],
    });
    const items = within(screen.getByRole("list", { name: "Timeline" })).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Sent for signature"),
      expect.stringContaining("Finance signed (Bia)"),
    ]);
  });

  it("reload restores the contract from the server and reconnects the stream", async () => {
    localStorage.setItem("document-signing.contractId", "contract-1");
    answers["GET /api/contracts/contract-1"] = () =>
      json(view({ legal: area("legal", { status: "Signed", by: "Ana" }) }));
    render(<App />);

    await waitFor(() => expect(within(card("Legal")).getByText("Signed")).toBeInTheDocument());
    expect(send()).toBeDisabled();
    await waitFor(() => expect(FakeEventSource.instances[0]?.url).toBe("/api/contracts/contract-1/stream"));
    expect(within(card("Legal")).queryByRole("button", { name: "Sign" })).not.toBeInTheDocument();
  });
});
