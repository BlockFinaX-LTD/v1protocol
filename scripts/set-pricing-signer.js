/**
 * set-pricing-signer.js — calls setPricingEngineSigner(addr) on the Diamond.
 *
 * Once this is executed, every subsequent createEvent() MUST carry a valid ECDSA
 * signature from this address. To DISABLE enforcement temporarily, run with
 * PRICING_ENGINE_SIGNER=0x0000…0000 (zero address).
 *
 * Reads:
 *   PRICING_ENGINE_SIGNER (address) — defaults to the public address derived from
 *                                     PRICING_ENGINE_PRIVATE_KEY in the root .env
 *
 * Usage:
 *   npx hardhat run scripts/set-pricing-signer.js --network base
 *   npx hardhat run scripts/set-pricing-signer.js --network bsc
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
  if (!envKey) throw new Error(`Unknown chainId ${chainId}`);
  const DIAMOND_ADDRESS = process.env[envKey];
  if (!DIAMOND_ADDRESS) throw new Error(`Set ${envKey} env var`);

  const [deployer] = await ethers.getSigners();

  // Resolve the signer address — env override OR derive from the private key.
  let signerAddr = process.env.PRICING_ENGINE_SIGNER;
  if (!signerAddr) {
    const pk = process.env.PRICING_ENGINE_PRIVATE_KEY;
    if (!pk) throw new Error("Set either PRICING_ENGINE_SIGNER or PRICING_ENGINE_PRIVATE_KEY");
    const wallet = new ethers.Wallet(pk);
    signerAddr = wallet.address;
  }

  console.log("\n" + "=".repeat(64));
  console.log(" Set pricing-engine signer on Diamond");
  console.log("=".repeat(64));
  console.log("network: ", hre.network.name);
  console.log("diamond: ", DIAMOND_ADDRESS);
  console.log("caller:  ", deployer.address);
  console.log("setting signer to:", signerAddr);

  const Hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND_ADDRESS);

  const current = await Hedge.getPricingEngineSigner();
  console.log("current signer:", current);
  if (current.toLowerCase() === signerAddr.toLowerCase()) {
    console.log("\nAlready set to this address — nothing to do.\n");
    return;
  }

  const tx = await Hedge.setPricingEngineSigner(signerAddr);
  console.log("\ntx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("confirmed in block:", receipt.blockNumber, "gas used:", receipt.gasUsed.toString());

  const after = await Hedge.getPricingEngineSigner();
  console.log("new signer:", after);

  if (after === ethers.ZeroAddress) {
    console.log("\n⚠ Signer set to zero — enforcement DISABLED on this Diamond.");
  } else {
    console.log("\n✓ Enforcement ACTIVE — every createEvent() now requires a valid signature.");
  }
}

main().catch((err) => {
  console.error("\nFailed:", err);
  process.exitCode = 1;
});
