/**
 * safe-accept-ownership-multichain.js
 *
 * Calls acceptOwnership() on a Diamond through the Gnosis Safe (2-of-3).
 * Reads the Diamond and Safe addresses from the chain-specific deployment file.
 *
 * Required env vars:
 *   SAFE_OWNER_KEY_1   private key of any Safe owner
 *   SAFE_OWNER_KEY_2   private key of any other Safe owner
 *
 * Usage:
 *   npx hardhat run scripts/safe-accept-ownership-multichain.js --network base
 *   npx hardhat run scripts/safe-accept-ownership-multichain.js --network bsc
 */

const hre = require("hardhat");
const fs  = require("fs");

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)",
  "function getOwners() view returns (address[])",
];

async function main() {
  const { ethers, network } = hre;

  const key1 = process.env.SAFE_OWNER_KEY_1;
  const key2 = process.env.SAFE_OWNER_KEY_2;
  if (!key1 || !key2) throw new Error("Set SAFE_OWNER_KEY_1 and SAFE_OWNER_KEY_2 env vars");

  // Load deployment file for this network. The v3-fixed files are now in deployments/_archive/
  // (kept for historical reference). New deployments live in deployments/.
  const searchDirs = ["deployments/_archive", "deployments", "."];
  let deployFile = null;
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f =>
      f.startsWith(`deployments-v3-fixed-${network.name}-`) && f.endsWith(".json")
    );
    if (files.length > 0) { deployFile = `${dir}/${files.sort().pop()}`; break; }
  }
  if (!deployFile) throw new Error(`No v3-fixed deployment file found for network ${network.name} in ${searchDirs.join(", ")}`);
  const deployment = JSON.parse(fs.readFileSync(deployFile, "utf8"));

  const DIAMOND = deployment.diamond;
  const SAFE    = deployment.config?.pendingOwner || deployment.safeAddress;

  if (!DIAMOND) throw new Error("Diamond address not found in deployment file");
  if (!SAFE || SAFE === ethers.ZeroAddress) throw new Error("Safe address not found in deployment file");

  console.log(`\nNetwork  : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Diamond  : ${DIAMOND}`);
  console.log(`Safe     : ${SAFE}`);

  const provider  = hre.ethers.provider;
  const signer1   = new ethers.Wallet(key1, provider);
  const signer2   = new ethers.Wallet(key2, provider);
  // Deployer submits the tx and pays gas (execTransaction can be called by anyone)
  const [deployer] = await hre.ethers.getSigners();

  console.log(`Signer 1 : ${signer1.address} (signs)`);
  console.log(`Signer 2 : ${signer2.address} (signs)`);
  console.log(`Submitter: ${deployer.address} (pays gas)`);

  const safe   = new ethers.Contract(SAFE, SAFE_ABI, deployer);
  const owners = await safe.getOwners();
  const ownerSet = new Set(owners.map(o => o.toLowerCase()));
  if (!ownerSet.has(signer1.address.toLowerCase())) throw new Error(`Signer 1 is not a Safe owner`);
  if (!ownerSet.has(signer2.address.toLowerCase())) throw new Error(`Signer 2 is not a Safe owner`);
  if (signer1.address.toLowerCase() === signer2.address.toLowerCase()) throw new Error("Need two distinct Safe owners");

  const iface    = new ethers.Interface(["function acceptOwnership() external"]);
  const calldata = iface.encodeFunctionData("acceptOwnership");

  const nonce  = await safe.nonce();
  console.log(`\nSafe nonce: ${nonce}`);

  const txHash = await safe.getTransactionHash(
    DIAMOND, 0, calldata, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );
  console.log(`Safe tx hash: ${txHash}`);

  const sig1 = await signer1.signMessage(ethers.getBytes(txHash));
  const sig2 = await signer2.signMessage(ethers.getBytes(txHash));

  function adjustV(sig) {
    const bytes = ethers.getBytes(sig);
    bytes[64] = bytes[64] < 27 ? bytes[64] + 31 : bytes[64] + 4;
    return ethers.hexlify(bytes);
  }

  const packed = signer1.address.toLowerCase() < signer2.address.toLowerCase()
    ? adjustV(sig1) + adjustV(sig2).slice(2)
    : adjustV(sig2) + adjustV(sig1).slice(2);

  console.log("\nExecuting Safe transaction (acceptOwnership)...");
  const tx = await safe.execTransaction(
    DIAMOND, 0, calldata, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, packed,
  );
  console.log("tx hash  :", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);

  const pendingAbi = ["function pendingOwner() view returns (address)"];
  const diamond = new ethers.Contract(DIAMOND, pendingAbi, provider);
  const pending = await diamond.pendingOwner().catch(() => "cleared");

  console.log("\n" + "=".repeat(55));
  if (pending === ethers.ZeroAddress || pending?.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    console.log(`✓ Safe is now Diamond owner on ${network.name}`);
  } else {
    console.log(`pendingOwner still set: ${pending} — check tx`);
  }
  console.log("=".repeat(55));
}

main().catch(e => { console.error(e); process.exit(1); });
