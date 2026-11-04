import type { AppConfig, ContractView } from "@skail-document-signing/contracts";

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `HTTP ${res.status}`);
}

export async function startContract(title: string): Promise<ContractView> {
  const res = await fetch("/api/contracts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export interface Decision {
  area: string;
  signedBy: string;
  signed: boolean;
  reason?: string;
}

export async function decide(contractId: string, decision: Decision): Promise<ContractView> {
  const res = await fetch(`/api/contracts/${contractId}/signatures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decision),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function getContract(contractId: string): Promise<ContractView | null> {
  const res = await fetch(`/api/contracts/${contractId}`);
  return res.ok ? res.json() : null;
}

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw await failure(res);
  return res.json();
}
