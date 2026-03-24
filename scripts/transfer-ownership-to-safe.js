/**
 * Transfers Diamond ownership to a Gnosis Safe (two-step via Ownable2Step).
 *
 * Step 1 (this script): current owner calls transferOwnership(safeAddress)
 * Step 2: Safe executes acceptOwnership() via safe-create-tx.js
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... SAFE_ADDRESS=0x... \
 *     npx hardhat run scripts/transfer-ownership-to-safe.js --network liskSepolia
 */

const hre = require("hardhat");

const OWNABLE2STEP_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  const SAFE_ADDRESS    = process.env.SAFE_ADDRESS;

  if (!DIAMOND_ADDRESS || !SAFE_ADDRESS) {
    throw new Error("Set DIAMOND_ADDRESS and SAFE_ADDRESS env vars");
  }

  const diamond = new hre.ethers.Contract(DIAMOND_ADDRESS, OWNABLE2STEP_ABI, deployer);

  const currentOwner  = await diamond.owner();
  const pendingOwner  = await diamond.pendingOwner();

  console.log("Diamond:        ", DIAMOND_ADDRESS);
  console.log("Current owner:  ", currentOwner);
  console.log("Pending owner:  ", pendingOwner);
  console.log("Safe address:   ", SAFE_ADDRESS);
  console.log("Deployer:       ", deployer.address);

  if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not the current owner (owner is ${currentOwner})`);
  }

  if (pendingOwner.toLowerCase() === SAFE_ADDRESS.toLowerCase()) {
    console.log("\nTransfer already initiated — Safe just needs to call acceptOwnership()");
    console.log("Run safe-create-tx.js with action=acceptOwnership");
    return;
  }

  console.log("\nInitiating ownership transfer...");
  const tx = await diamond.transferOwnership(SAFE_ADDRESS);
  const receipt = await tx.wait();
  console.log("Tx hash:        ", receipt.hash);

  const newPending = await diamond.pendingOwner();
  console.log("Pending owner now:", newPending);
  console.log("\n✅ Step 1 done — Safe must now call acceptOwnership() to complete the transfer.");
  console.log("   Run: DIAMOND_ADDRESS=" + DIAMOND_ADDRESS + " SAFE_ADDRESS=" + SAFE_ADDRESS);
  console.log("        npx hardhat run scripts/safe-create-tx.js --network liskSepolia");
  console.log("        (set ACTION=acceptOwnership in that script)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
