// Шаг 12 (неделя 13): ребалансировка. Закрываем позицию и открываем новую вокруг новой цены.
//   npm run lp-rebalance            новый диапазон ±5% вокруг текущей цены
//   RANGE=0.1 npm run lp-rebalance
import Decimal from "decimal.js";
import { execSync } from "child_process";
import { bal, closeLp, fetchRecord, link, openLp, run, saveAddresses, setup } from "./lp";

run(async () => {
  const range = Number(process.env.RANGE ?? "0.05");
  const S = await setup();
  const rec = await fetchRecord(S);
  if (!rec.isOpen) throw new Error("Нет открытой позиции для ребалансировки");

  const price = new Decimal(S.poolInfo.price);
  const dec = S.poolInfo.mintB.decimals - S.poolInfo.mintA.decimals;
  const priceAt = (tick: number) => new Decimal(1.0001).pow(tick).mul(new Decimal(10).pow(-dec));
  const lo = priceAt(rec.tickLower), hi = priceAt(rec.tickUpper);
  const inRange = price.gte(lo) && price.lte(hi);
  console.log("Текущая цена     ", price.toString());
  console.log("Старый диапазон  ", lo.toString(), "-", hi.toString(), inRange ? "(цена внутри)" : "(цена ВНЕ диапазона)");

  console.log("\n--- 1. Закрываем старую позицию ---");
  const closed = await closeLp(0.01);

  console.log("\n--- 2. Выравниваем токены обменом через vault (для новой позиции нужны оба) ---");
  const vA = await bal(S.p.tokenVault);
  const vB = await bal(S.p.tokenVaultB);
  const half = (vA > vB ? vA - vB : vB - vA) / 2n;
  if (half > 1000n) {
    execSync("npm run vault-swap", {
      stdio: "inherit",
      env: { ...process.env, DIRECTION: vA > vB ? "a2b" : "b2a", AMOUNT: half.toString() },
    });
  }

  console.log("\n--- 3. Открываем новую позицию вокруг новой цены ---");
  const opened = await openLp(range);

  saveAddresses({
    lpRebalance: {
      oldRange: { lowerPrice: lo.toString(), upperPrice: hi.toString(), tickLower: rec.tickLower, tickUpper: rec.tickUpper },
      priceAtRebalance: price.toString(),
      closeTx: closed.sig,
      openTx: opened.sig,
    },
  });
  console.log("\nРебалансировка выполнена.");
  console.log("Закрытие", link("tx", closed.sig));
  console.log("Открытие", link("tx", opened.sig));
});
