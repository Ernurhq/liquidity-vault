// Шаг 10 (неделя 13): vault забирает накопленные комиссии позиции.
import { collectLp, run } from "./lp";

run(async () => {
  await collectLp();
});
