/**
 * transfer-ownership-to-safe.js
 *
 * Step 1 of 2: Propose ownership transfer from the deployer wallet to the Gnosis Safe.
 * The Safe must call acceptOwnership() to complete the transfer.
 *
 * Diamond:     0x3eDfA00a1E3C158A591097de2FA1756aCD66860D
 * Current owner (deployer): 0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d
 * Proposed new owner (Safe): 0x60719b73880710a2A471C21140515A6Cc8305fDB
 */

const { ethers } = require("hardhat");

const DIAMOND    = "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D";
const GNOSIS_SAFE = "0x60719b73880710a2A471C21140515A6Cc8305fDB";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n=== Ownership Transfer — Step 1 of 2 ===");
  console.log("Diamond:       ", DIAMOND);
  console.log("Current owner: ", deployer.address);
  console.log("Proposed Safe: ", GNOSIS_SAFE);

  const hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND);

  console.log("\nSending transferOwnership()...");
  const tx = await hedge.transferOwnership(GNOSIS_SAFE);
  await tx.wait();
  console.log("tx:", tx.hash);

  // Confirm pending owner
  const pending = await hedge.pendingOwner();
  console.log("\nPending owner (confirmed on-chain):", pending);

  console.log("\n" + "=".repeat(55));
  console.log(" STEP 1 COMPLETE");
  console.log("=".repeat(55));
  console.log("\nNow go to your Gnosis Safe and execute:");
  console.log("  Contract: ", DIAMOND);
  console.log("  Function:  acceptOwnership()");
  console.log("  ABI:       function acceptOwnership() external");
  console.log("\nSafe app: https://app.safe.global/lisk:0x60719b73880710a2A471C21140515A6Cc8305fDB");
  console.log("\nThe deployer remains owner until the Safe calls acceptOwnership().");
  console.log("=".repeat(55));
}

main().catch(e => { console.error("Failed:", e.message); process.exit(1); });
