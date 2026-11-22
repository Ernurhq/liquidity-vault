// Показывает состояние позиции vault: диапазон, ликвидность, цену, балансы.
import Decimal from "decimal.js";
import { bal, connection, fetchRecord, link, readPersonalPosition, run, setup } from "./lp";

run(async () => {
  const S = await setup();
  const rec = await fetchRecord(S);
  const dec = S.poolInfo.mintB.decimals - S.poolInfo.mintA.decimals;
  const priceAt = (tick: number) => new Decimal(1.0001).pow(tick).mul(new Decimal(10).pow(-dec));
  const price = new Decimal(S.poolInfo.price);

  console.log("Запись позиции   ", S.lpPosition.toBase58());
  console.log("Позиция открыта  ", rec.isOpen ? "да" : "нет");
  if (rec.isOpen) {
    const pos = await readPersonalPosition(rec.personalPosition);
    const lo = priceAt(rec.tickLower), hi = priceAt(rec.tickUpper);
    console.log("NFT позиции      ", rec.nftMint.toBase58(), link("address", rec.nftMint.toBase58()));
    console.log("Тики             ", rec.tickLower, "-", rec.tickUpper);
    console.log("Диапазон цен     ", lo.toFixed(6), "-", hi.toFixed(6));
    console.log("Ликвидность      ", pos?.liquidity.toString() ?? "?");
    console.log("Цена пула        ", price.toFixed(8), price.gte(lo) && price.lte(hi) ? "(внутри диапазона)" : "(ВНЕ диапазона)");
  } else {
    console.log("Цена пула        ", price.toFixed(8));
  }
  console.log("Токен A в vault  ", (await bal(S.p.tokenVault)).toString());
  console.log("Токен B в vault  ", (await bal(S.p.tokenVaultB)).toString());
  console.log("SOL на authority ", ((await connection.getBalance(S.p.vaultAuthority)) / 1e9).toFixed(4));
});
