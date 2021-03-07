//import { PromisifyBatchRequest } from 'src/utils/lib/PromiseBatchRequest';
import { getContract } from 'src/utils/lib/web3';
import { getBscPrices } from 'src/utils/bsc_helpers';
import { getParameterCaseInsensitive, tokenType } from 'src/utils/helpers';

import masterApeABI from './masterApeABI.json';
import configuration from 'src/config/configuration';
import { poolBalance } from 'src/pairs/pairs.queries';
import { ERC20_ABI } from './erc20Abi';
import { LP_ABI } from './lpAbi';

// ADDRESS GETTERS
function masterApeContractAddress(): string {
  return configuration()[process.env.CHAIN_ID].contracts.masterApe;
}

function bananaAddress(): string {
  return configuration()[process.env.CHAIN_ID].contracts.banana;
}

function bnbAddress(): string {
  return configuration()[process.env.CHAIN_ID].contracts.bnb;
}

function bananaBusdAddress(): string {
  return configuration()[process.env.CHAIN_ID].contracts.bananaBusd;
}

function bananaBnbAddress(): string {
  return configuration()[process.env.CHAIN_ID].contracts.bananaBnb;
}

function burnAddress(): string {
  return configuration()[process.env.CHAIN_ID].contracts.burn;
}


export async function getRewardsPerDay(): Promise<any> {
  const MasterApeContract = getContract(
    masterApeABI,
    masterApeContractAddress(),
  );
  return (((await MasterApeContract.methods.cakePerBlock().call()) / 1e18) * 86400) / 3;
}

export async function getAllPrices(httpService): Promise<any> {
  const prices = await getBscPrices(httpService);
  return prices;
}

function getBananaPriceWithPoolList(poolList, prices) {
  const poolBusd = poolList.find((pool) => pool.address === bananaBusdAddress());
  const bananaPriceUsingBusd = poolBusd.poolToken.q1 / poolBusd.poolToken.q0;
  if (prices[bnbAddress()]) {
    const poolBnb = poolList.find((pool) => pool.address === bananaBnbAddress());
    const bnbTvl = poolBnb.poolToken.q1 * prices[bnbAddress()].usd / 10 ** poolBnb.poolToken.decimals;
    const busdTvl = poolBusd.poolToken.q1 / 10 ** poolBusd.poolToken.decimals;
    const bananaPriceUsingBnb = poolBnb.poolToken.q1 * prices[bnbAddress()].usd / poolBnb.poolToken.q0;

    return (bananaPriceUsingBnb * bnbTvl + bananaPriceUsingBusd * busdTvl) / (bnbTvl + busdTvl);
  }

  return bananaPriceUsingBusd;
}

export async function getAllStats(httpService): Promise<any> {
  const masterApeContract = getContract(masterApeABI, masterApeContractAddress());
  const bananaContract = getContract(ERC20_ABI, bananaAddress());
  const prices = await getBscPrices(httpService);
  const tokens = {};
  const totalAllocPoints = await masterApeContract.methods
    .totalAllocPoint()
    .call();
  const rewardsPerDay = await getRewardsPerDay();
  const poolCount = parseInt(
    await masterApeContract.methods.poolLength().call(),
    10,
  );

  const poolInfos = await Promise.all(
    [...Array(poolCount).keys()].map(
      async (x) => await getBscPoolInfo(masterApeContract, x),
    ),
  );

  // eslint-disable-next-line prefer-spread
  const tokenAddresses = [].concat.apply(
    [],
    poolInfos.filter((x) => x.poolToken).map((x) => x.poolToken.tokens),
  );

  await Promise.all(
    tokenAddresses.map(async (address) => {
      tokens[address] = await getBscToken(address, masterApeContractAddress());
    }),
  );

  // If Banana price not returned from Gecko, calculating using pools
  if (!prices[bananaAddress()]) {
    prices[bananaAddress()] = { usd: getBananaPriceWithPoolList(poolInfos, prices) };
  }
  const burntAmount = await getBurntTokens(bananaContract);
  const totalSupply = await getTotalTokenSupply(bananaContract) - burntAmount;
  const poolPrices = {
    burntAmount,
    totalSupply,
    marketCap: totalSupply * prices[bananaAddress()].usd,
    pools: [],
    farms: [],
  };

  for (let i = 0; i < poolInfos.length; i++) {
    if (poolInfos[i].poolToken) {
      getPoolPrices(tokens, prices, poolInfos[i].poolToken, poolPrices, i, poolInfos[i].allocPoints, totalAllocPoints, rewardsPerDay);
    }
  }
  return poolPrices;
}

// Get TVL info given a wallet
export async function getWalletStats(httpService, wallet): Promise<any> {
  const poolPrices = await getAllStats(httpService);
  const masterApeContract = getContract(
    masterApeABI,
    masterApeContractAddress(),
  );

  const walletTvl = {
    pools: await getWalletStatsForPools(wallet, poolPrices.pools, masterApeContract),
    farms: await getWalletStatsForFarms(wallet, poolPrices.farms, masterApeContract),
    tvl: 0,
    aggregateApr: 0,
    earningsPerWeek: 0,
  };

  let totalApr = 0;

  walletTvl.pools.forEach(pool => {
    walletTvl.tvl += pool.stakedTvl;
    totalApr += pool.stakedTvl * pool.apr;
  });

  walletTvl.farms.forEach(farm => {
    walletTvl.tvl += farm.stakedTvl;
    totalApr += farm.stakedTvl * farm.apr;
  });

  walletTvl.aggregateApr = totalApr / walletTvl.tvl;
  walletTvl.earningsPerWeek = walletTvl.tvl * walletTvl.aggregateApr * 7 / 365
  
  return walletTvl;
}

// Get TVL info for Pools only given a wallet
export async function getWalletStatsForPools(wallet, pools, masterApeContract ): Promise<any> {
  const allPools = [];
  await Promise.all(pools.map(async pool => {
    const userInfo = await masterApeContract.methods
    .userInfo(pool.poolIndex, wallet)
    .call();
    const pendingReward = await masterApeContract.methods
    .pendingCake(pool.poolIndex, wallet)
    .call() / 10 ** pool.decimals;

    if (userInfo.amount != 0 || pendingReward != 0) {
      const stakedTvl = userInfo.amount * pool.price / 10 ** pool.decimals;
      const curr_pool = {
        address: pool.address,
        lpSymbol: pool.lpSymbol,
        stakedTvl,
        pendingReward,
        apr: pool.apr,
      }
      
      allPools.push(curr_pool);
    }

  }));
  return allPools;
}

// Get TVL info for Farms only given a wallet
export async function getWalletStatsForFarms(wallet, farms, masterApeContract ): Promise<any> {
  const allFarms = [];
  await Promise.all(farms.map(async farm => {
    const userInfo = await masterApeContract.methods
    .userInfo(farm.poolIndex, wallet)
    .call();
    const pendingReward = await masterApeContract.methods
    .pendingCake(farm.poolIndex, wallet)
    .call() / 10 ** farm.decimals;

    if (userInfo.amount != 0 || pendingReward != 0) {
      const stakedTvl = userInfo.amount * farm.price / 10 ** farm.decimals;

      const curr_farm = {
        address: farm.address,
        lpSymbol: farm.lpSymbol,
        stakedTvl,
        pendingReward,
        apr: farm.apr,
      }

      allFarms.push(curr_farm);
    }
  }));
  return allFarms;
}

function getPoolPrices(tokens, prices, pool, poolPrices, poolIndex, allocPoints, totalAllocPoints, rewardsPerDay) {
  if (pool.token0 != null) {
    poolPrices.farms.push(getLPTokenPrices(tokens, prices, pool, poolIndex, allocPoints, totalAllocPoints, rewardsPerDay));
  } else {
    poolPrices.pools.push(getBep20Prices(prices, pool, poolIndex, allocPoints, totalAllocPoints, rewardsPerDay));
  }
}

async function getBscPoolInfo(masterApeContract, poolIndex) {
  const poolInfo = await masterApeContract.methods.poolInfo(poolIndex).call();
  // Determine if Bep20 or Lp token
  const poolToken =
    poolIndex !== 0
      ? await getBscLpToken(poolInfo.lpToken, masterApeContractAddress())
      : await getBscToken(poolInfo.lpToken, masterApeContractAddress());

  return {
    address: poolInfo.lpToken,
    allocPoints: poolInfo.allocPoint ?? 1,
    poolToken,
    poolIndex,
    lastRewardBlock: poolInfo.lastRewardBlock,
  };
}

async function getBscToken(tokenAddress, stakingAddress) {
  const bep20 = getContract(ERC20_ABI, tokenAddress);
  return await getBep20(bep20, tokenAddress, stakingAddress);
}

async function getBscLpToken(tokenAddress, stakingAddress) {
  const lp = getContract(LP_ABI, tokenAddress);
  return await getBscLp(lp, tokenAddress, stakingAddress);
}

async function getBep20(token, address, stakingAddress) {
  if (address == '0x0000000000000000000000000000000000000000') {
    return {
      address,
      name: 'Binance',
      symbol: 'BNB',
      totalSupply: 1e8,
      decimals: 18,
      staked: 0,
      tokens: [address],
    };
  }
  const decimals = await token.methods.decimals().call();
  return {
    address,
    name: await token.methods.name().call(),
    symbol: await token.methods.symbol().call(),
    totalSupply: await token.methods.totalSupply().call(),
    decimals,
    staked:
      (await token.methods.balanceOf(stakingAddress).call()) / 10 ** decimals,
    tokens: [address],
  };
}

async function getBscLp(pool, poolAddress, stakingAddress) {
  const reserves = await pool.methods.getReserves().call();
  const q0 = reserves._reserve0;
  const q1 = reserves._reserve1;
  const decimals = await pool.methods.decimals().call();
  const token0 = await pool.methods.token0().call();
  const token1 = await pool.methods.token1().call();
  return {
    lpSymbol: await pool.methods.symbol().call(),
    name: await pool.methods.name().call(),
    address: poolAddress,
    token0,
    q0,
    token1,
    q1,
    totalSupply: (await pool.methods.totalSupply().call()) / 10 ** decimals, 
    stakingAddress,
    staked:
      (await pool.methods.balanceOf(stakingAddress).call()) / 10 ** decimals,
    decimals,
    tokens: [token0, token1],
  };
}

// Given array of prices and single pool contract, return price and tvl info for pool token
function getLPTokenPrices(tokens, prices, pool, poolIndex, allocPoints, totalAllocPoints, rewardsPerDay) {
  const t0 = getParameterCaseInsensitive(tokens, pool.token0);
  let p0 = getParameterCaseInsensitive(prices, pool.token0)?.usd;
  const t1 = getParameterCaseInsensitive(tokens, pool.token1);
  let p1 = getParameterCaseInsensitive(prices, pool.token1)?.usd;

  if (p0 == null && p1 == null) {
    return undefined;
  }
  const q0 = pool.q0 / 10 ** t0.decimals;
  const q1 = pool.q1 / 10 ** t1.decimals;
  if (p0 == null) {
    p0 = (q1 * p1) / q0;
    prices[pool.token0] = { usd: p0 };
  }
  if (p1 == null) {
    p1 = (q0 * p0) / q1;
    prices[pool.token1] = { usd: p1 };
  }
  const tvl = q0 * p0 + q1 * p1;
  const price = tvl / pool.totalSupply;
  prices[pool.address] = { usd: price };
  const stakedTvl = pool.staked * price;
  const lpSymbol = `[${t0.symbol}]-[${t1.symbol}] LP`;

  // APR calculations
  const poolRewardsPerDay = allocPoints / totalAllocPoints * rewardsPerDay;
  const apr = (poolRewardsPerDay * prices[bananaAddress()].usd) / stakedTvl * 365;

  return {
    address: pool.address,
    lpSymbol,
    poolIndex,
    t0Address: t0.address,
    t0Symbol: t0.symbol,
    t0Decimals: t0.decimals,
    p0,
    q0,
    t1Address: t1.address,
    t1Symbol: t1.symbol,
    t1Decimals: t1.decimals,
    p1,
    q1,
    price,
    totalSupply: pool.totalSupply,
    tvl,
    stakedTvl,
    apr,
    decimals: pool.decimals,
  };
}

// Given array of prices and single pool contract, return price and tvl info for pool token
function getBep20Prices(prices, pool, poolIndex, allocPoints, totalAllocPoints, rewardsPerDay) {
  const price = getParameterCaseInsensitive(prices, pool.address)?.usd;
  const tvl = (pool.totalSupply * price) / 10 ** pool.decimals;
  const stakedTvl = pool.staked * price;

  // APR calculations
  const poolRewardsPerDay = allocPoints / totalAllocPoints * rewardsPerDay;
  const apr = (poolRewardsPerDay * prices[bananaAddress()].usd) / stakedTvl * 365;

  return {
    address: pool.address,
    lpSymbol: pool.symbol,
    poolIndex: poolIndex,
    name: pool.name,
    price,
    tvl,
    stakedTvl,
    staked: pool.staked,
    apr,
    decimals: pool.decimals,
  };
}

export async function getBurntTokens(tokenContract): Promise<any> {
  const decimals = await tokenContract.methods.decimals().call();
  return await tokenContract.methods.balanceOf(burnAddress()).call() / 10 ** decimals
}

export async function getTotalTokenSupply(tokenContract): Promise<any> {
  const decimals = await tokenContract.methods.decimals().call();
  return await tokenContract.methods.totalSupply().call() / 10 ** decimals
}