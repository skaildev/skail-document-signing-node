import type { Provider } from "@skail/runtime";
import { ContractFunctions } from "./contract-functions.js";
import { buildConfig } from "./build-config.generated.js";
import { ContractOperations } from "./contract-operations.js";
import { FakeProgressNotifier, HttpProgressNotifier } from "./web.js";

// The skail bundle cannot read environment variables: these settings are fixed at build time (gen-config.mjs).
export const providers: Provider[] = [
  {
    token: ContractFunctions,
    useFactory: () =>
      new ContractFunctions(
        new ContractOperations(
          buildConfig.notifyProvider === "fake"
            ? new FakeProgressNotifier()
            : new HttpProgressNotifier(buildConfig.webBaseUrl),
        ),
      ),
  },
];
