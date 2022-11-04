import { ethers } from "ethers";
import { sample } from "lodash";
import { Chain } from "../../../types/chain";
import { RpcConfig } from "../../../types/rpc-config";
import { getChainNetworkId } from "../../../utils/addressbook";
import { ETHERSCAN_API_KEY, RPC_URLS } from "../../../utils/config";

import {
  addDebugLogsToProvider,
  monkeyPatchArchiveNodeRpcProvider,
  monkeyPatchCeloProvider,
  monkeyPatchEthersBatchProvider,
  monkeyPatchHarmonyProviderRetryNullResponses,
  monkeyPatchLayer2ReceiptFormat,
  monkeyPatchMissingEffectiveGasPriceReceiptFormat,
  monkeyPatchMoonbeamLinearProvider,
  monkeyPatchProviderToRetryUnderlyingNetworkChangedError,
  MultiChainEtherscanProvider,
} from "../../../utils/ethers";
import { getRpcLimitations } from "../../../utils/rpc/rpc-limitations";

export function createRpcConfig(chain: Chain, { url: rpcUrl, timeout = 120_000 }: { url?: string; timeout?: number } = {}): RpcConfig {
  const rpcOptions: ethers.utils.ConnectionInfo = {
    url: rpcUrl || (sample(RPC_URLS[chain]) as string),
    timeout,
  };
  const networkish = {
    name: chain,
    chainId: getChainNetworkId(chain),
  };

  const rpcConfig: RpcConfig = {
    chain,
    linearProvider: new ethers.providers.JsonRpcProvider(rpcOptions, networkish),
    batchProvider: new ethers.providers.JsonRpcBatchProvider(rpcOptions, networkish),
    rpcLimitations: getRpcLimitations(chain, rpcOptions.url),
  };
  if (MultiChainEtherscanProvider.isChainSupported(chain)) {
    const apiKey = ETHERSCAN_API_KEY[chain];
    rpcConfig.etherscan = {
      provider: new MultiChainEtherscanProvider(chain, apiKey || undefined),
      minDelayBetweenCalls: apiKey ? Math.ceil(1000.0 / 5.0) /* 5 rps */ : 1000,
    };
  }

  // monkey patch providers so they don't call eth_getChainId before every call
  // this effectively divides the number of calls by 2
  rpcConfig.linearProvider.detectNetwork = () => Promise.resolve(networkish);
  rpcConfig.batchProvider.detectNetwork = () => Promise.resolve(networkish);

  addDebugLogsToProvider(rpcConfig.linearProvider);
  addDebugLogsToProvider(rpcConfig.batchProvider);
  monkeyPatchEthersBatchProvider(rpcConfig.batchProvider);

  if (chain === "harmony") {
    monkeyPatchHarmonyProviderRetryNullResponses(rpcConfig.linearProvider);
    monkeyPatchHarmonyProviderRetryNullResponses(rpcConfig.batchProvider);
    monkeyPatchMissingEffectiveGasPriceReceiptFormat(rpcConfig.linearProvider);
    monkeyPatchMissingEffectiveGasPriceReceiptFormat(rpcConfig.batchProvider);
  }
  if (chain === "moonbeam") {
    monkeyPatchMoonbeamLinearProvider(rpcConfig.linearProvider);
  }
  if (chain === "celo") {
    monkeyPatchCeloProvider(rpcConfig.linearProvider);
    monkeyPatchCeloProvider(rpcConfig.batchProvider);
  }
  if (chain === "optimism" || chain === "metis") {
    monkeyPatchLayer2ReceiptFormat(rpcConfig.linearProvider);
    monkeyPatchLayer2ReceiptFormat(rpcConfig.batchProvider);
  }
  if (chain === "cronos") {
    monkeyPatchMissingEffectiveGasPriceReceiptFormat(rpcConfig.linearProvider);
    monkeyPatchMissingEffectiveGasPriceReceiptFormat(rpcConfig.batchProvider);
  }

  const retryDelay = rpcConfig.rpcLimitations.minDelayBetweenCalls === "no-limit" ? 0 : rpcConfig.rpcLimitations.minDelayBetweenCalls;
  if (rpcConfig.rpcLimitations.isArchiveNode) {
    monkeyPatchArchiveNodeRpcProvider(rpcConfig.linearProvider, retryDelay);
    monkeyPatchArchiveNodeRpcProvider(rpcConfig.batchProvider, retryDelay);
  }

  monkeyPatchProviderToRetryUnderlyingNetworkChangedError(rpcConfig.linearProvider, retryDelay);
  monkeyPatchProviderToRetryUnderlyingNetworkChangedError(rpcConfig.batchProvider, retryDelay);

  return rpcConfig;
}
