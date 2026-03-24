/**
 * Deploys a Gnosis Safe 2-of-3 multisig on Lisk Sepolia (or mainnet).
 *
 * Usage:
 *   OWNER_A=0x... OWNER_B=0x... OWNER_C=0x... \
 *     npx hardhat run scripts/deploy-safe.js --network liskSepolia
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  — pays gas for the deployment tx
 *   OWNER_A, OWNER_B, OWNER_C  — the three signer addresses
 *
 * The Safe requires 2-of-3 approvals for any transaction.
 * Save the printed Safe address — it becomes the new Diamond owner.
 */

const hre = require("hardhat");

const SAFE_FACTORY_141  = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_SINGLETON    = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const FALLBACK_HANDLER  = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

const SAFE_FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
];

const SAFE_SETUP_ABI = [
  "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver)",
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const OWNER_A = process.env.OWNER_A;
  const OWNER_B = process.env.OWNER_B;
  const OWNER_C = process.env.OWNER_C;

  if (!OWNER_A || !OWNER_B || !OWNER_C) {
    throw new Error("Set OWNER_A, OWNER_B, OWNER_C env vars (the three signer addresses)");
  }

  const owners = [OWNER_A, OWNER_B, OWNER_C];
  const threshold = 2;

  console.log("\nSafe owners (2-of-3 threshold):");
  owners.forEach((o, i) => console.log(`  Owner ${i + 1}: ${o}`));
  console.log(`  Threshold: ${threshold}`);

  const safeInterface = new hre.ethers.Interface(SAFE_SETUP_ABI);
  const initializer = safeInterface.encodeFunctionData("setup", [
    owners,
    threshold,
    hre.ethers.ZeroAddress,
    "0x",
    FALLBACK_HANDLER,
    hre.ethers.ZeroAddress,
    0,
    hre.ethers.ZeroAddress,
  ]);

  const factory = new hre.ethers.Contract(SAFE_FACTORY_141, SAFE_FACTORY_ABI, deployer);

  const saltNonce = Date.now();
  console.log("\nDeploying Safe via proxy factory...");
  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON, initializer, saltNonce);
  const receipt = await tx.wait();

  const event = receipt.logs.find((log) => {
    try {
      const parsed = factory.interface.parseLog(log);
      return parsed?.name === "ProxyCreation";
    } catch {
      return false;
    }
  });

  if (!event) throw new Error("ProxyCreation event not found in receipt");
  const parsed = factory.interface.parseLog(event);
  const safeAddress = parsed.args[0];

  console.log("\n=== Safe deployed ===");
  console.log("Safe address:  ", safeAddress);
  console.log("Tx hash:       ", receipt.hash);
  console.log("Threshold:      2-of-3");
  console.log("\nNext step:");
  console.log("  SAFE_ADDRESS=" + safeAddress + " npx hardhat run scripts/transfer-ownership-to-safe.js --network liskSepolia");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
