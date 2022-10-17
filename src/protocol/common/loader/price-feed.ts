import { keyBy, uniqBy } from "lodash";
import { PoolClient } from "pg";
import * as Rx from "rxjs";
import { db_query } from "../../../utils/db";
import { rootLogger } from "../../../utils/logger";
import { ProgrammerError } from "../../../utils/programmer-error";
import { ImportCtx } from "../types/import-context";
import { dbBatchCall$ } from "../utils/db-batch";

const logger = rootLogger.child({ module: "price-feed", component: "loader" });

export interface DbPriceFeed {
  priceFeedId: number;
  feedKey: string;
  fromAssetKey: string;
  toAssetKey: string;
  priceFeedData: {
    externalId: string;
    active: boolean;
  };
}

export function upsertPriceFeed$<TObj, TRes, TParams extends Omit<DbPriceFeed, "priceFeedId">>(options: {
  ctx: ImportCtx<TObj>;
  getFeedData: (obj: TObj) => TParams;
  formatOutput: (obj: TObj, feed: DbPriceFeed) => TRes;
}): Rx.OperatorFunction<TObj, TRes> {
  return dbBatchCall$({
    ctx: options.ctx,
    formatOutput: options.formatOutput,
    getData: options.getFeedData,
    processBatch: async (objAndData) => {
      const results = await db_query<DbPriceFeed>(
        `INSERT INTO price_feed (feed_key, from_asset_key, to_asset_key, price_feed_data) VALUES %L
              ON CONFLICT (feed_key) 
              -- DO NOTHING -- can't use DO NOTHING because we need to return the id
              DO UPDATE SET
                from_asset_key = EXCLUDED.from_asset_key,
                to_asset_key = EXCLUDED.to_asset_key,
                price_feed_data = jsonb_merge(price_feed.price_feed_data, EXCLUDED.price_feed_data)
              RETURNING 
                price_feed_id as "priceFeedId", 
                feed_key as "feedKey",
                from_asset_key as "fromAssetKey",
                to_asset_key as "toAssetKey",
                price_feed_data as "priceFeedData"`,
        [
          uniqBy(objAndData, (obj) => obj.data.feedKey).map((obj) => [
            obj.data.feedKey,
            obj.data.fromAssetKey,
            obj.data.toAssetKey,
            obj.data.priceFeedData,
          ]),
        ],
        options.ctx.client,
      );

      const idMap = keyBy(results, "feedKey");
      return objAndData.map((obj) => {
        const feed = idMap[obj.data.feedKey];
        if (!feed) {
          throw new ProgrammerError({ msg: "Upserted price feed not found", data: obj });
        }
        return feed;
      });
    },
  });
}

export function priceFeedList$<TKey extends string>(client: PoolClient, keyPrefix: TKey): Rx.Observable<DbPriceFeed> {
  logger.debug({ msg: "Fetching price feed from db", data: { keyPrefix } });
  return Rx.of(
    db_query<DbPriceFeed>(
      `SELECT 
        price_feed_id as "priceFeedId",
        feed_key as "feedKey",
        from_asset_key as "fromAssetKey",
        to_asset_key as "toAssetKey",
        price_feed_data as "priceFeedData"
      FROM price_feed 
      WHERE feed_key like %L || ':%'`,
      [keyPrefix],
      client,
    ),
  ).pipe(
    Rx.mergeAll(),

    Rx.tap((priceFeeds) => logger.debug({ msg: "emitting price feed list", data: { count: priceFeeds.length } })),

    Rx.concatMap((priceFeeds) => Rx.from(priceFeeds)), // flatten
  );
}
