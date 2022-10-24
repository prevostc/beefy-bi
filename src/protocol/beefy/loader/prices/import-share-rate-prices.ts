import { PoolClient } from "pg";
import * as Rx from "rxjs";
import { Chain } from "../../../../types/chain";
import { rootLogger } from "../../../../utils/logger";
import { ProgrammerError } from "../../../../utils/programmer-error";
import { excludeNullFields$ } from "../../../../utils/rxjs/utils/exclude-null-field";
import { fetchBlockDatetime$ } from "../../../common/connector/block-datetime";
import { addCoveringBlockRangesQuery } from "../../../common/connector/import-queries";
import { fetchPriceFeedContractCreationInfos } from "../../../common/loader/fetch-product-creation-infos";
import { DbProductInvestmentImportState, DbProductShareRateImportState, fetchImportState$ } from "../../../common/loader/import-state";
import { DbPriceFeed } from "../../../common/loader/price-feed";
import { upsertPrice$ } from "../../../common/loader/prices";
import { fetchProduct$ } from "../../../common/loader/product";
import { ImportCtx } from "../../../common/types/import-context";
import { ImportRangeQuery, ImportRangeResult } from "../../../common/types/import-query";
import { createHistoricalImportPipeline } from "../../../common/utils/historical-recent-pipeline";
import { fetchBeefyPPFS$ } from "../../connector/ppfs";
import { isBeefyBoost, isBeefyGovVault } from "../../utils/type-guard";

const logger = rootLogger.child({ module: "beefy", component: "share-rate-import" });

export function importBeefyHistoricalShareRatePrices$(options: { client: PoolClient; chain: Chain; forceCurrentBlockNumber: number | null }) {
  return createHistoricalImportPipeline<DbPriceFeed, number, DbProductShareRateImportState>({
    client: options.client,
    chain: options.chain, // unused
    logInfos: { msg: "Importing historical share rate prices", data: { chain: options.chain } },
    getImportStateKey: (priceFeed) => `price:feed:${priceFeed.priceFeedId}`,
    isLiveItem: (target) => target.priceFeedData.active,
    createDefaultImportState$: (ctx) =>
      Rx.pipe(
        // find the first date we are interested in
        // so we need the first creation date of each product
        fetchPriceFeedContractCreationInfos({
          ctx: {
            ...ctx,
            emitErrors: (item) => {
              logger.error({ msg: "Error while fetching price feed contract creation infos. ", data: item });
              throw new Error("Error while fetching price feed creation infos. " + item.priceFeedId);
            },
          },
          importStateType: "product:investment",
          which: "price-feed-1", // we work on the first applied price
          productType: "beefy:vault",
          getPriceFeedId: (item) => item.priceFeedId,
          formatOutput: (item, contractCreationInfo) => ({ ...item, contractCreationInfo }),
        }),

        // drop those without a creation info
        excludeNullFields$("contractCreationInfo"),

        Rx.map((item) => ({
          type: "product:share-rate",
          priceFeedId: item.priceFeedId,
          chain: item.contractCreationInfo.chain,
          productId: item.contractCreationInfo.productId,
          chainLatestBlockNumber: 0,
          contractCreatedAtBlock: item.contractCreationInfo.contractCreatedAtBlock,
          contractCreationDate: item.contractCreationInfo.contractCreationDate,
          ranges: {
            lastImportDate: new Date(),
            coveredRanges: [],
            toRetry: [],
          },
        })),
      ),
    generateQueries$: (ctx) =>
      Rx.pipe(
        // fetch the parent import state
        fetchImportState$({
          client: ctx.client,
          streamConfig: ctx.streamConfig,
          getImportStateKey: (item) => `product:investment:${item.importState.importData.productId}`,
          formatOutput: (item, parentImportState: DbProductInvestmentImportState | null) => ({ ...item, parentImportState }),
        }),
        excludeNullFields$("parentImportState"),

        addCoveringBlockRangesQuery({
          ctx: {
            ...ctx,
            emitErrors: (item) => {
              logger.error({ msg: "Error while adding covering block ranges", data: item });
              throw new Error("Error while adding covering block ranges");
            },
          },
          chain: options.chain,
          forceCurrentBlockNumber: options.forceCurrentBlockNumber,
          getImportState: (item) => item.importState,
          getParentImportState: (item) => item.parentImportState,
          formatOutput: (_, latestBlockNumber, blockRanges) => blockRanges.map((range) => ({ range, latest: latestBlockNumber })),
        }),
      ),
    processImportQuery$: (ctx) => processShareRateQuery$({ ctx }),
  });
}

function processShareRateQuery$<
  TObj extends ImportRangeQuery<DbPriceFeed, number> & { importState: DbProductShareRateImportState },
  TCtx extends ImportCtx<TObj>,
>(options: { ctx: TCtx }): Rx.OperatorFunction<TObj, ImportRangeResult<DbPriceFeed, number>> {
  return Rx.pipe(
    // get the midpoint of the range
    Rx.map((item) => ({ ...item, rangeMidpoint: Math.floor((item.range.from + item.range.to) / 2) })),

    fetchProduct$({
      ctx: options.ctx,
      getProductId: (item) => item.importState.importData.productId,
      formatOutput: (item, product) => ({ ...item, product }),
    }),

    fetchBeefyPPFS$({
      ctx: options.ctx,
      getPPFSCallParams: (item) => {
        if (isBeefyBoost(item.product)) {
          throw new ProgrammerError("beefy boost do not have ppfs");
        }
        if (isBeefyGovVault(item.product)) {
          throw new ProgrammerError("beefy gov vaults do not have ppfs");
        }
        const vault = item.product.productData.vault;
        return {
          underlyingDecimals: vault.want_decimals,
          vaultAddress: vault.contract_address,
          vaultDecimals: vault.token_decimals,
          blockNumber: item.rangeMidpoint,
        };
      },
      formatOutput: (item, ppfs) => ({ ...item, ppfs }),
    }),

    // add block datetime
    fetchBlockDatetime$({
      ctx: options.ctx,
      getBlockNumber: (item) => item.rangeMidpoint,
      formatOutput: (item, blockDatetime) => ({ ...item, blockDatetime }),
    }),

    upsertPrice$({
      ctx: options.ctx,
      getPriceData: (item) => ({
        datetime: item.blockDatetime,
        blockNumber: item.rangeMidpoint,
        priceFeedId: item.target.priceFeedId,
        price: item.ppfs,
        priceData: { from: "ppfs-snapshots", query: { range: item.range, midPoint: item.rangeMidpoint, latest: item.latest } },
      }),
      formatOutput: (priceData, price) => ({ ...priceData, price }),
    }),

    // transform to result
    Rx.map((item) => ({ ...item, success: true })),
  );
}
