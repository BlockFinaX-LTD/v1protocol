/**
 * Registers oracle wallets on the OracleFacet and sets the required signer threshold.
 *
 * Required env vars:
 *   DIAMOND_ADDRESS      — Diamond proxy address
 *   ORACLE_A_ADDRESS     — Oracle node A wallet address
 *   ORACLE_B_ADDRESS     — Oracle node B wallet address
 *   ORACLE_C_ADDRESS     — Oracle node C wallet address (optional)
 *   REQUIRED_SIGNERS     — Minimum signers for consensus (default 2)
 *   TOLERANCE_BPS        — Max rate spread in basis points (default 100 = 1%)
 */

const hre = require("hardhat");

const ORACLE_FACET_ABI = [
  "function addOracle(address _oracle) external",
  "function setRequiredSigners(uint256 _required) external",
  "function setToleranceBps(uint256 _bps) external",
  "function getOracleConfig() external view returns (uint256 required, uint256 tolerance, address[] memory oracles)",
  "function isAuthorisedOracle(address _oracle) external view returns (bool)",
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const DIAMOND_ADDRESS   = process.env.DIAMOND_ADDRESS;
  const ORACLE_A_ADDRESS  = process.env.ORACLE_A_ADDRESS;
  const ORACLE_B_ADDRESS  = process.env.ORACLE_B_ADDRESS;
  const ORACLE_C_ADDRESS  = process.env.ORACLE_C_ADDRESS;
  const REQUIRED_SIGNERS  = Number(process.env.REQUIRED_SIGNERS) || 2;
  const TOLERANCE_BPS     = Number(process.env.TOLERANCE_BPS) || 100;

  if (!DIAMOND_ADDRESS || !ORACLE_A_ADDRESS || !ORACLE_B_ADDRESS) {
    throw new Error("Set DIAMOND_ADDRESS, ORACLE_A_ADDRESS, ORACLE_B_ADDRESS env vars");
  }

  const oracle = new hre.ethers.Contract(DIAMOND_ADDRESS, ORACLE_FACET_ABI, deployer);

  const oracles = [ORACLE_A_ADDRESS, ORACLE_B_ADDRESS];
  if (ORACLE_C_ADDRESS) oracles.push(ORACLE_C_ADDRESS);

  console.log("Deployer:          ", deployer.address);
  console.log("Diamond:           ", DIAMOND_ADDRESS);
  console.log("Oracles to register:", oracles);
  console.log("Required signers:  ", REQUIRED_SIGNERS);
  console.log("Tolerance (bps):   ", TOLERANCE_BPS);
  console.log();

  for (const addr of oracles) {
    const already = await oracle.isAuthorisedOracle(addr);
    if (already) {
      console.log("Already registered:", addr);
      continue;
    }
    const tx = await oracle.addOracle(addr);
    const receipt = await tx.wait();
    console.log("addOracle:", addr, "| tx:", receipt.hash);
  }

  const tx2 = await oracle.setRequiredSigners(REQUIRED_SIGNERS);
  const r2 = await tx2.wait();
  console.log("setRequiredSigners(" + REQUIRED_SIGNERS + ") tx:", r2.hash);

  const tx3 = await oracle.setToleranceBps(TOLERANCE_BPS);
  const r3 = await tx3.wait();
  console.log("setToleranceBps(" + TOLERANCE_BPS + ") tx:", r3.hash);

  const config = await oracle.getOracleConfig();

  console.log();
  console.log("On-chain state:");
  console.log("  Required signers: ", config.required.toString());
  console.log("  Tolerance bps:    ", config.tolerance.toString());
  console.log("  Registered oracles:", config.oracles);
  console.log();
  console.log("Multi-oracle is now active.");
  console.log("Fund each oracle wallet with testnet ETH for gas, then start the nodes:");
  console.log("  ORACLE_KEY_A=<key> ts-node server/multi-oracle/run-oracle-a.ts");
  console.log("  ORACLE_KEY_B=<key> ts-node server/multi-oracle/run-oracle-b.ts");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
