const hre = require("hardhat");
const fs = require("node:fs");
async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 84532) throw new Error("Only Base Sepolia sandbox settlement is supported");
  const manifest = JSON.parse(fs.readFileSync(`deployments/sandbox-${hre.network.name}-${chainId}.json`, "utf8"));
  if (manifest.environment !== "sandbox" || manifest.chainId !== chainId) throw new Error("Invalid sandbox manifest");
  const id = process.env.SANDBOX_EVENT_ID;
  const rate = process.env.SANDBOX_SETTLEMENT_RATE;
  if (!id || !/^\d+$/.test(id) || !rate || !/^\d+(\.\d{1,6})?$/.test(rate)) throw new Error("Set SANDBOX_EVENT_ID and SANDBOX_SETTLEMENT_RATE (e.g. 12)");
  const hedge = await hre.ethers.getContractAt("BlockFinaXHedgeFacet", manifest.diamond);
  const core = await hedge.getHedgeEventCore(id);
  const block = await hre.ethers.provider.getBlock("latest");
  if (BigInt(block.timestamp) < core.expiryDate) throw new Error("The pool has not expired; settlement must wait until expiry");
  const tx = await hedge.settleEvent(id, hre.ethers.parseUnits(rate, 6));
  await tx.wait();
  console.log(JSON.stringify({ environment: "sandbox", chainId, eventId: id, syntheticSettlementRate: rate, txHash: tx.hash }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
