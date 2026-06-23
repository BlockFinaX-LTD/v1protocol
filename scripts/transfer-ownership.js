/**
 * transfer-ownership.js — change the Diamond's owner (the "deployer") to a new address.
 *
 * This is the FIRST half of the two-step ownership transfer (EIP-2535 + LibDiamond):
 *   1. current owner calls transferOwnership(newOwner)   ← this script
 *   2. newOwner calls acceptOwnership()                  ← done separately
 *
 * If newOwner is the Gnosis Safe, finalise step 2 with the Safe tooling:
 *   ACTION=acceptOwnership ... npx hardhat run scripts/safe-create-tx.js --network <net>
 *
 * The current owner is UNCHANGED until acceptOwnership() runs, so a wrong address
 * cannot lock you out.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY                 — must be the CURRENT owner
 *   BASE_DIAMOND_ADDRESS / BSC_DIAMOND_ADDRESS  (auto-picked by chainId)
 * Optional env:
 *   NEW_OWNER=0x...   — target owner. Defaults to the known Safe for the chain.
 *
 * Usage:
 *   npx hardhat run scripts/transfer-ownership.js --network base
 *   NEW_OWNER=0xYourSafe npx hardhat run scripts/transfer-ownership.js --network bsc
 */

const hre = require("hardhat");
const { ethers } = hre;

const CHAINS = {
  8453: { diamondEnv: "BASE_DIAMOND_ADDRESS", safe: "0x7909a2f1fAd63678eEDcC5A75462B66D062189Bb" },
  56:   { diamondEnv: "BSC_DIAMOND_ADDRESS",  safe: "0x2a0ab363E01b518B189218e39f79Bfc3AE310807" },
};

// LibDiamond.DiamondStorage: contractOwner is field index 4, pendingOwner index 5.
const DS_POS = ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.diamond.storage"));
const OWNER_SLOT   = "0x" + (BigInt(DS_POS) + 4n).toString(16).padStart(64, "0");
const PENDING_SLOT = "0x" + (BigInt(DS_POS) + 5n).toString(16).padStart(64, "0");

const OWN_ABI = ["function transferOwnership(address) external"];

async function readAddr(provider, diamond, slot) {
  const hex = await provider.getStorage(diamond, slot);
  return ethers.getAddress("0x" + hex.slice(-40));
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const cfg = CHAINS[chainId];
  if (!cfg) throw new Error(`Unsupported chainId ${chainId}; use --network base or bsc`);

  const diamond = process.env[cfg.diamondEnv];
  if (!diamond) throw new Error(`Set ${cfg.diamondEnv}`);

  const newOwner = process.env.NEW_OWNER || cfg.safe;
  if (!ethers.isAddress(newOwner)) throw new Error(`Invalid NEW_OWNER: ${newOwner}`);

  const [signer] = await ethers.getSigners();
  const currentOwner = await readAddr(ethers.provider, diamond, OWNER_SLOT);

  console.log("\n" + "=".repeat(60));
  console.log(" Transfer Diamond ownership");
  console.log("=".repeat(60));
  console.log("network      :", hre.network.name, `(chainId ${chainId})`);
  console.log("diamond      :", diamond);
  console.log("current owner:", currentOwner);
  console.log("signer       :", signer.address);
  console.log("new owner    :", newOwner, newOwner.toLowerCase() === cfg.safe.toLowerCase() ? "(= Safe)" : "");

  if (currentOwner.toLowerCase() === newOwner.toLowerCase()) {
    console.log("\nNew owner equals current owner — nothing to do.");
    return;
  }
  if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer is not the current owner (${currentOwner}). Aborting — only the owner can transfer.`);
  }

  const diamondC = new ethers.Contract(diamond, OWN_ABI, signer);
  console.log("\nSending transferOwnership...");
  const tx = await diamondC.transferOwnership(newOwner);
  console.log("tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("confirmed in block", receipt.blockNumber);

  const pending = await readAddr(ethers.provider, diamond, PENDING_SLOT);
  console.log("\npendingOwner is now:", pending);
  console.log("Owner is STILL:", await readAddr(ethers.provider, diamond, OWNER_SLOT), "(unchanged until accept)");
  console.log("\nNEXT (step 2): the new owner must call acceptOwnership() to finalise.");
  if (newOwner.toLowerCase() === cfg.safe.toLowerCase()) {
    console.log("  Safe path: ACTION=acceptOwnership DIAMOND_ADDRESS=" + diamond +
      " SAFE_ADDRESS=" + cfg.safe + " npx hardhat run scripts/safe-create-tx.js --network " + hre.network.name);
  }
}

main().catch((e) => { console.error("\nFailed:", e.message || e); process.exitCode = 1; });
