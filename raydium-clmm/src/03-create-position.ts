// Шаг 3: открываем со своего кошелька одну позицию в диапазоне ±10% вокруг текущей цены.
import { PoolUtils } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";
import { initSdk, link, loadAddresses, saveAddresses, txVersion } from "./config";

const RANGE = 0.1; // ±10% вокруг цены
const AMOUNT_A = 100; // сколько токена A вносим (в штуках, не в минимальных единицах)

// Цена -> тик: tick = log(цена) / log(1.0001); округляем к шагу тиков пула.
const priceToTick = (price: Decimal, decA: number, decB: number, spacing: number, up: boolean) => {
  const raw = price.mul(new Decimal(10).pow(decB - decA)); // цена в минимальных единицах
  const t = raw.ln().div(new Decimal(1.0001).ln());
  const k = up ? t.div(spacing).ceil() : t.div(spacing).floor();
  return k.mul(spacing).toNumber();
};

(async () => {
  const a = loadAddresses();
  if (!a.poolId) throw new Error("Сначала создай пул: npm run pool");

  const raydium = await initSdk();
  // Обход бага SDK 0.2.85-alpha: у свежего пула ещё нет tick-массивов, и внутри
  // getPoolInfoFromRpc вызывается Object.values(undefined). На время вызова делаем его безопасным.
  const origValues = Object.values;
  (Object as any).values = (o: any) => (o == null ? [] : origValues(o));
  let poolInfo: any, poolKeys: any;
  try {
    ({ poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(a.poolId));
  } finally {
    (Object as any).values = origValues;
  }

  const spacing = poolInfo.config.tickSpacing;
  const price = new Decimal(poolInfo.price);
  const lowerPrice = price.mul(1 - RANGE);
  const upperPrice = price.mul(1 + RANGE);
  const tickLower = priceToTick(lowerPrice, poolInfo.mintA.decimals, poolInfo.mintB.decimals, spacing, false);
  const tickUpper = priceToTick(upperPrice, poolInfo.mintA.decimals, poolInfo.mintB.decimals, spacing, true);
  console.log("Текущая цена    ", price.toString(), "(токена B за 1 токен A)");
  console.log("Диапазон цен    ", lowerPrice.toString(), "-", upperPrice.toString());
  console.log("Тики            ", tickLower, "-", tickUpper, "(шаг", spacing + ")");

  const baseAmount = new BN(new Decimal(AMOUNT_A).mul(10 ** poolInfo.mintA.decimals).toFixed(0));
  const epochInfo = await raydium.fetchEpochInfo();
  const res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo,
    slippage: 0.01,
    inputA: true,
    tickUpper,
    tickLower,
    amount: baseAmount,
    add: true,
    amountHasFee: true,
    epochInfo,
  });
  // Лимит токена B: берём большую из двух оценок SDK и добавляем 2% запаса (защита от slippage).
  const needB: BN = res.amountB.amount.gt(res.amountSlippageB.amount) ? res.amountB.amount : res.amountSlippageB.amount;
  const otherAmountMax = needB.mul(new BN(102)).div(new BN(100));
  console.log("Нужно токена B  ", res.amountB.amount.toString(), "| лимит:", otherAmountMax.toString());

  const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys,
    tickUpper,
    tickLower,
    base: "MintA",
    ownerInfo: { useSOLBalance: true },
    baseAmount,
    otherAmountMax,
    txVersion,
    computeBudgetConfig: { units: 600000, microLamports: 100000 },
  });

  let txId: string;
  try {
    ({ txId } = await execute({ sendAndConfirm: true }));
  } catch (e: any) {
    console.error("ОШИБКА при отправке позиции:");
    console.error(e?.message ?? "");
    console.error(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)?.slice(0, 3000));
    process.exit(1);
  }
  const nft = extInfo.nftMint.toBase58();
  saveAddresses({
    positionNft: nft,
    positionTx: txId,
    range: { lowerPrice: lowerPrice.toString(), upperPrice: upperPrice.toString(), tickLower, tickUpper },
  });
  console.log("Позиция открыта. NFT позиции:", nft);
  console.log("NFT        ", link("address", nft));
  console.log("Tx position", link("tx", txId));
  process.exit(0);
})();
