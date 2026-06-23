/**
 * remove-orphans-v8.js — removes selectors still routed to OLD HedgeFacet/OracleFacet
 * after a v8 upgrade. These are functions whose selector changed in v8 (tuple shape
 * changes) — most importantly the OLD createEvent signature, which would let an
 * attacker bypass signature enforcement.
 *
 * Reads the registered facets via Loupe, finds any address other than the new
 * Hedge / Oracle / DiamondCut / DiamondLoupe / TimelockCut, and removes ALL its
 * selectors via a Remove cut (action = 2, facetAddress = address(0) per EIP-2535).
 *
 * Usage:
 *   NEW_HEDGE_FACET=0x... NEW_ORACLE_FACET=0x... \
 *     npx hardhat run scripts/remove-orphans-v8.js --network <name>
 */

const hre = require("hardhat");
const { ethers } = hre;

const CHAIN_DIAMOND_ENV = {
  8453: "BASE_DIAMOND_ADDRESS",
  56:   "BSC_DIAMOND_ADDRESS",
};

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const envKey = CHAIN_DIAMOND_ENV[chainId];
  const DIAMOND = process.env[envKey];
  if (!DIAMOND) throw new Error(`Set ${envKey}`);

  const NEW_HEDGE  = process.env.NEW_HEDGE_FACET;
  const NEW_ORACLE = process.env.NEW_ORACLE_FACET;
  if (!NEW_HEDGE || !NEW_ORACLE) {
    throw new Error("Set NEW_HEDGE_FACET and NEW_ORACLE_FACET to the just-deployed v8 facet addresses");
  }

  const [deployer] = await ethers.getSigners();
  console.log("\n" + "=".repeat(64));
  console.log(" Remove orphan selectors after v8 upgrade");
  console.log("=".repeat(64));
  console.log("network:", hre.network.name, "chainId:", chainId);
  console.log("diamond:", DIAMOND);
  console.log("keep facets: NEW_HEDGE =", NEW_HEDGE, ", NEW_ORACLE =", NEW_ORACLE);

  const Loupe = await ethers.getContractAt(
    [
      "function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])",
    ],
    DIAMOND
  );

  const facets = await Loupe.facets();
  const keepLower = new Set([
    NEW_HEDGE.toLowerCase(),
    NEW_ORACLE.toLowerCase(),
  ]);

  // Always KEEP these by name-matching against known facet sources via getCode hash —
  // simpler heuristic: just keep facets whose selector list contains diamondCut() or
  // facetAddresses(). These are the Cut and Loupe facets which we never touch.
  const cutSel    = ethers.id("diamondCut((address,uint8,bytes4[])[],address,bytes)").slice(0, 10);
  const loupeSel  = ethers.id("facets()").slice(0, 10);
  const tlExecSel = ethers.id("executeCut(bytes32)").slice(0, 10);

  const orphans = [];
  for (const f of facets) {
    if (keepLower.has(f.facetAddress.toLowerCase())) continue;
    const sels = f.functionSelectors;
    const isCut    = sels.some(s => s.toLowerCase() === cutSel);
    const isLoupe  = sels.some(s => s.toLowerCase() === loupeSel);
    const isTimelock = sels.some(s => s.toLowerCase() === tlExecSel);
    if (isCut || isLoupe || isTimelock) {
      console.log(`  KEEP   ${f.facetAddress}  (${sels.length} selectors — ${isCut ? "cut" : isLoupe ? "loupe" : "timelock"})`);
      continue;
    }
    console.log(`  ORPHAN ${f.facetAddress}  (${sels.length} selectors to Remove)`);
    for (const s of sels) console.log(`           ${s}`);
    orphans.push({ facetAddress: f.facetAddress, selectors: [...sels] });
  }

  // Filter to non-empty orphans — empty ones are facets that previously had all their
  // selectors moved away; they're harmless leftovers in the loupe and the cut would
  // revert with "LibDiamondCut: No selectors in facet to cut".
  const nonEmpty = orphans.filter(o => o.selectors.length > 0);

  if (nonEmpty.length === 0) {
    console.log("\nNo orphans with selectors found. Nothing to do.\n");
    return;
  }

  // Build Remove cuts. Per EIP-2535 the facetAddress on Remove is address(0).
  const cuts = nonEmpty.map(o => ({
    facetAddress: ethers.ZeroAddress,
    action: 2,                                 // Remove
    functionSelectors: o.selectors,
  }));

  console.log("\nExecuting diamondCut to remove orphans...");
  const Cut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND);
  const tx = await Cut.diamondCut(cuts, ethers.ZeroAddress, "0x");
  console.log("  tx:", tx.hash);
  const r = await tx.wait();
  console.log("  confirmed in block:", r.blockNumber, "gas:", r.gasUsed.toString());

  // Verify
  const after = await Loupe.facets();
  console.log("\nFacet table AFTER cut:");
  for (const f of after) {
    console.log(`  ${f.facetAddress}  ${f.functionSelectors.length} selector(s)`);
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
