/**
 * set-fee-new-diamonds.js
 * Sets creation fee to $2 on Lisk and Base new diamonds directly (no Safe).
 *
 * Usage:
 *   SAFE_OWNER_KEY_1=0x... npx hardhat run scripts/set-fee-new-diamonds.js --network lisk
 *   SAFE_OWNER_KEY_1=0x... npx hardhat run scripts/set-fee-new-diamonds.js --network base
 */
const hre = require("hardhat");

const DIAMONDS = {
  lisk: { address: "0x69cB5BA093e44B345B617f72a148Ee43c4a18465", decimals: 6 },
  base: { address: "0xbCC51E62C4948FD35ab505bd71804C849601e4Ef", decimals: 6 },
  bsc:  { address: "0xaC939C0897981Abc0711ec4e37527F13106180fc", decimals: 18 },
};

const FEE_ABI = [
  "function getHedgeFeeConfig() view returns (uint256, uint256, uint256, uint256, uint256)",
  "function initializeHedgeFees(uint256,uint256,uint256,uint256,uint256) external",
];

async function main() {
  const { ethers, network } = hre;
  const netName = network.name;
  const cfg = DIAMONDS[netName];
  if (!cfg) throw new Error(`Unsupported network: ${netName}. Use lisk, base, or bsc`);

  const key = process.env.DEPLOYER_PRIVATE_KEY || process.env.SAFE_OWNER_KEY_1;
  if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY or SAFE_OWNER_KEY_1");

  const signer = new ethers.Wallet(key, ethers.provider);
  console.log(`\nNetwork  : ${netName}`);
  console.log(`Diamond  : ${cfg.address}`);
  console.log(`Signer   : ${signer.address}`);

  const hedge = new ethers.Contract(cfg.address, FEE_ABI, signer);

  const fees = await hedge.getHedgeFeeConfig();
  const [currentFee, hedgerFeeRate, hedgerPayoutFeeRate, lpProfitFeeRate, creatorLoyaltyRate] = fees;
  console.log(`\nCurrent creation fee: $${ethers.formatUnits(currentFee, cfg.decimals)}`);

  const newFee = ethers.parseUnits("2", cfg.decimals);
  console.log(`Target creation fee : $2.00`);

  if (currentFee.toString() === newFee.toString()) {
    console.log("Already $2.00 — nothing to do.");
    return;
  }

  console.log(`\nSending initializeHedgeFees...`);
  const tx = await hedge.initializeHedgeFees(
    newFee, hedgerFeeRate, hedgerPayoutFeeRate, lpProfitFeeRate, creatorLoyaltyRate,
    { gasLimit: 120_000 }
  );
  console.log(`Tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber} (status=${receipt.status})`);

  const updated = await hedge.getHedgeFeeConfig();
  console.log(`\nNew creation fee on-chain: $${ethers.formatUnits(updated[0], cfg.decimals)} ✓`);
}

main().catch(e => { console.error("ERROR:", e.message || e); process.exitCode = 1; });
