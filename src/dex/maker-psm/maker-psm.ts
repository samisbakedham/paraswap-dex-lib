import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import { Contract } from 'web3-eth-contract';
import {
  Token,
  Address,
  ExchangePrices,
  Log,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
} from '../../types';
import { SwapSide, Network } from '../../constants';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import { wrapETH, getDexKeysWithNetwork } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { MakerPsmData, PoolState, PoolConfig } from './types';
import { SimpleExchange } from '../simple-exchange';
import { MakerPsmConfig, Adapters } from './config';
import PsmABI from '../../abi/maker-psm/psm.json';
import VatABI from '../../abi/maker-psm/vat.json';

const vatInterface = new Interface(VatABI);
const psmInterface = new Interface(PsmABI);
const WAD = BigInt(10 ** 18);
const BN0 = BigInt(0);
const BN1 = BigInt(1);
const BN1E18 = BigInt(1e18);

const bigIntify = (b: any) => BigInt(b.toString());
const ceilDiv = (a: bigint, b: bigint) => (a + b - BN1) / b;

async function getOnChainState(
  multiContract: Contract,
  poolConfigs: PoolConfig[],
  vatAddress: Address,
  blockNumber: number | 'latest',
): Promise<PoolState[]> {
  const callData = poolConfigs
    .map(c => [
      {
        target: c.psmAddress,
        callData: psmInterface.encodeFunctionData('tin', []),
      },
      {
        target: c.psmAddress,
        callData: psmInterface.encodeFunctionData('tout', []),
      },
      {
        target: vatAddress,
        callData: vatInterface.encodeFunctionData('ilks', [c.identifier]),
      },
    ])
    .flat();

  const res = await multiContract.methods
    .aggregate(callData)
    .call({}, blockNumber);

  let i = 0;
  return poolConfigs.map(c => {
    const tin = bigIntify(
      psmInterface.decodeFunctionResult('tin', res.returnData[i++])[0],
    );
    const tout = bigIntify(
      psmInterface.decodeFunctionResult('tout', res.returnData[i++])[0],
    );
    const ilks = vatInterface.decodeFunctionResult('ilks', res.returnData[i++]);
    const Art = bigIntify(ilks.Art);
    const line = bigIntify(ilks.line);
    const rate = bigIntify(ilks.rate);
    return {
      tin,
      tout,
      Art,
      line,
      rate,
    };
  });
}

export class MakerPsmEventPool extends StatefulEventSubscriber<PoolState> {
  handlers: {
    [event: string]: (event: any, pool: PoolState, log: Log) => PoolState;
  } = {};

  logDecoder: (log: Log) => any;

  addressesSubscribed: string[];
  to18ConversionFactor: bigint;
  bytes32Tout =
    '0x746f757400000000000000000000000000000000000000000000000000000000'; // bytes32('tout')
  bytes32Tin =
    '0x74696e0000000000000000000000000000000000000000000000000000000000'; // bytes32('tin')

  constructor(
    protected parentName: string,
    protected network: number,
    protected dexHelper: IDexHelper,
    logger: Logger,
    public poolConfig: PoolConfig,
    protected vatAddress: Address,
  ) {
    super(parentName, logger);

    this.logDecoder = (log: Log) => psmInterface.parseLog(log);
    this.addressesSubscribed = [poolConfig.psmAddress];
    this.to18ConversionFactor =
      BigInt(10) ** BigInt(18 - poolConfig.gem.decimals);

    // Add handlers
    this.handlers['File'] = this.handleFile.bind(this);
    this.handlers['SellGem'] = this.handleSellGem.bind(this);
    this.handlers['BuyGem'] = this.handleBuyGem.bind(this);
  }

  handleFile(event: any, pool: PoolState, log: Log): PoolState {
    if (event.args.what === this.bytes32Tin) {
      pool.tin = bigIntify(event.args.data);
    } else if (event.args.what === this.bytes32Tout) {
      pool.tout = bigIntify(event.args.data);
    }
    return pool;
  }

  handleSellGem(event: any, pool: PoolState, log: Log): PoolState {
    pool.Art += bigIntify(event.args.value) * this.to18ConversionFactor;
    return pool;
  }

  handleBuyGem(event: any, pool: PoolState, log: Log): PoolState {
    pool.Art -= bigIntify(event.args.value) * this.to18ConversionFactor;
    return pool;
  }

  getIdentifer(): string {
    return `${this.parentName}_${this.poolConfig.psmAddress}`.toLowerCase();
  }

  /**
   * The function is called everytime any of the subscribed
   * addresses release log. The function accepts the current
   * state, updates the state according to the log, and returns
   * the updated state.
   * @param state - Current state of event subscriber
   * @param log - Log released by one of the subscribed addresses
   * @returns Updates state of the event subscriber after the log
   */
  protected processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
  ): DeepReadonly<PoolState> | null {
    try {
      const event = this.logDecoder(log);
      if (event.name in this.handlers) {
        return this.handlers[event.name](event, state, log);
      }
      return state;
    } catch (e) {
      this.logger.error(
        `Error_${this.parentName}_processLog could not parse the log with topic ${log.topics}:`,
        e,
      );
      return null;
    }
  }

  /**
   * The function generates state using on-chain calls. This
   * function is called to regenrate state if the event based
   * system fails to fetch events and the local state is no
   * more correct.
   * @param blockNumber - Blocknumber for which the state should
   * should be generated
   * @returns state of the event subsriber at blocknumber
   */
  async generateState(blockNumber: number): Promise<Readonly<PoolState>> {
    return (
      await getOnChainState(
        this.dexHelper.multiContract,
        [this.poolConfig],
        this.vatAddress,
        blockNumber,
      )
    )[0];
  }
}

export class MakerPsm extends SimpleExchange implements IDex<MakerPsmData> {
  protected eventPools: { [gemAddress: string]: MakerPsmEventPool };

  // warning: There is limit on swap
  readonly hasConstantPriceLargeAmounts = true;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(MakerPsmConfig);

  logger: Logger;

  constructor(
    protected network: Network,
    protected dexKey: string,
    protected dexHelper: IDexHelper,
    protected adapters = Adapters[network],
    protected dai: Token = MakerPsmConfig[dexKey][network].dai,
    protected vatAddress: Address = MakerPsmConfig[dexKey][network].vatAddress,
    protected poolConfigs: PoolConfig[] = MakerPsmConfig[dexKey][network].pools,
  ) {
    super(dexHelper.augustusAddress, dexHelper.provider);
    this.logger = dexHelper.getLogger(dexKey);
    this.eventPools = {};
    poolConfigs.forEach(
      p =>
        (this.eventPools[p.gem.address.toLowerCase()] = new MakerPsmEventPool(
          dexKey,
          network,
          dexHelper,
          this.logger,
          p,
          this.vatAddress,
        )),
    );
  }

  async initializePricing(blockNumber: number) {
    const poolStates = await getOnChainState(
      this.dexHelper.multiContract,
      this.poolConfigs,
      this.vatAddress,
      blockNumber,
    );
    this.poolConfigs.forEach((p, i) => {
      const eventPool = this.eventPools[p.gem.address.toLowerCase()];
      eventPool.setState(poolStates[i], blockNumber);
      this.dexHelper.blockManager.subscribeToLogs(
        eventPool,
        eventPool.addressesSubscribed,
        blockNumber,
      );
    });
  }

  // Returns the list of contract adapters (name and index)
  // for a buy/sell. Return null if there are no adapters.
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters[side];
  }

  getEventPool(srcToken: Token, destToken: Token): MakerPsmEventPool | null {
    const srcAddress = srcToken.address.toLowerCase();
    const destAddress = destToken.address.toLowerCase();
    return (
      (srcAddress === this.dai.address && this.eventPools[destAddress]) ||
      (destAddress === this.dai.address && this.eventPools[srcAddress]) ||
      null
    );
  }

  // Returns list of pool identifiers that can be used
  // for a given swap. poolIdentifers must be unique
  // across DEXes.
  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const eventPool = this.getEventPool(srcToken, destToken);
    if (!eventPool) return [];
    return [eventPool.getIdentifer()];
  }

  async getPoolState(
    pool: MakerPsmEventPool,
    blockNumber: number,
  ): Promise<PoolState> {
    const eventState = pool.getState(blockNumber);
    if (eventState) return eventState;
    const onChainState = await pool.generateState(blockNumber);
    pool.setState(onChainState, blockNumber);
    return onChainState;
  }

  computePrices(
    isSrcDai: boolean,
    to18ConversionFactor: bigint,
    side: SwapSide,
    amounts: bigint[],
    poolState: PoolState,
  ): bigint[] {
    const sellGemCheck = (dart: bigint) =>
      (dart + poolState.Art) * poolState.rate <= poolState.line;
    const buyGemCheck = (dart: bigint) => dart <= poolState.Art;

    return amounts.map(a => {
      if (side === SwapSide.SELL) {
        if (isSrcDai) {
          const gemAmt18 = (a * WAD) / (WAD + poolState.tout);
          if (buyGemCheck(gemAmt18)) return gemAmt18 / to18ConversionFactor;
        } else {
          const gemAmt18 = to18ConversionFactor * a;
          if (sellGemCheck(gemAmt18))
            return gemAmt18 - (gemAmt18 * poolState.tin) / WAD;
        }
      } else {
        if (isSrcDai) {
          const gemAmt18 = to18ConversionFactor * a;
          if (buyGemCheck(gemAmt18))
            return gemAmt18 + (gemAmt18 * poolState.tout) / WAD;
        } else {
          const gemAmt18 = (a * WAD) / (WAD - poolState.tin);
          if (sellGemCheck(gemAmt18)) return gemAmt18 / to18ConversionFactor;
        }
      }
      return BN0;
    });
  }

  // Returns pool prices for amounts.
  // If limitPools is defined only pools in limitPools
  // should be used. If limitPools is undefined then
  // any pools can be used.
  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<MakerPsmData>> {
    const eventPool = this.getEventPool(srcToken, destToken);
    if (!eventPool) return null;

    const poolIdentifier = eventPool.getIdentifer();
    if (limitPools && !limitPools.includes(poolIdentifier)) return null;

    const poolState = await this.getPoolState(eventPool, blockNumber);

    const unitVolume = BigInt(
      10 ** (side === SwapSide.SELL ? srcToken : destToken).decimals,
    );

    const isSrcDai = srcToken.address.toLowerCase() === this.dai.address;
    const gem = isSrcDai ? destToken : srcToken;
    const toll =
      (side === SwapSide.SELL && isSrcDai) ||
      (side === SwapSide.BUY && !isSrcDai)
        ? poolState.tout
        : poolState.tin;

    const [unit, ...prices] = this.computePrices(
      isSrcDai,
      eventPool.to18ConversionFactor,
      side,
      [unitVolume, ...amounts],
      poolState,
    );

    return [
      {
        prices,
        unit,
        data: {
          toll: toll.toString(),
          psmAddress: eventPool.poolConfig.psmAddress,
          gemJoinAddress: eventPool.poolConfig.gemJoinAddress,
          gemDecimals: gem.decimals,
        },
        poolAddresses: [eventPool.poolConfig.psmAddress],
        exchange: this.dexKey,
        gasCost: 100 * 1000, //TODO: simulate and fix the gas cost
        poolIdentifier,
      },
    ];
  }

  getPsmParams(
    srcToken: string,
    srcAmount: string,
    destAmount: string,
    data: MakerPsmData,
    side: SwapSide,
  ): { isGemSell: boolean; gemAmount: string } {
    const isSrcDai = srcToken.toLowerCase() === this.dai.address;
    const to18ConversionFactor = BigInt(10) ** BigInt(18 - data.gemDecimals);
    if (side === SwapSide.SELL) {
      if (isSrcDai) {
        const gemAmt18 = (BigInt(srcAmount) * WAD) / (WAD + BigInt(data.toll));
        return {
          isGemSell: false,
          gemAmount: (gemAmt18 / to18ConversionFactor).toString(),
        };
      } else {
        return { isGemSell: true, gemAmount: srcAmount };
      }
    } else {
      if (isSrcDai) {
        return { isGemSell: false, gemAmount: destAmount };
      } else {
        const gemAmt = ceilDiv(
          BigInt(destAmount) * WAD,
          (WAD - BigInt(data.toll)) * to18ConversionFactor,
        );
        return {
          isGemSell: true,
          gemAmount: gemAmt.toString(),
        };
      }
    }
  }

  // Encode params required by the exchange adapter
  // Used for multiSwap, buy & megaSwap
  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: MakerPsmData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const to18ConversionFactor = BigInt(10) ** BigInt(18 - data.gemDecimals);
    const payload = this.abiCoder.encodeParameter(
      {
        ParentStruct: {
          gemJoinAddress: 'address',
          toll: 'uint256',
          to18ConversionFactor: 'uint256',
        },
      },
      {
        gemJoinAddress: data.gemJoinAddress,
        toll: data.toll,
        to18ConversionFactor,
      },
    );

    return {
      targetExchange: data.psmAddress,
      networkFee: '0',
      payload,
    };
  }

  // Encode call data used by simpleSwap like routers
  // Used for simpleSwap & simpleBuy
  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: MakerPsmData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    const { isGemSell, gemAmount } = this.getPsmParams(
      srcToken,
      srcAmount,
      destAmount,
      data,
      side,
    );

    const swapData = psmInterface.encodeFunctionData(
      isGemSell ? 'sellGem' : 'buyGem',
      [this.augustusAddress, gemAmount],
    );

    return this.buildSimpleParamWithoutWETHConversion(
      srcToken,
      srcAmount,
      destToken,
      destAmount,
      swapData,
      data.psmAddress,
      isGemSell ? data.gemJoinAddress : data.psmAddress,
    );
  }

  // Returns list of top pools based on liquidity. Max
  // limit number pools should be returned.
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    const _tokenAddress = tokenAddress.toLowerCase();
    // Liquidity depends on the swapping side hence we simply use the min
    // Its always in terms of stable coin hence liquidityUSD = liquidity
    const minLiq = (poolState: PoolState) => {
      const buyLimit = poolState.Art;
      const sellLimit =
        (poolState.line - poolState.Art * poolState.rate) / poolState.rate;
      return (
        2 *
        parseInt(
          ((buyLimit > sellLimit ? sellLimit : buyLimit) / BN1E18).toString(),
        )
      );
    };

    const isDai = _tokenAddress === this.dai.address;

    const validPoolConfigs = isDai
      ? this.poolConfigs
      : this.eventPools[_tokenAddress]
      ? [this.eventPools[_tokenAddress].poolConfig]
      : [];
    if (!validPoolConfigs.length) return [];

    const poolStates = await getOnChainState(
      this.dexHelper.multiContract,
      validPoolConfigs,
      this.vatAddress,
      'latest',
    );
    return validPoolConfigs.map((p, i) => ({
      exchange: this.dexKey,
      address: p.psmAddress,
      liquidityUSD: minLiq(poolStates[i]),
      connectorTokens: [isDai ? p.gem : this.dai],
    }));
  }
}
