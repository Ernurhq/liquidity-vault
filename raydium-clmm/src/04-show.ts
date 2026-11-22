// Печатает все адреса недели 11 со ссылками на Explorer (для README).
import { link, loadAddresses } from "./config";

const a = loadAddresses();
const row = (k: string, v?: string, kind: "address" | "tx" = "address") =>
  console.log(k.padEnd(14), v ?? "—", v ? link(kind, v) : "");
row("Токен A", a.mintA);
row("Токен B", a.mintB);
row("Пул", a.poolId);
row("Tx пула", a.poolTx, "tx");
row("AmmConfig", a.ammConfig);
row("NFT позиции", a.positionNft);
row("Tx позиции", a.positionTx, "tx");
row("SwapPool", a.swapPool);
row("Хранилище B", a.tokenVaultB);
row("Tx swap", a.swapTx, "tx");
row("Tx отклонён", a.swapRejectedTx, "tx");
row("Tx обратно", a.swapBackTx, "tx");
console.log("Диапазон", JSON.stringify(a.range ?? {}));
