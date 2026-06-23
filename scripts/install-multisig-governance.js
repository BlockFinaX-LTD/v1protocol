/**
 * install-multisig-governance.js — wire an EXISTING Diamond for multisig + 48h timelock
 * governance, so that all future upgrades require: propose → 48h delay → Safe executes.
 *
 * Run this once per chain, signed by the CURRENT owner (the deployer EOA). It:
 *   1. Deploys a fresh BlockFinaXTimelockCutFacet.
 *   2. Cuts it in — Adds the timelock-only selectors (executeCut, cancelCut, getProposal,
 *      getAllCutIds, getPendingCutIds, getPendingCutInfo, + constants) and Replaces the
 *      diamondCut(...) selector to route through the timelock. (Add is ordered before
 *      Replace so the facet is registered in facetAddresses[] even if the on-chain cut
 *      facet predates the LibDiamond.replaceFunctions fix.)
 *   3. Transfers ownership to the Safe (step 1 of the two-step handover).
 *
 * After this script, the Safe must call acceptOwnership() to finalise (step 2) — until then
 * the deployer EOA is still owner, so a misconfiguration cannot lock you out.
 *
 * IMPORTANT ordering: the cut (step 2) is done while the EOA is still owner and the
 * diamondCut selector still points at the IMMEDIATE cut facet. Ownership is transferred
 * LAST. Do not transfer ownership before installing the timelock, or you won't be able to
 * cut as the EOA anymore.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY                        — must be the CURRENT owner
 *   BASE_DIAMOND_ADDRESS / BSC_DIAMOND_ADDRESS  (auto-picked by chainId)
 * Optional env:
 *   SAFE_ADDRESS=0x...     — override the target Safe (defaults to the known Safe per chain)
 *   SKIP_OWNERSHIP=1       — install the timelock but DON'T transfer ownership yet
 *
 * Usage:
 *   npx hardhat run scripts/install-multisig-governance.js --network base
 *   npx hardhat run scripts/install-multisig-governance.js --network bsc
 */

const hre = require("hardhat");
const { ethers } = hre;

const CHAINS = {
  8453: { diamondEnv: "BASE_DIAMOND_ADDRESS", safe: "0x7909a2f1fAd63678eEDcC5A75462B66D062189Bb" },
  56:   { diamondEnv: "BSC_DIAMOND_ADDRESS",  safe: "0x2a0ab363E01b518B189218e39f79Bfc3AE310807" },
};

const DS_POS = ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.diamond.storage"));
const OWNER_SLOT = "0x" + (BigInt(DS_POS) + 4n).toString(16).padStart(64, "0");

const LOUPE_ABI = ["function facetAddress(bytes4) view returns (address)"];
const OWN_ABI   = ["function transferOwnership(address) external"];

function selectorsOf(contract) {
  return contract.interface.fragments
    .filter((f) => f.type === "function")
    .map((f) => contract.interface.getFunction(f.name).selector);
}

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
  const safe = process.env.SAFE_ADDRESS || cfg.safe;
  if (!ethers.isAddress(safe)) throw new Error(`Invalid SAFE_ADDRESS: ${safe}`);

  const [signer] = await ethers.getSigners();
  const currentOwner = await readAddr(ethers.provider, diamond, OWNER_SLOT);

  console.log("\n" + "=".repeat(64));
  console.log(" Install multisig + 48h timelock governance");
  console.log("=".repeat(64));
  console.log("network      :", hre.network.name, `(chainId ${chainId})`);
  console.log("diamond      :", diamond);
  console.log("current owner:", currentOwner);
  console.log("signer       :", signer.address);
  console.log("target Safe  :", safe);

  if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer is not the current owner (${currentOwner}). Aborting.`);
  }

  const loupe = new ethers.Contract(diamond, LOUPE_ABI, ethers.provider);

  // ── 1. Deploy the timelock cut facet ─────────────────────────────────────
  console.log("\n1. Deploying BlockFinaXTimelockCutFacet...");
  const Timelock = await ethers.getContractFactory("BlockFinaXTimelockCutFacet");
  const tl = await Timelock.deploy();
  await tl.waitForDeployment();
  const tlAddr = await tl.getAddress();
  console.log("   timelock facet:", tlAddr);

  const cutSel  = tl.interface.getFunction("diamondCut").selector;
  const execSel = tl.interface.getFunction("executeCut").selector;

  // ── 2. Cut it in (skip if a timelock already serves executeCut) ───────────
  const existingExec = await loupe.facetAddress(execSel);
  if (existingExec !== ethers.ZeroAddress) {
    console.log(`\n2. Timelock already installed (executeCut -> ${existingExec}). Skipping cut.`);
  } else {
    const others = selectorsOf(tl).filter((s) => s !== cutSel);
    // Add FIRST (registers the facet in facetAddresses[] regardless of cut-facet version),
    // then Replace the diamondCut selector to route future cuts through the timelock.
    const cuts = [
      { facetAddress: tlAddr, action: 0, functionSelectors: others },   // Add
      { facetAddress: tlAddr, action: 1, functionSelectors: [cutSel] }, // Replace
    ];
    console.log(`\n2. Cutting in timelock (${others.length} Add, 1 Replace) via the current cut facet...`);
    const DiamondCut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", diamond);
    const tx = await DiamondCut.diamondCut(cuts, ethers.ZeroAddress, "0x");
    console.log("   tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("   confirmed in block", receipt.blockNumber);

    // Verify routing.
    const cutNow  = await loupe.facetAddress(cutSel);
    const execNow = await loupe.facetAddress(execSel);
    const ok = cutNow.toLowerCase() === tlAddr.toLowerCase() && execNow.toLowerCase() === tlAddr.toLowerCase();
    console.log("   diamondCut ->", cutNow);
    console.log("   executeCut ->", execNow);
    console.log("   timelock routed:", ok ? "✓" : "✗ — investigate before transferring ownership");
    if (!ok) throw new Error("Timelock routing verification failed; NOT transferring ownership.");
  }

  // ── 3. Transfer ownership to the Safe (step 1 of two-step) ────────────────
  if (process.env.SKIP_OWNERSHIP === "1") {
    console.log("\n3. SKIP_OWNERSHIP=1 set — leaving ownership with the deployer for now.");
  } else if (currentOwner.toLowerCase() === safe.toLowerCase()) {
    console.log("\n3. Diamond already owned by the Safe — nothing to transfer.");
  } else {
    console.log("\n3. Transferring ownership to the Safe...");
    const own = new ethers.Contract(diamond, OWN_ABI, signer);
    const tx2 = await own.transferOwnership(safe);
    console.log("   tx:", tx2.hash);
    await tx2.wait();
    console.log("   pendingOwner set to the Safe (owner unchanged until the Safe accepts).");
  }

  console.log("\n" + "=".repeat(64));
  console.log(" DONE on", hre.network.name);
  console.log("=".repeat(64));
  console.log("  Timelock facet:", tlAddr);
  console.log("\n  Step 2 — the Safe must finalise ownership:");
  console.log("    ACTION=acceptOwnership DIAMOND_ADDRESS=" + diamond +
    " SAFE_ADDRESS=" + safe + " npx hardhat run scripts/safe-create-tx.js --network " + hre.network.name);
  console.log("\n  After that, every upgrade is: propose diamondCut (Safe) → wait 48h → executeCut (Safe).");
}

main().catch((e) => { console.error("\nFailed:", e.message || e); process.exitCode = 1; });
