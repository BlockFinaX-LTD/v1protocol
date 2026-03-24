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

const DIAMOND_ABI = [
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address _newOwner)",
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  const SAFE_ADDRESS    = process.env.SAFE_ADDRESS;

  if (!DIAMOND_ADDRESS || !SAFE_ADDRESS) {
    throw new Error("Set DIAMOND_ADDRESS and SAFE_ADDRESS env vars");
  }

  const diamond = new hre.ethers.Contract(DIAMOND_ADDRESS, DIAMOND_ABI, deployer);

  const pendingOwner = await diamond.pendingOwner();

  console.log("Diamond:        ", DIAMOND_ADDRESS);
  console.log("Deployer:       ", deployer.address);
  console.log("Pending owner:  ", pendingOwner);
  console.log("Safe address:   ", SAFE_ADDRESS);

  if (pendingOwner.toLowerCase() === SAFE_ADDRESS.toLowerCase()) {
    console.log("\nTransfer already initiated — Safe just needs to call acceptOwnership()");
    console.log("Run safe-create-tx.js with ACTION=acceptOwnership");
    return;
  }

  console.log("\nInitiating ownership transfer...");
  const tx = await diamond.transferOwnership(SAFE_ADDRESS);
  const receipt = await tx.wait();
  console.log("Tx hash:        ", receipt.hash);

  const newPending = await diamond.pendingOwner();
  console.log("Pending owner now:", newPending);
  console.log("\n✅ Step 1 done — Safe must now call acceptOwnership() to complete the transfer.");
  console.log("   DIAMOND_ADDRESS=" + DIAMOND_ADDRESS + " SAFE_ADDRESS=" + SAFE_ADDRESS + " ACTION=acceptOwnership");
  console.log("   SIGNER_A_KEY=0x... SIGNER_B_KEY=0x... npx hardhat run scripts/safe-create-tx.js --network liskSepolia");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
