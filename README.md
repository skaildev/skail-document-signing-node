# skail document signing (Node.js)

[Português (Brasil)](README.pt-BR.md)

An app with a skail function that sends a contract to Legal and Finance at the same time and waits for both signatures, in any order, until a deadline. The second signature archives the contract. A refusal cancels it at once, without waiting for the other area, and the deadline expires it; in both cases the signature already given is revoked and the pending request is withdrawn. You play the two areas on a page the app serves at http://localhost:8080.

It shows three skail features:

- **external events**: one event per area, correlated by the contract id;
- the **wait with a deadline**: the signatures or the deadline, whichever comes first. The deadline is 2 minutes here and days in a real contract, with the same code;
- **durability**: close the app while the contract waits, start it again and the contract goes on, with the signatures already given and the same deadline.

## Requirements

- One of: [Docker](https://docs.docker.com/get-docker/), [Podman](https://podman.io/docs/installation) or [Node.js](https://nodejs.org) 20.12 or newer. The run script uses the first one it finds.
- A skail environment with a workload registered for the `SKAIL_WORKLOAD` in `.env` (`documentsigning:v1.0.0` by default). The [Quickstart](https://docs.skail.dev/comece-aqui/quickstart) shows how to create the account, the environment and the workload.

The project uses `@skail/runtime` and `@skail/build` **2.0.1-rc4**.

## Run

```bash
cp .env.example .env  # fill in SKAIL_SIDECAR, SKAIL_NAMESPACE and SKAIL_KEY (portal > Environments & keys > Connect)
scripts/run.sh        # then open http://localhost:8080
```

On Windows, in PowerShell: `copy .env.example .env`, then `powershell -ExecutionPolicy Bypass -File scripts\run.ps1` with the same arguments. The script works on the Windows PowerShell built into Windows; PowerShell 7 is not needed.

The script runs the demo with what the machine has: Docker, then Podman, then Node.js. If it finds none of them, it says what to install. Without the script, the commands are `npm install`, `npm run build` and `npm start` (with the arguments after `--`, as in `npm start -- <argument>`).

![The demo page](docs/page.png)

Each step the commands take shows up on the page, under **What happened**, and in the console. The buttons send the events to the run, and the page refreshes itself every second.

## The paths

| What you click | What happens | Result |
|---|---|---|
| **Send contract for signature**, then **Sign** in both cards, in any order | archived when the second signature arrives | `archived ARC-…` |
| **Refuse** as Legal | cancelled at once, and the Finance request is withdrawn | `cancelled` |
| **Sign** as Legal, then **Refuse** as Finance | cancelled, and the Legal signature is revoked | `cancelled` |
| **Sign** as Finance, then nothing for 2 minutes | the deadline passes: the Finance signature is revoked and the Legal request withdrawn | `expired` |
| nothing for 2 minutes | both requests are withdrawn | `expired` |

## How it works

The app does three jobs in one process: it serves the page, it hosts the worker that runs the function (`createSkailPlatform`, with the bundle built by `npm run build`), and it sends the contract and turns the buttons into the signature events, through the skail HTTP API. The commands report each step to a timeline the page shows (over local HTTP, because the commands run in an isolated VM):

```http
POST {SKAIL_SIDECAR}/api/v1/trigger/documentsigning/v1.0.0/SignContract/{contractId}
["{contractId}", "Service agreement", 120]

POST {SKAIL_SIDECAR}/api/v1/fire/LEGAL_SIGNATURE/{contractId}
{"area": "legal", "signed": true, "by": "Legal team", "reason": null, "at": "2026-11-17T16:02:11.000Z"}
```

The function, in [`src/contract-functions.ts`](src/contract-functions.ts):

```ts
@SkailFunction()
async SignContract(contractId: string, title: string, deadlineSeconds: number): Promise<string> {
  await this.RequestSignature(contractId, title, Areas.legal);
  await this.RequestSignature(contractId, title, Areas.finance);

  const legal = Skail.waitForEvent<Signature>(Events.legalSignature, contractId);
  const finance = Skail.waitForEvent<Signature>(Events.financeSignature, contractId);
  const deadline = Skail.delaySeconds(deadlineSeconds);

  // whenAny returns the value of the winner: the signature, with the area that answered, or undefined for the deadline
  const first = await Skail.whenAny([legal, finance, deadline]);
  if (!isSignature(first)) return this.ExpireContract(contractId, null);
  if (!first.signed) return this.CancelContract(contractId, first, false);

  const second = await Skail.whenAny([first.area === Areas.legal ? finance : legal, deadline]);
  if (!isSignature(second)) return this.ExpireContract(contractId, first);
  if (!second.signed) return this.CancelContract(contractId, second, true);

  return this.ArchiveContract(contractId, first, second);
}
```

- The two waits and the deadline are created once and reused, so both areas share one deadline.
- `whenAny` returns the value of the winner: the signature, with the area that answered, or `undefined` when the deadline wins.
- `CancelContract` and `ExpireContract` are the compensation: the signature already given is revoked and the pending request withdrawn. They are commands, so if the app stops in the middle, they do not run twice.
- The commands only print what would happen in the signature and archive systems.

| File | What it has |
|---|---|
| `src/contract-functions.ts` | The function and its commands. |
| `src/model.ts` | The areas, the event names and the signature (the payload of the event). |
| `src/main.ts` | Reads `.env` and the argument, serves the page and its API, and hosts the worker. |
| `src/contract-desk.ts` | Sends the contract and turns each button into the area's event. |
| `src/timeline.ts` | The timeline of the steps, for the console and the page. |
| `page/index.html` | The page, with the skail branding. |
| `src/skail-api.ts` | Trigger and fire through the skail HTTP API. |
| `src/skail-functions.ts` | Entry point of the skail bundle. |
| `scripts/build-skail.mjs` | Builds the bundle into `.skail/` for `SKAIL_WORKLOAD`; run `npm run build` again if it changes. |
| `scripts/run.sh`, `scripts/run.ps1`, `Dockerfile` | Run the demo with Docker, Podman or Node.js, whatever the machine has. |

## See the durability

1. Run `scripts/run.sh`, open the page, send a contract and click **Sign** as Finance. The contract waits for Legal.
2. Press **Ctrl+C**. The app closes; the contract stays in skail, with the Finance signature and the deadline.
3. Start the app again with the contract id shown on the page and in the console: `scripts/run.sh <contract id>`. With an id, the app sends no new contract: it only hosts the worker again and follows that contract.
4. Open the page and click **Sign** as Legal. The contract is archived with both signatures. If you wait more than 2 minutes instead, it expires even while the app is closed: the deadline is a durable delay in skail, which holds no thread or process.

In the portal, open the [Monitor](https://docs.skail.dev/referencia/portal/monitor) of your environment and click the run: it lists the two `RequestSignature`, the waits for `LEGAL_SIGNATURE` and `FINANCE_SIGNATURE` with the `Delay` of the deadline, and the command that ended the contract.

## Notes

- Apps running the same `SKAIL_WORKLOAD` on the same environment share the same runs: use one workload (or environment) per person.

## Disclaimer

**This is a demo, not production code.** It exists only to show how [skail](https://docs.skail.dev) works and is provided "as is", without warranty of any kind. The signatures are simulated and have no legal value.

## License

[Apache-2.0](LICENSE)
