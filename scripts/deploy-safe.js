const { ethers } = require("hardhat");
const fs = require("fs");

const SAFE_SINGLETON   = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552"; // v1.3.0
const SAFE_FACTORY     = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2"; // v1.3.0
const FALLBACK_HANDLER = "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4";

const FACTORY_ABI = [
  "event ProxyCreation(address proxy, address singleton)",
  "function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) returns (address proxy)"
];

const SAFE_ABI = [
  "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external"
];

const OWNER_1  = "0xc69352C36562ce2D4C57B38baf47cE7D1eF6b891";
const OWNER_2  = "0x6C0e8E46728953322C83cD2A0c3eDa122F077723";
const THRESHOLD = 2;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const bal = await deployer.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH\n");

  const safeIface   = new ethers.Interface(SAFE_ABI);
  const initializer = safeIface.encodeFunctionData("setup", [
    [OWNER_1, OWNER_2],
    THRESHOLD,
    ethers.ZeroAddress,
    "0x",
    FALLBACK_HANDLER,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress
  ]);

  const factory   = new ethers.Contract(SAFE_FACTORY, FACTORY_ABI, deployer);
  const saltNonce = Date.now();

  console.log("Deploying 2-of-2 Gnosis Safe...");
  console.log("Owner 1:", OWNER_1);
  console.log("Owner 2:", OWNER_2);
  console.log("Threshold:", THRESHOLD);

  const tx      = await factory.createProxyWithNonce(SAFE_SINGLETON, initializer, saltNonce);
  const receipt = await tx.wait();

  const factoryIface = new ethers.Interface(FACTORY_ABI);
  let safeAddress = null;
  for (const log of receipt.logs) {
    try {
      const parsed = factoryIface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "ProxyCreation") {
        safeAddress = parsed.args.proxy;
        break;
      }
    } catch {}
  }

  if (!safeAddress) throw new Error("ProxyCreation event not found — check receipt logs");

  console.log("\n✅ Safe deployed at:", safeAddress);
  console.log("Tx:", tx.hash);
  console.log("Blockscout: https://blockscout.lisk.com/address/" + safeAddress);

  const out = { safeAddress, owners: [OWNER_1, OWNER_2], threshold: THRESHOLD, txHash: tx.hash, deployedAt: new Date().toISOString() };
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync("deployments/deployments-safe-liskMainnet.json", JSON.stringify(out, null, 2));
  console.log("\nSaved to deployments/deployments-safe-liskMainnet.json");
}

main().catch(e => { console.error(e.message); process.exit(1); });
