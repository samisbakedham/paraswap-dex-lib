import dotenv from 'dotenv';
dotenv.config();

import { DummyDexHelper } from '../../dex-helper/index';
import { Network, SwapSide } from '../../constants';
import { KyberDmm } from './kyberdmm';
import { checkPoolPrices, checkPoolsLiquidity } from '../../../tests/utils';
import { Tokens } from '../../../tests/constants-e2e';

const network = Network.MAINNET;
const TokenASymbol = 'USDT';
const TokenA = Tokens[network][TokenASymbol];

const TokenBSymbol = 'WBTC';
const TokenB = Tokens[network][TokenBSymbol];

const amounts = [BigInt('0'), BigInt('1000000'), BigInt('2000000')];

const dexKey = 'KyberDmm';

describe('KyberDmm', function () {
  it('getPoolIdentifiers and getPricesVolume SELL', async function () {
    const dexHelper = new DummyDexHelper(network);
    const blocknumber = await dexHelper.provider.getBlockNumber();
    const kyberDmm = new KyberDmm(network, dexKey, dexHelper);

    const pools = await kyberDmm.getPoolIdentifiers(
      TokenA,
      TokenB,
      SwapSide.SELL,
      blocknumber,
    );
    console.log(
      `${TokenASymbol} <> ${TokenBSymbol} Pool Ideintifiers: `,
      pools,
    );

    expect(pools.length).toBeGreaterThan(0);

    const poolPrices = await kyberDmm.getPricesVolume(
      TokenA,
      TokenB,
      amounts,
      SwapSide.SELL,
      blocknumber,
      pools,
    );
    console.log('${TokenASymbol} <> ${TokenBSymbol} Pool Prices: ', poolPrices);

    expect(poolPrices).not.toBeNull();
    checkPoolPrices(poolPrices!, amounts, SwapSide.SELL, dexKey);
  });

  it('getPoolIdentifiers and getPricesVolume BUY', async function () {
    const dexHelper = new DummyDexHelper(network);
    const blocknumber = await dexHelper.provider.getBlockNumber();
    const kyberDmm = new KyberDmm(network, dexKey, dexHelper);

    const pools = await kyberDmm.getPoolIdentifiers(
      TokenA,
      TokenB,
      SwapSide.BUY,
      blocknumber,
    );
    console.log(
      `${TokenASymbol} <> ${TokenBSymbol} Pool Ideintifiers: `,
      pools,
    );

    expect(pools.length).toBeGreaterThan(0);

    const poolPrices = await kyberDmm.getPricesVolume(
      TokenA,
      TokenB,
      amounts,
      SwapSide.BUY,
      blocknumber,
      pools,
    );
    console.log('${TokenASymbol} <> ${TokenBSymbol} Pool Prices: ', poolPrices);

    expect(poolPrices).not.toBeNull();
    checkPoolPrices(poolPrices!, amounts, SwapSide.BUY, dexKey);
  });

  it('getTopPoolsForToken', async function () {
    const dexHelper = new DummyDexHelper(network);
    const kyberDmm = new KyberDmm(network, dexKey, dexHelper);

    const poolLiquidity = await kyberDmm.getTopPoolsForToken(
      TokenA.address,
      10,
    );
    console.log(`${TokenASymbol} Top Pools:`, poolLiquidity);

    checkPoolsLiquidity(poolLiquidity, TokenA.address, dexKey);
  });
});
