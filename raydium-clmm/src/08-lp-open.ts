// Шаг 8 (неделя 13): vault открывает позицию в диапазоне ±RANGE вокруг текущей цены.
//   npm run lp-open                 диапазон ±5% (по умолчанию)
//   RANGE=0.1 npm run lp-open       диапазон ±10%
// Перед этим в vault должны лежать ОБА токена (часть токена A можно обменять в B: npm run vault-swap).
import { openLp, run } from "./lp";

run(async () => {
  const range = Number(process.env.RANGE ?? "0.05");
  if (!(range > 0 && range < 0.9)) throw new Error("RANGE должен быть между 0 и 0.9, например 0.05");
  await openLp(range);
});
