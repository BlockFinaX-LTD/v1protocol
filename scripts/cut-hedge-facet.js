/**
 * Deploys a fresh HedgeFacet and cuts all its selectors into the Diamond.
 * Selectors already registered in other facets are excluded.
 *
 * Required env vars:
 *   DIAMOND_ADDRESS — Diamond proxy address
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  if (!DIAMOND_ADDRESS) throw new Error("Set DIAMOND_ADDRESS env var");

  console.log("Deployer:", deployer.address);
  console.log("Diamond: ", DIAMOND_ADDRESS);

  // Pull the full registered selector list straight from the Loupe
  const loupeFrag = "function facets() external view returns (tuple(address facetAddress, bytes4[] functionSelectors)[] memory)";
  const Loupe = new hre.ethers.Contract(DIAMOND_ADDRESS, [loupeFrag], deployer);
  const facets = await Loupe.facets();
  const registered = new Set();
  facets.forEach((f) => f.functionSelectors.forEach((s) => registered.add(s.toLowerCase())));
  console.log("Selectors already in Diamond:", registered.size);

  // Deploy fresh HedgeFacet
  console.log("\nDeploying HedgeFacet...");
  const HedgeFacet = await hre.ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedgeFacet = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();
  const hedgeAddress = await hedgeFacet.getAddress();
  console.log("HedgeFacet deployed:", hedgeAddress);

  // Compute all selectors from the ABI, skip those already registered
  const allSelectors = hedgeFacet.interface.fragments
    .filter((f) => f.type === "function")
    .map((f) => ({ selector: f.selector, name: f.name }));

  const toAdd = allSelectors.filter(({ selector }) => !registered.has(selector.toLowerCase()));
  const skipped = allSelectors.filter(({ selector }) => registered.has(selector.toLowerCase()));

  console.log("\nTotal HedgeFacet functions:", allSelectors.length);
  if (skipped.length) console.log("Skipping (in other facets):", skipped.map((s) => s.name).join(", "));
  console.log("Adding:", toAdd.length, "selectors");
  toAdd.forEach(({ selector, name }) => console.log(" ", selector, name));

  if (toAdd.length === 0) {
    console.log("Nothing to add — already fully cut in.");
    return;
  }

  // diamondCut — action 0 = Add
  const DiamondCut = await hre.ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND_ADDRESS);
  const tx = await DiamondCut.diamondCut(
    [{ facetAddress: hedgeAddress, action: 0, functionSelectors: toAdd.map((s) => s.selector) }],
    hre.ethers.ZeroAddress,
    "0x"
  );
  const receipt = await tx.wait();
  console.log("\ndiamondCut tx:", receipt.hash);
  console.log("HedgeFacet is live. Address:", hedgeAddress);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
