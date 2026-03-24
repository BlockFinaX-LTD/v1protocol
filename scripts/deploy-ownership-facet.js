const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  if (!DIAMOND_ADDRESS) throw new Error("Set DIAMOND_ADDRESS env var");

  console.log("Deployer:", deployer.address);
  console.log("Diamond: ", DIAMOND_ADDRESS);

  const OwnershipFacet = await hre.ethers.getContractFactory("BlockFinaXOwnershipFacet");
  const facet = await OwnershipFacet.deploy();
  await facet.waitForDeployment();
  const facetAddress = await facet.getAddress();
  console.log("OwnershipFacet deployed:", facetAddress);

  const selectors = facet.interface.fragments
    .filter((f) => f.type === "function")
    .map((f) => f.selector);

  selectors.forEach((sel) => {
    const frag = facet.interface.fragments.find((f) => f.type === "function" && f.selector === sel);
    console.log(" ", sel, frag?.name);
  });

  const DiamondCut = await hre.ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND_ADDRESS);
  const tx = await DiamondCut.diamondCut(
    [{ facetAddress, action: 0, functionSelectors: selectors }],
    hre.ethers.ZeroAddress,
    "0x"
  );
  const receipt = await tx.wait();
  console.log("diamondCut tx:", receipt.hash);
  console.log("OwnershipFacet is live on the Diamond");
  console.log("\nNext:");
  console.log("  DIAMOND_ADDRESS=" + DIAMOND_ADDRESS + " SAFE_ADDRESS=<safe> npx hardhat run scripts/transfer-ownership-to-safe.js --network liskSepolia");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
