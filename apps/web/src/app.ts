import { randomUUID } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  Areas,
  ContractLimits,
  isTerminalPhase,
  type AppConfig,
  type Signature,
  type ContractEvent,
  type ContractState,
  type ContractView,
} from "@skail-document-signing/contracts";
import type { ContractStore } from "./contract-store.js";
import { SkailGatewayError, type SkailGateway } from "./gateway.js";

export interface AppOptions {
  store: ContractStore;
  gateway: SkailGateway;
  /** Optional link to the skail Monitor (MONITOR_URL), shown by the page. */
  monitorUrl?: string | null;
  /** Time both areas have to answer (SIGNATURE_DEADLINE_SECONDS); the function receives it as an argument. */
  deadlineSeconds?: number;
  /** Directory with the built front end (index.html + assets). Optional: tests do not need it. */
  staticDir?: string;
}

export function toView(contract: ContractState): ContractView {
  return { ...contract, active: !isTerminalPhase(contract.phase) };
}

interface SignBody {
  area?: unknown;
  signedBy?: unknown;
  signed?: unknown;
  reason?: unknown;
}

export function createApp({
  store,
  gateway,
  monitorUrl = null,
  deadlineSeconds = ContractLimits.defaultDeadlineSeconds,
  staticDir,
}: AppOptions): FastifyInstance {
  const app = fastify();

  app.get("/healthz", async () => "ok");

  app.get("/api/config", async (): Promise<AppConfig> => ({
    defaultTitle: ContractLimits.defaultTitle,
    monitorUrl: monitorUrl || null,
  }));

  app.post<{ Body: { title?: unknown } | null }>("/api/contracts", async (request, reply) => {
    const raw = request.body?.title;
    const title = typeof raw === "string" && raw.trim() ? raw.trim() : ContractLimits.defaultTitle;
    if (title.length > ContractLimits.maxTitleLength) {
      return reply.code(400).send({ error: `The title can have at most ${ContractLimits.maxTitleLength} characters` });
    }

    const contractId = randomUUID();
    const contract = store.create(contractId, title, deadlineSeconds);
    try {
      await gateway.trigger(contractId, title, deadlineSeconds);
    } catch (error) {
      store.remove(contractId);
      return reply.code(502).send({ error: messageOf(error) });
    }
    return toView(store.get(contractId) ?? contract);
  });

  app.get<{ Params: { id: string } }>("/api/contracts/:id", async (request, reply) => {
    const contract = store.get(request.params.id);
    return contract ? toView(contract) : reply.code(404).send();
  });

  // An area's decision: registered here (first one wins) and fired to the function's waitForEvent.
  app.post<{ Params: { id: string }; Body: SignBody | null }>(
    "/api/contracts/:id/signatures",
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? {};
      if (!Areas.isValid(body.area)) {
        return reply.code(400).send({ error: `Unknown area. Use '${Areas.legal}' or '${Areas.finance}'` });
      }

      const area = body.area;
      const signed = body.signed !== false;
      const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      const signature: Signature = {
        area, // set here, from the validated route data: the function tells the winner of whenAny by it
        signed,
        by: text(body.signedBy) ?? `${Areas.label(area)} team`,
        reason: signed ? null : text(body.reason),
        at: new Date().toISOString(),
      };

      switch (store.tryDecide(id, signature)) {
        case "NotFound":
          return reply.code(404).send();
        case "Duplicate":
          return reply.code(409).send({ error: `${Areas.label(area)} already answered this contract` });
        case "Finished":
          return reply.code(409).send({ error: "The contract is already finished" });
      }

      try {
        await gateway.fireSignature(id, signature);
      } catch (error) {
        store.release(id, area); // not delivered: the area can try again
        return reply.code(502).send({ error: messageOf(error) });
      }
      return toView(store.get(id)!);
    },
  );

  // called by the worker's commands (ReportStatus, RequestSignature, ArchiveContract, CancelContract)
  app.post<{ Params: { id: string }; Body: ContractEvent }>(
    "/internal/contracts/:id/events",
    async (request, reply) => {
      store.apply({ ...request.body, contractId: request.params.id });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>("/api/contracts/:id/stream", (request, reply) => {
    const { id } = request.params;
    const current = store.get(id);
    if (!current) return reply.code(404).send();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (state: ContractState) => raw.write(`data: ${JSON.stringify(toView(state))}\n\n`);

    // subscribe before sending the snapshot: no update is lost
    const unsubscribe = store.subscribe(id, send, () => raw.end());
    raw.on("close", unsubscribe);
    send(current);
    if (isTerminalPhase(current.phase)) {
      unsubscribe();
      raw.end();
    }
  });

  if (staticDir) app.register(fastifyStatic, { root: staticDir });

  return app;
}

function messageOf(error: unknown): string {
  return error instanceof SkailGatewayError || error instanceof Error ? error.message : String(error);
}
