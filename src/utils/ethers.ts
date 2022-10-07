import * as ethers from "ethers";
import { rootLogger } from "./logger";
import { fetchJson } from "@ethersproject/web";
import { deepCopy } from "@ethersproject/properties";
import { removeSecretsFromRpcUrl } from "./rpc/remove-secrets-from-rpc-url";

const logger = rootLogger.child({ module: "utils", component: "ethers" });

export function normalizeAddress(address: string) {
  // special case to avoid ethers.js throwing an error
  // Error: invalid address (argument="address", value=Uint8Array(0x0000000000000000000000000000000000000000), code=INVALID_ARGUMENT, version=address/5.6.1)
  if (address === "0x0000000000000000000000000000000000000000") {
    return address;
  }
  return ethers.utils.getAddress(address);
}

export function addDebugLogsToProvider(provider: ethers.providers.JsonRpcProvider | ethers.providers.JsonRpcBatchProvider) {
  const safeToLogUrl = removeSecretsFromRpcUrl(provider.connection.url);
  provider.on(
    "debug",
    (
      event:
        | { action: "request"; request: any }
        | {
            action: "requestBatch";
            request: any;
          }
        | {
            action: "response";
            request: any;
            response: any;
          }
        | {
            action: "response";
            error: any;
            request: any;
          },
    ) => {
      if (event.action === "request" || event.action === "requestBatch") {
        logger.trace({ msg: "RPC request", data: { request: event.request, rpcUrl: safeToLogUrl } });
      } else if (event.action === "response" && "response" in event) {
        logger.trace({ msg: "RPC response", data: { request: event.request, response: event.response, rpcUrl: safeToLogUrl } });
      } else if (event.action === "response" && "error" in event) {
        logger.error({ msg: "RPC error", data: { request: event.request, error: event.error, rpcUrl: safeToLogUrl } });
      }
    },
  );
}

// until this is fixed: https://github.com/ethers-io/ethers.js/issues/2749#issuecomment-1268638214
export function monkeyPatchEthersBatchProvider(provider: ethers.providers.JsonRpcBatchProvider) {
  logger.trace({ msg: "Patching ethers batch provider" });
  const _send = provider.send;

  function fixedBatchSend(this: typeof provider, method: string, params: Array<any>): Promise<any> {
    const request = {
      method: method,
      params: params,
      id: this._nextId++,
      jsonrpc: "2.0",
    };

    if (this._pendingBatch == null) {
      this._pendingBatch = [];
    }

    const inflightRequest: any = { request, resolve: null, reject: null };

    const promise = new Promise((resolve, reject) => {
      inflightRequest.resolve = resolve;
      inflightRequest.reject = reject;
    });

    this._pendingBatch.push(inflightRequest);

    if (!this._pendingBatchAggregator) {
      // Schedule batch for next event loop + short duration
      this._pendingBatchAggregator = setTimeout(() => {
        // Get teh current batch and clear it, so new requests
        // go into the next batch
        const batch = this._pendingBatch;
        // @ts-ignore
        this._pendingBatch = null;
        // @ts-ignore
        this._pendingBatchAggregator = null;

        // Get the request as an array of requests
        const request = batch.map((inflight) => inflight.request);

        this.emit("debug", {
          action: "requestBatch",
          request: deepCopy(request),
          provider: this,
        });

        return fetchJson(this.connection, JSON.stringify(request))
          .then((result) => {
            this.emit("debug", {
              action: "response",
              request: request,
              response: result,
              provider: this,
            });

            if (!Array.isArray(result)) {
              if (result.error) {
                const error = new Error(result.error.message);
                (error as any).code = result.error.code;
                (error as any).data = result.error.data;
                throw error;
              } else {
                throw new Error("Batch result is not an array");
              }
            }

            // For each result, feed it to the correct Promise, depending
            // on whether it was a success or error
            batch.forEach((inflightRequest, index) => {
              const payload = result[index];
              if (payload.error) {
                const error = new Error(payload.error.message);
                (error as any).code = payload.error.code;
                (error as any).data = payload.error.data;
                inflightRequest.reject(error);
              } else {
                inflightRequest.resolve(payload.result);
              }
            });
          })
          .catch((error) => {
            this.emit("debug", {
              action: "response",
              error: error,
              request: request,
              provider: this,
            });

            batch.forEach((inflightRequest) => {
              inflightRequest.reject(error);
            });
          });
      }, 10);
    }

    return promise;
  }

  provider.send = fixedBatchSend.bind(provider);
}
