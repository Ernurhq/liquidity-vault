// Шаг 7 (неделя 13): создаём запись о позиции vault (один раз). Запускает администратор.
import { SystemProgram } from "@solana/web3.js";
import { connection, link, owner, run, saveAddresses, send, setup } from "./lp";

run(async () => {
  const S = await setup();
  if (await connection.getAccountInfo(S.lpPosition)) {
    console.log("Запись о позиции уже создана:", S.lpPosition.toBase58());
    saveAddresses({ lpPositionPda: S.lpPosition.toBase58() });
    return;
  }
  const ix = await S.program.methods
    .initLpPosition()
    .accountsStrict({
      vaultState: S.p.vaultState,
      admin: owner.publicKey,
      swapPool: S.p.swapPool,
      lpPosition: S.lpPosition,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const sig = await send([ix], [], 200_000);
  saveAddresses({ lpPositionPda: S.lpPosition.toBase58(), lpInitTx: sig });
  console.log("Запись о позиции создана:", S.lpPosition.toBase58());
  console.log("Tx", link("tx", sig));
});
