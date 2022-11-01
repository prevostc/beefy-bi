import { backOff } from "exponential-backoff";
import { cloneDeep, groupBy, keyBy, uniq } from "lodash";
import * as Rx from "rxjs";
import { Chain } from "../../../types/chain";
import { ConnectionTimeoutError } from "../../../utils/async";
import { DbClient, db_query, db_transaction } from "../../../utils/db";
import { LogInfos, mergeLogsInfos, rootLogger } from "../../../utils/logger";
import { ProgrammerError } from "../../../utils/programmer-error";
import { isDateRange, isNumberRange, Range, rangeMerge, rangeValueMax, SupportedRangeTypes } from "../../../utils/range";
import { ImportCtx } from "../types/import-context";
import { ImportRangeResult } from "../types/import-query";
import { BatchStreamConfig } from "../utils/batch-rpc-calls";
import { hydrateDateImportRangesFromDb, hydrateNumberImportRangesFromDb, ImportRanges, updateImportRanges } from "../utils/import-ranges";

const logger = rootLogger.child({ module: "common-loader", component: "import-state" });

interface DbBaseImportState {
  importKey: string;
}

export interface DbProductInvestmentImportState extends DbBaseImportState {
  importData: {
    type: "product:investment";
    productId: number;
    chain: Chain;
    contractCreatedAtBlock: number;
    contractCreationDate: Date;
    chainLatestBlockNumber: number;
    ranges: ImportRanges<number>;
  };
}
export interface DbOraclePriceImportState extends DbBaseImportState {
  importData: {
    type: "oracle:price";
    priceFeedId: number;
    firstDate: Date;
    ranges: ImportRanges<Date>;
  };
}
export interface DbProductShareRateImportState extends DbBaseImportState {
  importData: {
    type: "product:share-rate";
    priceFeedId: number;
    productId: number;
    chain: Chain;
    contractCreatedAtBlock: number;
    contractCreationDate: Date;
    chainLatestBlockNumber: number;
    ranges: ImportRanges<number>;
  };
}

export type DbBlockNumberRangeImportState = DbProductInvestmentImportState | DbProductShareRateImportState;
export type DbDateRangeImportState = DbOraclePriceImportState;
export type DbImportState = DbBlockNumberRangeImportState | DbDateRangeImportState;

export function isProductInvestmentImportState(o: DbImportState): o is DbProductInvestmentImportState {
  return o.importData.type === "product:investment";
}
export function isOraclePriceImportState(o: DbImportState): o is DbOraclePriceImportState {
  return o.importData.type === "oracle:price";
}
export function isProductShareRateImportState(o: DbImportState): o is DbProductShareRateImportState {
  return o.importData.type === "product:share-rate";
}

function upsertImportState$<TInput, TRes>(options: {
  client: DbClient;
  streamConfig: BatchStreamConfig;
  getImportStateData: (obj: TInput) => DbImportState;
  formatOutput: (obj: TInput, importState: DbImportState) => TRes;
}): Rx.OperatorFunction<TInput, TRes> {
  return Rx.pipe(
    Rx.bufferTime(options.streamConfig.dbMaxInputWaitMs, undefined, options.streamConfig.dbMaxInputTake),
    Rx.filter((items) => items.length > 0),

    // upsert data and map to input objects
    Rx.mergeMap(async (objs) => {
      const objAndData = objs.map((obj) => ({ obj, importStateData: options.getImportStateData(obj) }));

      const results = await db_query<DbImportState>(
        `INSERT INTO import_state (import_key, import_data) VALUES %L
            ON CONFLICT (import_key) 
            -- this may not be the right way to merge our data but it's a start
            DO UPDATE SET import_data = jsonb_merge(import_state.import_data, EXCLUDED.import_data)
            RETURNING import_key as "importKey", import_data as "importData"`,
        [objAndData.map((obj) => [obj.importStateData.importKey, obj.importStateData.importData])],
        options.client,
      );

      const idMap = keyBy(results, "importKey");
      return objAndData.map((obj) => {
        const importState = idMap[obj.importStateData.importKey];
        if (!importState) {
          throw new ProgrammerError({ msg: "Upserted import state not found", data: obj });
        }
        hydrateImportStateRangesFromDb(importState);
        return options.formatOutput(obj.obj, importState);
      });
    }, options.streamConfig.workConcurrency),

    // flatten objects
    Rx.concatMap((objs) => Rx.from(objs)),
  );
}

export function fetchImportState$<TObj, TRes, TImport extends DbImportState>(options: {
  client: DbClient;
  streamConfig: BatchStreamConfig;
  getImportStateKey: (obj: TObj) => string;
  formatOutput: (obj: TObj, importState: TImport | null) => TRes;
}): Rx.OperatorFunction<TObj, TRes> {
  return Rx.pipe(
    Rx.bufferTime(options.streamConfig.dbMaxInputWaitMs, undefined, options.streamConfig.dbMaxInputTake),
    Rx.filter((items) => items.length > 0),

    // upsert data and map to input objects
    Rx.mergeMap(async (objs) => {
      const objAndData = objs.map((obj) => ({ obj, importKey: options.getImportStateKey(obj) }));

      const results = await db_query<TImport>(
        `SELECT 
            import_key as "importKey",
            import_data as "importData"
          FROM import_state
          WHERE import_key IN (%L)`,
        [objAndData.map((obj) => obj.importKey)],
        options.client,
      );

      const idMap = keyBy(results, "importKey");
      return objAndData.map((obj) => {
        const importState = idMap[obj.importKey] ?? null;
        if (importState !== null) {
          hydrateImportStateRangesFromDb(importState);
        }

        return options.formatOutput(obj.obj, importState);
      });
    }, options.streamConfig.workConcurrency),

    // flatten objects
    Rx.concatMap((objs) => Rx.from(objs)),
  );
}

export function updateImportState$<
  TObj,
  TCtx extends ImportCtx<TObj>,
  TRes,
  TImport extends DbImportState,
  TRange extends SupportedRangeTypes,
>(options: {
  ctx: TCtx;
  getRange: (obj: TObj) => Range<TRange>;
  isSuccess: (obj: TObj) => boolean;
  getImportStateKey: (obj: TObj) => string;
  formatOutput: (obj: TObj, importState: TImport) => TRes;
}): Rx.OperatorFunction<TObj, TRes> {
  function mergeImportState(items: TObj[], importState: TImport) {
    const range = options.getRange(items[0]);
    if (
      (isProductInvestmentImportState(importState) && !isNumberRange(range)) ||
      (isOraclePriceImportState(importState) && !isDateRange(range)) ||
      (isProductShareRateImportState(importState) && !isNumberRange(range))
    ) {
      throw new ProgrammerError({
        msg: "Import state is for product investment but item is not",
        data: { importState, item: items[0] },
      });
    }

    const newImportState = cloneDeep(importState);

    // update the import rages
    const coveredRanges = items.map((item) => options.getRange(item));
    const successRanges = rangeMerge(items.filter((item) => options.isSuccess(item)).map((item) => options.getRange(item)));
    const errorRanges = rangeMerge(items.filter((item) => !options.isSuccess(item)).map((item) => options.getRange(item)));
    const lastImportDate = new Date();
    const newRanges = updateImportRanges<TRange>(newImportState.importData.ranges as ImportRanges<TRange>, {
      coveredRanges,
      successRanges,
      errorRanges,
      lastImportDate,
    });
    (newImportState.importData.ranges as ImportRanges<TRange>) = newRanges;

    // update the latest block number we know about
    if (isProductInvestmentImportState(newImportState) || isProductShareRateImportState(newImportState)) {
      newImportState.importData.chainLatestBlockNumber =
        rangeValueMax(
          (items as ImportRangeResult<TObj, number>[]).map((item) => item.latest).concat([newImportState.importData.chainLatestBlockNumber]),
        ) || 0;
    }

    logger.debug({
      msg: "Updating import state",
      data: { successRanges, errorRanges, importState, newImportState },
    });

    return newImportState;
  }

  return Rx.pipe(
    // merge the product import ranges together to call the database less often
    // but flush often enough so we don't go too long before updating the import ranges
    Rx.bufferTime(options.ctx.streamConfig.maxInputWaitMs, undefined, options.ctx.streamConfig.maxInputTake),
    Rx.filter((items) => items.length > 0),

    // update multiple import states at once
    Rx.mergeMap(async (items) => {
      const logInfos: LogInfos = {
        msg: "import-state update transaction",
        data: { importKeys: uniq(items.map((item) => options.getImportStateKey(item))) },
      };
      // we start a transaction as we need to do a select FOR UPDATE
      const work = () =>
        db_transaction(
          async (client) => {
            const dbImportStates = await db_query<TImport>(
              `SELECT import_key as "importKey", import_data as "importData"
            FROM import_state
            WHERE import_key in (%L)
            ORDER BY import_key -- Remove the possibility of deadlocks https://stackoverflow.com/a/51098442/2523414
            FOR UPDATE`,
              [uniq(items.map((item) => options.getImportStateKey(item)))],
              client,
            );

            const dbImportStateMap = keyBy(
              dbImportStates.map((i) => {
                hydrateImportStateRangesFromDb(i);
                return i;
              }),
              "importKey",
            );
            const inputItemsByImportStateKey = groupBy(items, (item) => options.getImportStateKey(item));
            const newImportStates = Object.entries(inputItemsByImportStateKey).map(([importKey, sameKeyInputItems]) => {
              const dbImportState = dbImportStateMap[importKey];
              if (!dbImportState) {
                throw new ProgrammerError({ msg: "Import state not found", data: { importKey, items } });
              }
              return mergeImportState(sameKeyInputItems, dbImportState);
            });

            logger.trace({ msg: "updateImportState$ (merged)", data: newImportStates });
            await Promise.all(
              newImportStates.map((data) =>
                db_query(`UPDATE import_state SET import_data = %L WHERE import_key = %L`, [data.importData, data.importKey], client),
              ),
            );

            logger.trace({ msg: "updateImportState$ (merged) done", data: newImportStates });

            return newImportStates;
          },
          {
            connectTimeoutMs: 5000,
            queryTimeoutMs: 2000 /* this should be a very quick operation */,
            appName: "beefy:import_state:update_transaction",
            logInfos,
          },
        );

      try {
        const newImportStates = await backOff(() => work(), {
          delayFirstAttempt: false,
          startingDelay: 500,
          timeMultiple: 5,
          maxDelay: 1_000,
          numOfAttempts: 10,
          jitter: "full",
          retry: (error) => {
            if (error instanceof ConnectionTimeoutError) {
              logger.error(mergeLogsInfos({ msg: "Connection timeout error, will retry", data: { error } }, logInfos));
              return true;
            }
            return false;
          },
        });

        const resultMap = keyBy(newImportStates, "importKey");

        return items.map((item) => {
          const importKey = options.getImportStateKey(item);
          const importState = resultMap[importKey] ?? null;
          if (!importState) {
            throw new ProgrammerError({ msg: "Import state not found", data: { importKey, items } });
          }
          return options.formatOutput(item, importState);
        });
      } catch (error) {
        if (error instanceof ConnectionTimeoutError) {
          logger.error(mergeLogsInfos({ msg: "Connection timeout error, will not retry, import state not updated", data: { error } }, logInfos));
          for (const item of items) {
            options.ctx.emitErrors(item);
          }
          return [];
        }
        throw error;
      }
    }, options.ctx.streamConfig.workConcurrency),

    // flatten the items
    Rx.concatAll(),
  );
}

export function addMissingImportState$<TInput, TRes, TImport extends DbImportState>(options: {
  client: DbClient;
  streamConfig: BatchStreamConfig;
  getImportStateKey: (obj: TInput) => string;
  createDefaultImportState$: Rx.OperatorFunction<TInput, TImport["importData"]>;
  formatOutput: (obj: TInput, importState: TImport) => TRes;
}): Rx.OperatorFunction<TInput, TRes> {
  const addDefaultImportState$ = Rx.pipe(
    // flatten the input items
    Rx.map(({ obj }: { obj: TInput }) => obj),

    // get the import state from the user
    Rx.concatMap((item) =>
      Rx.of(item).pipe(
        options.createDefaultImportState$,
        Rx.map((defaultImportData) => ({ obj: item, defaultImportData })),
      ),
    ),

    // create the import state in the database
    upsertImportState$({
      client: options.client,
      streamConfig: options.streamConfig,
      getImportStateData: (item) =>
        ({
          importKey: options.getImportStateKey(item.obj),
          importData: item.defaultImportData,
        } as TImport),
      formatOutput: (item, importState) => ({ obj: item.obj, importState }),
    }),
  );

  return Rx.pipe(
    // find the current import state for these objects (if already created)
    fetchImportState$({
      client: options.client,
      streamConfig: options.streamConfig,
      getImportStateKey: options.getImportStateKey,
      formatOutput: (obj, importState) => ({ obj, importState }),
    }),

    Rx.concatMap((item) => {
      if (item.importState !== null) {
        return Rx.of(item).pipe(
          Rx.tap((item) => logger.trace({ msg: "import state present", data: { importKey: options.getImportStateKey(item.obj) } })),
        );
      } else {
        return Rx.of(item).pipe(
          Rx.tap((item) => logger.debug({ msg: "Missing import state", data: { importKey: options.getImportStateKey(item.obj) } })),
          addDefaultImportState$,
        );
      }
    }),

    // fix ts typings
    Rx.filter((item): item is { obj: TInput; importState: TImport } => true),

    Rx.map((item) => options.formatOutput(item.obj, item.importState)),
  );
}

function hydrateImportStateRangesFromDb(importState: DbImportState) {
  const type = importState.importData.type;
  // hydrate dates properly
  if (type === "product:investment") {
    importState.importData.contractCreationDate = new Date(importState.importData.contractCreationDate);
    hydrateNumberImportRangesFromDb(importState.importData.ranges);
  } else if (type === "product:share-rate") {
    importState.importData.contractCreationDate = new Date(importState.importData.contractCreationDate);
    hydrateNumberImportRangesFromDb(importState.importData.ranges);
  } else if (type === "oracle:price") {
    importState.importData.firstDate = new Date(importState.importData.firstDate);
    hydrateDateImportRangesFromDb(importState.importData.ranges);
  } else {
    throw new ProgrammerError(`Unknown import state type ${type}`);
  }
}
