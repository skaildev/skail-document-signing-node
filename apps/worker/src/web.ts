import type { ContractEvent } from "@skail-document-signing/contracts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProgressNotifier {
  notify(event: ContractEvent): Promise<void>;
}

/** Reports progress to the web app: POST {web}/internal/contracts/{id}/events. */
export class HttpProgressNotifier implements ProgressNotifier {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {}

  async notify(event: ContractEvent): Promise<void> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const response = await this.fetchImpl(`${base}internal/contracts/${encodeURIComponent(event.contractId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`Web app answered ${response.status} to the progress event`);
  }
}

/** Offline notifier (NOTIFY_PROVIDER=fake): drops the events. */
export class FakeProgressNotifier implements ProgressNotifier {
  async notify(): Promise<void> {}
}
