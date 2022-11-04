import { ethers } from "ethers";
import * as Rx from "rxjs";
import { RpcCallMethod } from "../../../types/rpc-config";
import { LogInfos, mergeLogsInfos, rootLogger } from "../../../utils/logger";
import { ProgrammerError } from "../../../utils/programmer-error";
import { ArchiveNodeNeededError, isErrorDueToMissingDataFromNode } from "../../../utils/rpc/archive-node-needed";
import { RpcLimitations } from "../../../utils/rpc/rpc-limitations";
import { callLockProtectedRpc } from "../../../utils/shared-resources/shared-rpc";
import { ImportCtx } from "../types/import-context";

const logger = rootLogger.child({ module: "utils", component: "batch-rpc-calls" });

export interface BatchStreamConfig {
  // how many items to take from the input stream before making groups
  maxInputTake: number;
  // how long to wait before making groups
  maxInputWaitMs: number;

  // how many items to take from the input stream before making groups
  dbMaxInputTake: number;
  // how long to wait before making groups
  dbMaxInputWaitMs: number;

  // how many concurrent groups to process at the same time
  workConcurrency: number;

  // how long at most to attempt retries
  maxTotalRetryMs: number;
}

export function batchRpcCalls$<TObj, TRes, TQueryObj, TQueryResp>(options: {
  ctx: ImportCtx<TObj>;
  getQuery: (obj: TObj) => TQueryObj;
  processBatch: (
    provider: ethers.providers.JsonRpcProvider | ethers.providers.JsonRpcBatchProvider,
    queryObjs: TQueryObj[],
  ) => Promise<Map<TQueryObj, TQueryResp>>;
  // we are doing this much rpc calls per input object
  // this is used to calculate the input batch to send to the client
  // and to know if we can inject the batch provider or if we should use the regular provider
  rpcCallsPerInputObj: {
    [method in RpcCallMethod]: number;
  };
  logInfos: { msg: string; data?: Record<string, unknown> };
  formatOutput: (objs: TObj, results: TQueryResp) => TRes;
}) {
  const { maxInputObjsPerBatch, canUseBatchProvider } = getBatchConfigFromLimitations({
    maxInputObjsPerBatch: options.ctx.streamConfig.maxInputTake,
    rpcCallsPerInputObj: options.rpcCallsPerInputObj,
    limitations: options.ctx.rpcConfig.rpcLimitations,
    logInfos: options.logInfos,
  });

  return Rx.pipe(
    // add object TS type
    Rx.tap((_: TObj) => {}),

    // take a batch of items
    Rx.bufferTime(options.ctx.streamConfig.maxInputWaitMs, undefined, maxInputObjsPerBatch),
    Rx.filter((objs) => objs.length > 0),

    // for each batch, fetch the transfers
    Rx.concatMap(async (objs) => {
      logger.trace(mergeLogsInfos({ msg: "batchRpcCalls$ - batch", data: { objsCount: objs.length } }, options.logInfos));

      const objAndCallParams = objs.map((obj) => ({ obj, query: options.getQuery(obj) }));

      const provider = canUseBatchProvider ? options.ctx.rpcConfig.batchProvider : options.ctx.rpcConfig.linearProvider;

      const work = async () => {
        logger.trace(mergeLogsInfos({ msg: "Ready to call RPC", data: { chain: options.ctx.chain } }, options.logInfos));

        try {
          const contractCalls = objAndCallParams.map(({ query }) => query);
          const res = await options.processBatch(provider, contractCalls);
          return res;
        } catch (error) {
          if (error instanceof ArchiveNodeNeededError) {
            throw error;
          } else if (isErrorDueToMissingDataFromNode(error)) {
            throw new ArchiveNodeNeededError(options.ctx.chain, error);
          }
          throw error;
        }
      };

      try {
        const resultMap = await callLockProtectedRpc(work, {
          chain: options.ctx.chain,
          provider,
          rpcLimitations: options.ctx.rpcConfig.rpcLimitations,
          logInfos: options.logInfos,
          maxTotalRetryMs: options.ctx.streamConfig.maxTotalRetryMs,
        });

        return objAndCallParams.map(({ obj, query }) => {
          if (!resultMap.has(query)) {
            logger.error(mergeLogsInfos({ msg: "result not found", data: { chain: options.ctx.chain, obj, query, resultMap } }, options.logInfos));
            throw new ProgrammerError(
              mergeLogsInfos({ msg: "result not found", data: { chain: options.ctx.chain, obj, query, resultMap } }, options.logInfos),
            );
          }
          const res = resultMap.get(query) as TQueryResp;
          return options.formatOutput(obj, res);
        });
      } catch (err) {
        // here, none of the retrying worked, so we emit all the objects as in error
        logger.error(mergeLogsInfos({ msg: "Error doing batch rpc work", data: { chain: options.ctx.chain, err } }, options.logInfos));
        logger.error(err);
        for (const obj of objs) {
          options.ctx.emitErrors(obj);
        }
        return Rx.EMPTY;
      }
    }),

    Rx.tap(
      (objs) =>
        Array.isArray(objs) &&
        logger.trace(mergeLogsInfos({ msg: "batchRpcCalls$ - done", data: { chain: options.ctx.chain, objsCount: objs.length } }, options.logInfos)),
    ),

    // flatten
    Rx.mergeAll(),
  );
}

function getBatchConfigFromLimitations(options: {
  maxInputObjsPerBatch: number;
  rpcCallsPerInputObj: {
    [method in RpcCallMethod]: number;
  };
  limitations: RpcLimitations;
  logInfos: LogInfos;
}) {
  // get the rpc provider maximum batch size
  const methodLimitations = options.limitations.methods;

  // find out the max number of objects to process in a batch
  let canUseBatchProvider = true;
  let maxInputObjsPerBatch = options.maxInputObjsPerBatch;
  for (const [method, count] of Object.entries(options.rpcCallsPerInputObj)) {
    // we don't use this method so we don't care
    if (count <= 0) {
      continue;
    }
    const maxCount = methodLimitations[method as RpcCallMethod];
    if (maxCount === null) {
      canUseBatchProvider = false;
      logger.trace(mergeLogsInfos({ msg: "disabling batch provider since limitation is null", data: { method } }, options.logInfos));
      break;
    }
    const newMax = Math.min(maxInputObjsPerBatch, Math.floor(maxCount / count));
    logger.trace(
      mergeLogsInfos(
        { msg: "updating maxInputObjsPerBatch with provided count per item", data: { old: maxInputObjsPerBatch, new: newMax } },
        options.logInfos,
      ),
    );
    maxInputObjsPerBatch = newMax;
  }

  if (!canUseBatchProvider) {
    // do some amount of concurrent rpc calls for RPCs without rate limiting but without batch provider active
    if (options.limitations.minDelayBetweenCalls === "no-limit") {
      const newMax = Math.max(1, Math.floor(options.maxInputObjsPerBatch / 10));
      logger.trace(
        mergeLogsInfos(
          { msg: "updating maxInputObjsPerBatch since RPC is in no-limit mode", data: { old: maxInputObjsPerBatch, new: newMax } },
          options.logInfos,
        ),
      );
      maxInputObjsPerBatch = newMax;
    } else {
      logger.trace(
        mergeLogsInfos({ msg: "setting maxInputObjsPerBatch to 1 since we disabled batching", data: { maxInputObjsPerBatch } }, options.logInfos),
      );
      maxInputObjsPerBatch = 1;
    }
  }
  logger.debug(mergeLogsInfos({ msg: "config", data: { maxInputObjsPerBatch, canUseBatchProvider, methodLimitations } }, options.logInfos));

  return { maxInputObjsPerBatch, canUseBatchProvider };
}
