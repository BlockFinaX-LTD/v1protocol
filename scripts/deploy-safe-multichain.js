/**
 * deploy-safe-multichain.js
 *
 * Deploys a 2-of-3 Gnosis Safe v1.3.0 on any EVM chain.
 * Uses the same canonical Safe factory address (same on Base, BSC, Arbitrum, etc.)
 *
 * Owners (same wallets across all chains):
 *   0x331B1ce9250b53e807935F65D5cd04C2234af3a0
 *   0xc69352C36562ce2D4C57B38baf47cE7D1eF6b891
 *   0x6C0e8E46728953322C83cD2A0c3eDa122F077723
 *
 * Usage:
 *   npx hardhat run scripts/deploy-safe-multichain.js --network base
 *   npx hardhat run scripts/deploy-safe-multichain.js --network bsc
 */

const hre = require("hardhat");
const fs  = require("fs");

const SAFE_SINGLETON   = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552"; // v1.3.0
const SAFE_FACTORY     = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2"; // v1.3.0
const FALLBACK_HANDLER = "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4";

const OWNERS = [
  "0x331B1ce9250b53e807935F65D5cd04C2234af3a0",
  "0xc69352C36562ce2D4C57B38baf47cE7D1eF6b891",
  "0x6C0e8E46728953322C83cD2A0c3eDa122F077723",
];
const THRESHOLD = 2;

const FACTORY_ABI = [
  "event ProxyCreation(address proxy, address singleton)",
  "function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) returns (address proxy)",
];
const SAFE_ABI = [
  "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external",
];

const EXPLORERS = {
  8453:  "https://basescan.org/address/",
  84532: "https://sepolia.basescan.org/address/",
  56:    "https://bscscan.com/address/",
  97:    "https://testnet.bscscan.com/address/",
  1135:  "https://blockscout.lisk.com/address/",
};

async function main() {
  const { ethers, network } = hre;
  const chainId = network.config.chainId;

  console.log(`\nDeploying 2-of-3 Gnosis Safe on ${network.name} (chainId ${chainId})`);

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const bal = await deployer.provider.getBalance(deployer.address);
  console.log("Balance :", ethers.formatEther(bal), "\n");

  // Verify Safe factory exists on this chain
  const factoryCode = await deployer.provider.getCode(SAFE_FACTORY);
  if (factoryCode === "0x") throw new Error(`Safe factory not deployed on ${network.name} — use a supported chain`);

  const safeIface   = new ethers.Interface(SAFE_ABI);
  const initializer = safeIface.encodeFunctionData("setup", [
    OWNERS,
    THRESHOLD,
    ethers.ZeroAddress,
    "0x",
    FALLBACK_HANDLER,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
  ]);

  const factory   = new ethers.Contract(SAFE_FACTORY, FACTORY_ABI, deployer);
  const saltNonce = Date.now();

  console.log("Owners:");
  OWNERS.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  console.log(`Threshold : ${THRESHOLD} of ${OWNERS.length}`);

  console.log("\nDeploying...");
  const tx      = await factory.createProxyWithNonce(SAFE_SINGLETON, initializer, saltNonce);
  const receipt = await tx.wait();
  console.log("tx hash  :", receipt.hash);

  const factoryIface = new ethers.Interface(FACTORY_ABI);
  let safeAddress = null;
  for (const log of receipt.logs) {
    try {
      const parsed = factoryIface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "ProxyCreation") { safeAddress = parsed.args.proxy; break; }
    } catch (_) {}
  }
  if (!safeAddress) throw new Error("ProxyCreation event not found — check receipt manually");

  const explorer = EXPLORERS[chainId] || "";
  console.log("\n" + "=".repeat(55));
  console.log(`Safe deployed on ${network.name}`);
  console.log("=".repeat(55));
  console.log("Safe address:", safeAddress);
  if (explorer) console.log("Explorer    :", explorer + safeAddress);
  console.log("=".repeat(55));
  console.log(`\nNext: deploy Diamond with SAFE_ADDR=${safeAddress}`);
  console.log(`  npx hardhat run scripts/deploy-v3-fixed.js --network ${network.name}`);

  fs.mkdirSync("deployments", { recursive: true });
  const outFile = `deployments/deployments-safe-${network.name}.json`;
  const out = {
    network:    network.name,
    chainId,
    safeAddress,
    owners:     OWNERS,
    threshold:  THRESHOLD,
    txHash:     receipt.hash,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nSaved to ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
