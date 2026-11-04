# skail document signing (Node / TypeScript + React)

[Português (Brasil)](README.pt-BR.md)

A skail function sends a contract to Legal and Finance at the same time and waits for both signatures, in any order, until a deadline. The second signature archives the contract. A refusal cancels it at once, without waiting for the other area, and the deadline expires it; in both cases the signature already given is revoked and the pending request is withdrawn. The deadline is 2 minutes in this demo and days in a real contract, with the same code. A React page sends the contract and has **Sign** and **Refuse** buttons for each area.

The demo covers three topics of the [skail docs](https://docs.skail.dev) (in Portuguese):

- [external events](https://docs.skail.dev/construa/conceitos/eventos-externos-e-correlacao): one event per area, correlated by the contract id;
- the [wait with a deadline](https://docs.skail.dev/construa/como-fazer/esperar-um-evento-com-prazo) pattern: the signatures or the deadline, whichever comes first;
- [human-in-the-loop](https://docs.skail.dev/construa/como-fazer/padroes-e-antipadroes/human-in-the-loop), with two areas deciding in parallel.

## How it works

```mermaid
flowchart LR
    browser[Browser] -- "HTTP + SSE" --> web
    web -- "trigger / fire<br/>SKAIL_BASE_URL" --> skail[skail]
    worker -- "pulls work<br/>SKAIL_SIDECAR" --> skail
    worker -- "POST /internal/contracts/{id}/events" --> web
```

- **worker** (`apps/worker`): the function `SignContract(contractId, title, deadlineSeconds)` and its commands. `RequestSignature` asks an area to sign; `ArchiveContract`, `CancelContract` and `ExpireContract` end the contract; `ReportStatus` tells the page how the run is going. The commands delegate to `ContractOperations`, so their logic is tested without skail.
- **web** (`apps/web`): API and static files. It starts the run (trigger), records each area's decision and sends it to the run (fire), keeps the state in memory and streams it to the page (SSE).
- **frontend** (`apps/frontend`): the page, in React 18, Vite and TypeScript.
- **contracts** (`apps/contracts`): types, constants and pure rules shared by the other three. It also goes into the skail bundle, so it has no Node I/O imports.

The function only orchestrates and leaves the I/O to the commands. It creates the two waits and the deadline once and uses the same deadline in both `whenAny`, so the two areas share one deadline. In TypeScript, `whenAny` returns the value of the winner, and a delay that wins returns `undefined` (see [SDKs and languages](https://docs.skail.dev/referencia/sdk-typescript-e-outras-linguagens)). Simplified from [`contract-functions.ts`](apps/worker/src/contract-functions.ts), which also reports each stage to the page:

```ts
await this.RequestSignature(contractId, title, Areas.legal);
await this.RequestSignature(contractId, title, Areas.finance);
const legal = Skail.waitForEvent<Signature>(Events.legalSignature, contractId);
const finance = Skail.waitForEvent<Signature>(Events.financeSignature, contractId);
const deadline = Skail.delaySeconds(deadlineSeconds);

const first = await Skail.whenAny([legal, finance, deadline]);
if (!isSignature(first)) return await this.ExpireContract(contractId, null);
if (!first.signed) return await this.CancelContract(contractId, first, false);

const second = await Skail.whenAny([first.area === Areas.legal ? finance : legal, deadline]);
if (!isSignature(second)) return await this.ExpireContract(contractId, first);
if (!second.signed) return await this.CancelContract(contractId, second, true);

return await this.ArchiveContract(contractId, first, second);
```

`isSignature` tells a signature from the `undefined` of the deadline by the shape of the object. The web app sets `area` from the validated request, so the function knows which area answered first.

`CancelContract` and `ExpireContract` are the compensation: a signature already given is revoked and a pending request is withdrawn. Both are commands, so if the worker stops in the middle, the run continues from them without asking the areas again.

## The paths

The page has a **Send for signature** button and one card per area, with **Sign** and **Refuse**. The deadline is 2 minutes.

| What you do | What happens | Result |
|---|---|---|
| **Sign** as Finance, then as Legal | archived when the second signature arrives, in any order | **Archived**, with a reference `ARC-…` |
| **Refuse** as Legal | cancelled at once, and the Finance request is withdrawn | **Cancelled** |
| **Sign** as Legal, then **Refuse** as Finance | cancelled, and the Legal signature is revoked | **Cancelled** |
| **Sign** as Finance, then nothing for 2 minutes | the deadline expires the contract: the Finance signature is revoked and the Legal request withdrawn | **Expired** |
| nothing for 2 minutes | both requests are withdrawn | **Expired** |

A second decision from the same area, or a decision after the end, gets `409`. The first decision wins, and no second event is sent. The countdown on the page is only visual: the real deadline is the durable delay in skail, which holds no thread or process.

## How it connects to skail

| Service | Variable | Used for |
|---|---|---|
| worker | `SKAIL_SIDECAR` | Connects the function to your environment and receives its work. |
| web | `SKAIL_BASE_URL` | Starts runs and sends the signatures through the skail HTTP API. |

Both use the same `SKAIL_WORKLOAD`, `SKAIL_NAMESPACE` and `SKAIL_KEY`. The web app makes two calls:

```http
POST {SKAIL_BASE_URL}/api/v1/trigger/{name}/{version}/SignContract/{contractId}
["{contractId}", "Service agreement", 120]

POST {SKAIL_BASE_URL}/api/v1/fire/LEGAL_SIGNATURE/{contractId}
{"area": "legal", "signed": true, "by": "Ana", "reason": null, "at": "2026-11-04T10:00:00.000Z"}
```

The event name comes from the area: `LEGAL_SIGNATURE` or `FINANCE_SIGNATURE`. `{name}` and `{version}` come from `SKAIL_WORKLOAD` (`name:version`). Each call sends the key in `skail-key` and in `Authorization: Bearer`, plus the `Skail-namespace` header, as described in [authentication](https://docs.skail.dev/referencia/api-http/autenticacao). `429`, `5xx` and network errors are retried with the same contract id. `401` and `403` are not retried: check `SKAIL_KEY` and `SKAIL_NAMESPACE`.

The last number of the trigger is the deadline, in seconds. It is an argument of the function, so it goes into the run history and stays fixed for that run. The web app reads it from `SIGNATURE_DEADLINE_SECONDS` (120 by default); use `604800` for 7 days.

The browser never calls skail. It only talks to the web app, so the key stays on the server.

## Requirements

- Node 20, 22 or 24 and pnpm 10 (`npm i -g pnpm@10.34.7`)
- podman or docker
- PowerShell 7+ (`pwsh`), only if you use `scripts/run.ps1` instead of `scripts/run.sh`
- A skail environment with the workload from `SKAIL_WORKLOAD` registered (`documentsigning:v1.0.0` by default). The [Quickstart](https://docs.skail.dev/comece-aqui/quickstart) shows how to get an account, create the environment and register the workload.
- Access to the public npm registry, where `@skail/runtime`, `@skail/testing` (2.0.1-rc1) and `@skail/build` (2.0.0) come from.
- A current browser (Chrome/Edge 111+, Firefox 113+, Safari 16.2+). The page uses Server-Sent Events and CSS `color-mix()`.

## Configure

```bash
cp .env.example .env     # .env holds the key and is ignored by git
```

Fill in `SKAIL_WORKLOAD` (exactly as registered in the portal), `SKAIL_NAMESPACE`, `SKAIL_KEY`, `SKAIL_SIDECAR` and `SKAIL_BASE_URL` with the values of your environment.

The skail bundle cannot read environment variables, so the worker gets `SKAIL_WORKLOAD`, `WEB_BASE_URL` and `NOTIFY_PROVIDER` when it is built ([`gen-config.mjs`](apps/worker/scripts/gen-config.mjs)). After changing them in `.env`, build again; `scripts/run.sh up` does it. The deadline belongs to the web app, so changing it only needs a restart of the web app.

## Run with podman or docker

```bash
scripts/run.sh up        # builds both images and starts web + worker
scripts/run.sh logs
scripts/run.sh down
```

`CONTAINER_ENGINE=docker` forces docker. On Windows, or anywhere with PowerShell 7+, run `pwsh scripts/run.ps1 <command>` with the same commands; `$env:CONTAINER_ENGINE = "docker"` forces docker.

Open <http://localhost:8080> and press **Send for signature**.

### See the durability

Do these steps within the 2-minute deadline.

1. Press **Send for signature**, then **Sign** as Finance. The badge shows **Waiting for Legal**.
2. Run `scripts/run.sh kill-worker`. It kills the worker with SIGKILL, like a crash; the web app keeps the page state.
3. Run `scripts/run.sh start-worker`, then **Sign** as Legal.
4. The contract is **Archived**. The Finance signature from before the crash counts, and no area is asked again.

In the portal, open the [Monitor](https://docs.skail.dev/referencia/portal/monitor) of your environment and search for the contract id. The run lists `ReportStatus`, one `RequestSignature` per area, a `WhenAny` with a `WaitForEvent` and the `Delay` of the deadline, a second `WhenAny` with the `WaitForEvent` of the other area, and the command that ended the contract. The `Delay` shows up once, inside the first `WhenAny`, because the function creates the deadline once and reuses it, and it shows its full duration even when the contract ended earlier. In an archived run, **E2E Duration** was 3.6 s and **Duration** was 555 ms, because the waits do not use the worker. Every path ends as **Completed**, because the function returns normally; its result says how the contract ended (`end: "Expired"`, for example).

## VS Code

Open the folder and accept the recommended extensions.

- `Ctrl+Shift+B` builds, the *test* task runs the tests and the `containers: up/down/logs/kill-worker/start-worker` tasks call `scripts/run.sh`.
- The **Worker + Web** debug configuration starts both apps reading `.env`, and a breakpoint inside a command works. Its build task bakes `WEB_BASE_URL=http://localhost:8080` into the bundle, because outside containers the web app is on `localhost`.
- For the page with hot reload, run the `dev: front end (vite)` task. It forwards `/api` to the web app on port 8080.

## Tests

```bash
pnpm install
pnpm test
```

The unit tests cover the contracts, the operations behind the commands, the function in memory with `@skail/testing` (both orders, a refusal first and second, expiry with no answer and with one signature, a decision sent before the wait starts, a retry and one request per area), the `skail build` of the worker, the contract store (free order, one decision per area, expiry, undo when the event could not be sent), the calls to skail (trigger and fire), the web API with SSE and the React page. They need neither network nor skail.

## Notes

- After a cancellation or an expiry, the waits that did not finish stay without an answer on purpose, and the web app refuses new decisions with `409`. An event sent straight to the skail API does not pass through that check.
- The contract state lives in the memory of the web app. Restarting it loses the page history; the contract keeps running in skail, but the web app ignores the progress of contracts it does not know.
- "Signed by" is free text: there is no authentication, cryptographic signature or real document. The `POST /internal/contracts/{id}/events` route, which the worker calls, has no authentication either. That is fine for a local demo; protect both before using the pattern in production.
- Workers with the same `SKAIL_WORKLOAD` on the same environment share the same runs: use one workload (or environment) per person.

## License

[Apache-2.0](LICENSE)
