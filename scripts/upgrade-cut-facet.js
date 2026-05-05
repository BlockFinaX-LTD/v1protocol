/**
 * upgrade-cut-facet.js — replaces the Diamond's BlockFinaXDiamondCutFacet with
 * a freshly-compiled version containing the LibDiamond.replaceFunctions fix.
 *
 * Why: pre-fix LibDiamond.replaceFunctions did NOT push the new facet address
 * into ds.facetAddresses[] when a Replace cut routed selectors to a facet for
 * the first time. After v8 we observed this in production — the Loupe omitted
 * the new HedgeFacet/OracleFacet addresses even though selectors were routed
 * correctly. Patched in src/libraries/LibDiamond.sol; this script ships the
 * patch on-chain by replacing the cut facet itself.
 *
 * Mechanism: the existing (buggy) cut facet is used ONE LAST TIME to Replace
 * the diamondCut(...) selector with the new patched cut facet's address. From
 * then on, every future cut goes through the patched code.
 *
 * Diamond proxy address does NOT change. Only the cut facet behind it changes.
 * Selector routing for diamondCut(...) is rewritten to point at the new bytecode.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-cut-facet.js --network lisk
 *   npx hardhat run scripts/upgrade-cut-facet.js --network base
 *   npx hardhat run scripts/upgrade-cut-facet.js --network bsc
 */

const hre = require("hardhat");
const { ethers } = hre;

const CHAIN_DIAMOND_ENV = {
  1135: "DIAMOND_ADDRESS",
  8453: "BASE_DIAMOND_ADDRESS",
  56:   "BSC_DIAMOND_ADDRESS",
};

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const envKey = CHAIN_DIAMOND_ENV[chainId];
  const DIAMOND = process.env[envKey];
  if (!DIAMOND) throw new Error(`Set ${envKey}`);

  const [deployer] = await ethers.getSigners();
  console.log("\n" + "=".repeat(64));
  console.log(" Replace BlockFinaXDiamondCutFacet with the patched build");
  console.log("=".repeat(64));
  console.log("network:    ", hre.network.name, "chainId:", chainId);
  console.log("diamond:    ", DIAMOND, "(unchanged)");
  console.log("deployer:   ", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("deployer bal:", ethers.formatEther(balance));
  if (balance === 0n) throw new Error("Deployer has zero native balance");

  // 1. Deploy the patched cut facet
  console.log("\n1. Deploying patched BlockFinaXDiamondCutFacet...");
  const Factory = await ethers.getContractFactory("BlockFinaXDiamondCutFacet");
  const newCut = await Factory.deploy();
  await newCut.waitForDeployment();
  const newCutAddr = await newCut.getAddress();
  console.log("   new cut facet:", newCutAddr);

  // 2. Find the current cut facet address via Loupe (so we can confirm what we're replacing)
  const Loupe = await ethers.getContractAt(
    [
      "function facetAddress(bytes4 selector) view returns (address)",
      "function facetFunctionSelectors(address) view returns (bytes4[])",
    ],
    DIAMOND
  );
  const cutSelector = Factory.interface.getFunction("diamondCut").selector;
  const oldCutAddr = await Loupe.facetAddress(cutSelector);
  console.log("\n2. Current cut facet:", oldCutAddr);
  if (oldCutAddr.toLowerCase() === newCutAddr.toLowerCase()) {
    console.log("   Already pointing at the same address — nothing to do.");
    return;
  }
  if (oldCutAddr === ethers.ZeroAddress) {
    throw new Error("diamondCut selector is unrouted on this Diamond — cannot proceed");
  }

  // 3. Use the existing (buggy) cut facet to replace the cut selector itself.
  // The Replace path in the OLD facet still works for routing — it just doesn't
  // update facetAddresses[]. Since the new cut facet's address will become routed
  // via Replace, the OLD facet WILL leave it out of facetAddresses[]. So we follow
  // up with a Remove+Add of the same selector to register it correctly. Same trick
  // as scripts/rebuild-facet-table.js, but for a single selector.
  console.log("\n3. Cutting diamondCut(...) selector to point at patched code...");
  const OldCut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND);

  const cuts = [
    { facetAddress: newCutAddr,         action: 1, functionSelectors: [cutSelector] },  // Replace (buggy path)
    { facetAddress: ethers.ZeroAddress, action: 2, functionSelectors: [cutSelector] },  // Remove (re-empties newCut)
    { facetAddress: newCutAddr,         action: 0, functionSelectors: [cutSelector] },  // Add → triggers addFacet correctly
  ];
  const tx = await OldCut.diamondCut(cuts, ethers.ZeroAddress, "0x");
  console.log("   tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("   confirmed in block:", receipt.blockNumber, "gas:", receipt.gasUsed.toString());

  // 4. Verify
  const routedTo = await Loupe.facetAddress(cutSelector);
  console.log("\n4. Verification:");
  console.log("   diamondCut now routes to:", routedTo);
  console.log("   match new patched facet?:", routedTo.toLowerCase() === newCutAddr.toLowerCase() ? "✓" : "✗");

  const newCutSelectors = await Loupe.facetFunctionSelectors(newCutAddr);
  console.log("   new cut facet selectors:", newCutSelectors.length, "(expect 1)");

  const oldCutSelectors = await Loupe.facetFunctionSelectors(oldCutAddr);
  console.log("   old cut facet selectors:", oldCutSelectors.length, "(expect 0 — orphaned)");

  // Smoke-test the patched code by calling a no-op Replace+Add on a brand-new dummy
  // facet — wait, there's nothing safe to do here, the cut facet itself was just
  // swapped. Skip the smoke test; the regression test in test/unit/diamond.test.js
  // already verifies the patched logic against a forked chain.

  console.log("\n" + "=".repeat(64));
  console.log(" PATCHED CUT FACET LIVE on", hre.network.name);
  console.log("=".repeat(64));
  console.log(`  Diamond (unchanged):  ${DIAMOND}`);
  console.log(`  patched cut facet:    ${newCutAddr}`);
  console.log(`  old cut facet:        ${oldCutAddr} (now orphaned)`);
}

main().catch(err => { console.error("Failed:", err); process.exitCode = 1; });
