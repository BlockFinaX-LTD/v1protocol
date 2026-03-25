/**
 * upgrade-oracle-facet.js
 *
 * Upgrades BlockFinaXOracleFacet in-place — Replaces all existing Oracle selectors
 * in the Diamond with the new implementation, and Adds any brand-new selectors.
 *
 * Audit fixes included in this upgrade:
 *   - H003: nonReentrant modifier added to submitRate (shared AppStorage lock)
 *   - G001: array lengths cached before loops
 *   - G011: pre-increment (++i) used in all loops
 *   - L002: locked pragma 0.8.20
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade-oracle-facet.js --network liskSepolia
 */

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  if (!DIAMOND_ADDRESS) throw new Error("Set DIAMOND_ADDRESS env var");

  console.log("Deployer:", deployer.address);
  console.log("Diamond: ", DIAMOND_ADDRESS);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance: ", ethers.formatEther(balance), "LSK\n");

  // Deploy the new OracleFacet
  console.log("Deploying BlockFinaXOracleFacet (audit-patched)...");
  const OracleFacet = await ethers.getContractFactory("BlockFinaXOracleFacet");
  const oracleFacet = await OracleFacet.deploy();
  await oracleFacet.waitForDeployment();
  const oracleAddress = await oracleFacet.getAddress();
  console.log("New OracleFacet:", oracleAddress);

  // Get all selectors from the new facet's ABI
  const allSelectors = OracleFacet.interface.fragments
    .filter(f => f.type === "function")
    .map(f => OracleFacet.interface.getFunction(f.name).selector);

  console.log("\nAll selectors from ABI:", allSelectors.length);

  // Query the Diamond loupe to classify each selector
  const DiamondLoupe = await ethers.getContractAt(
    ["function facetAddress(bytes4 selector) view returns (address)"],
    DIAMOND_ADDRESS
  );

  const toReplaceSelectors = [];
  const toAddSelectors = [];
  for (const sel of allSelectors) {
    const facet = await DiamondLoupe.facetAddress(sel);
    if (facet === ethers.ZeroAddress) {
      toAddSelectors.push(sel);
    } else {
      toReplaceSelectors.push(sel);
    }
  }

  console.log("Selectors to Replace (exist in Diamond):", toReplaceSelectors.length);
  console.log("Selectors to Add     (new to Diamond)  :", toAddSelectors.length);
  if (toAddSelectors.length > 0) {
    const names = toAddSelectors.map(sel => {
      const frag = OracleFacet.interface.fragments.find(
        f => f.type === "function" && f.selector === sel
      );
      return `  ${sel}  ${frag ? frag.name : "unknown"}`;
    });
    console.log("New selectors:\n" + names.join("\n"));
  }

  // Build diamondCut actions
  const cuts = [];
  if (toReplaceSelectors.length > 0) {
    cuts.push({ facetAddress: oracleAddress, action: 1, functionSelectors: toReplaceSelectors });
  }
  if (toAddSelectors.length > 0) {
    cuts.push({ facetAddress: oracleAddress, action: 0, functionSelectors: toAddSelectors });
  }

  if (cuts.length === 0) {
    console.log("\nNo selectors to cut — nothing to do.");
    return;
  }

  console.log("\nExecuting diamondCut...");
  const DiamondCut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND_ADDRESS);
  const tx = await DiamondCut.diamondCut(cuts, ethers.ZeroAddress, "0x");
  const receipt = await tx.wait();
  console.log("diamondCut tx:", receipt.hash);
  console.log("\nOracleFacet (audit-patched) is live at:", oracleAddress);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
