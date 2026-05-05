/**
 * deploy-hedge-multichain.js
 *
 * One-shot script that:
 *   1. Checks who currently owns the Diamond
 *   2. If the Safe is pendingOwner (hasn't accepted yet), executes acceptOwnership via Safe
 *   3. Deploys a fresh HedgeFacet (or reuses existing) and cuts it into the Diamond via Safe
 *
 * Run for Base:
 *   SAFE_OWNER_KEY_1=0x... SAFE_OWNER_KEY_2=0x... \
 *     npx hardhat run scripts/deploy-hedge-multichain.js --network base
 *
 * Run for BSC:
 *   SAFE_OWNER_KEY_1=0x... SAFE_OWNER_KEY_2=0x... \
 *     npx hardhat run scripts/deploy-hedge-multichain.js --network bsc
 */

const hre = require("hardhat");
const fs  = require("fs");

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)",
  "function getOwners() view returns (address[])",
];

const OWNERSHIP_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership() external",
];

const LOUPE_ABI = [
  "function facets() external view returns (tuple(address facetAddress, bytes4[] functionSelectors)[] memory)",
];

const DIAMOND_CUT_ABI = [
  "function diamondCut(tuple(address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes calldata _calldata) external",
];

// Maps network name → deployment filename pattern and Safe address
const NETWORK_CONFIG = {
  base: {
    deployFile: "deployments-v3-fixed-base-1775153035705.json",
    safe: "0x7909a2f1fAd63678eEDcC5A75462B66D062189Bb",
  },
  bsc: {
    deployFile: "deployments-v3-fixed-bsc-1775153098939.json",
    safe: "0x2a0ab363E01b518B189218e39f79Bfc3AE310807",
  },
};

function adjustV(sig) {
  const bytes = hre.ethers.getBytes(sig);
  bytes[64] = bytes[64] < 27 ? bytes[64] + 31 : bytes[64] + 4;
  return hre.ethers.hexlify(bytes);
}

async function execSafeTx(safe, signer1, signer2, to, calldata) {
  const { ethers } = hre;
  const nonce = await safe.nonce();
  console.log(`  Safe nonce: ${nonce}`);

  const txHash = await safe.getTransactionHash(
    to, 0, calldata, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );
  console.log(`  Safe tx hash: ${txHash}`);

  const sig1 = await signer1.signMessage(ethers.getBytes(txHash));
  const sig2 = await signer2.signMessage(ethers.getBytes(txHash));

  const packed = signer1.address.toLowerCase() < signer2.address.toLowerCase()
    ? adjustV(sig1) + adjustV(sig2).slice(2)
    : adjustV(sig2) + adjustV(sig1).slice(2);

  const tx = await safe.execTransaction(
    to, 0, calldata, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, packed,
  );
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function main() {
  const { ethers, network } = hre;

  const netName = network.name;
  if (!NETWORK_CONFIG[netName]) throw new Error(`Unsupported network: ${netName}. Use 'base' or 'bsc'.`);

  const key1 = process.env.SAFE_OWNER_KEY_1;
  const key2 = process.env.SAFE_OWNER_KEY_2;
  if (!key1 || !key2) throw new Error("Set SAFE_OWNER_KEY_1 and SAFE_OWNER_KEY_2 env vars");

  const cfg        = NETWORK_CONFIG[netName];
  const deployment = JSON.parse(fs.readFileSync(cfg.deployFile, "utf8"));
  const DIAMOND    = deployment.diamond;
  const SAFE_ADDR  = cfg.safe;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Network : ${netName} (chainId ${network.config.chainId})`);
  console.log(`Diamond : ${DIAMOND}`);
  console.log(`Safe    : ${SAFE_ADDR}`);
  console.log(`${"=".repeat(60)}\n`);

  const provider = hre.ethers.provider;
  const signer1  = new ethers.Wallet(key1, provider);
  const signer2  = new ethers.Wallet(key2, provider);

  // signer1 also pays gas (no DEPLOYER_PRIVATE_KEY required)
  const safe = new ethers.Contract(SAFE_ADDR, SAFE_ABI, signer1);

  const owners = await safe.getOwners();
  const ownerSet = new Set(owners.map(o => o.toLowerCase()));
  console.log("Safe owners:", owners);

  if (!ownerSet.has(signer1.address.toLowerCase())) throw new Error(`SAFE_OWNER_KEY_1 (${signer1.address}) is not a Safe owner`);
  if (!ownerSet.has(signer2.address.toLowerCase())) throw new Error(`SAFE_OWNER_KEY_2 (${signer2.address}) is not a Safe owner`);
  if (signer1.address.toLowerCase() === signer2.address.toLowerCase()) throw new Error("Need two distinct Safe owners");

  console.log(`Signer 1 : ${signer1.address}`);
  console.log(`Signer 2 : ${signer2.address}`);

  // ── Step 1: Check ownership ──────────────────────────────────────────────
  const diamond = new ethers.Contract(DIAMOND, OWNERSHIP_ABI, provider);
  let currentOwner;
  try {
    currentOwner = await diamond.owner();
    console.log(`\nCurrent owner: ${currentOwner}`);
  } catch {
    currentOwner = null;
    console.log("\nCould not read owner() — may be bootstrap cut facet");
  }

  let pendingOwner;
  try {
    pendingOwner = await diamond.pendingOwner();
    console.log(`Pending owner : ${pendingOwner}`);
  } catch {
    pendingOwner = null;
  }

  const safeIsOwner    = currentOwner?.toLowerCase() === SAFE_ADDR.toLowerCase();
  const safeIsPending  = pendingOwner?.toLowerCase() === SAFE_ADDR.toLowerCase();

  // ── Step 2: Accept ownership if Safe is pendingOwner ────────────────────
  if (!safeIsOwner && safeIsPending) {
    console.log("\n[Step 2] Safe is pendingOwner — executing acceptOwnership via Safe...");
    const iface    = new ethers.Interface(OWNERSHIP_ABI);
    const calldata = iface.encodeFunctionData("acceptOwnership");
    await execSafeTx(safe, signer1, signer2, DIAMOND, calldata);
    console.log("✓ Safe is now the Diamond owner");
  } else if (safeIsOwner) {
    console.log("\n[Step 2] Safe is already the Diamond owner — skipping acceptOwnership");
  } else {
    console.log(`\nWARNING: Current owner is ${currentOwner} and Safe is not pendingOwner.`);
    console.log("The Safe cannot execute diamondCut unless it is the Diamond owner.");
    console.log("You may need DEPLOYER_PRIVATE_KEY to transfer ownership to the Safe first.");
    process.exit(1);
  }

  // ── Step 3: Get registered selectors from Loupe ─────────────────────────
  console.log("\n[Step 3] Reading registered selectors from Diamond Loupe...");
  const loupe      = new ethers.Contract(DIAMOND, LOUPE_ABI, provider);
  const facets     = await loupe.facets();
  const registered = new Set();
  facets.forEach(f => f.functionSelectors.forEach(s => registered.add(s.toLowerCase())));
  console.log(`  ${registered.size} selectors already in Diamond`);

  // ── Step 4: Deploy fresh HedgeFacet ─────────────────────────────────────
  console.log("\n[Step 4] Deploying fresh HedgeFacet...");
  const HedgeFacet  = await hre.ethers.getContractFactory("BlockFinaXHedgeFacet", signer1);
  const hedgeFacet  = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();
  const hedgeAddr   = await hedgeFacet.getAddress();
  console.log(`  HedgeFacet deployed: ${hedgeAddr}`);

  // ── Step 5: Compute selectors to add ────────────────────────────────────
  const allSelectors = hedgeFacet.interface.fragments
    .filter(f => f.type === "function")
    .map(f => ({ selector: f.selector, name: f.name }));

  const toAdd   = allSelectors.filter(({ selector }) => !registered.has(selector.toLowerCase()));
  const skipped = allSelectors.filter(({ selector }) => registered.has(selector.toLowerCase()));

  console.log(`\n  Total HedgeFacet functions : ${allSelectors.length}`);
  if (skipped.length) console.log(`  Skipping (already in Diamond): ${skipped.map(s => s.name).join(", ")}`);
  console.log(`  Adding: ${toAdd.length} selectors`);
  toAdd.forEach(({ selector, name }) => console.log(`    ${selector}  ${name}`));

  if (toAdd.length === 0) {
    console.log("\nNothing to add — HedgeFacet already fully cut in.");
    return;
  }

  // ── Step 6: Execute diamondCut via Safe ─────────────────────────────────
  console.log("\n[Step 6] Executing diamondCut via Safe...");
  const cutIface   = new ethers.Interface(DIAMOND_CUT_ABI);
  const cutCalldata = cutIface.encodeFunctionData("diamondCut", [
    [{ facetAddress: hedgeAddr, action: 0, functionSelectors: toAdd.map(s => s.selector) }],
    ethers.ZeroAddress,
    "0x",
  ]);
  await execSafeTx(safe, signer1, signer2, DIAMOND, cutCalldata);

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✓ HedgeFacet is LIVE on ${netName}`);
  console.log(`  Diamond : ${DIAMOND}`);
  console.log(`  Facet   : ${hedgeAddr}`);
  console.log(`${"=".repeat(60)}\n`);

  // Save updated deployment info
  const outFile = `deployments-hedge-live-${netName}-${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify({
    network: netName,
    chainId: network.config.chainId,
    diamond: DIAMOND,
    safe: SAFE_ADDR,
    hedgeFacet: hedgeAddr,
    selectorsAdded: toAdd.map(s => s.selector),
    timestamp: new Date().toISOString(),
  }, null, 2));
  console.log(`Saved: ${outFile}`);
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
