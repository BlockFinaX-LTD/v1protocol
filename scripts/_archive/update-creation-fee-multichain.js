/**
 * update-creation-fee-multichain.js
 *
 * Sets the event creation fee to $2.00 on Base and BSC via 2-of-3 Safe multisig.
 * Preserves all other fee rates (hedgerFeeRate, hedgerPayoutFeeRate, lpProfitFeeRate,
 * creatorLoyaltyRate) unchanged.
 *
 * Usage (from contracts/ directory):
 *   SAFE_OWNER_KEY_1=0x... SAFE_OWNER_KEY_2=0x... \
 *     npx hardhat run scripts/update-creation-fee-multichain.js --network base
 *
 *   SAFE_OWNER_KEY_1=0x... SAFE_OWNER_KEY_2=0x... \
 *     npx hardhat run scripts/update-creation-fee-multichain.js --network bsc
 */

const hre = require("hardhat");

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)",
  "function getOwners() view returns (address[])",
];

const FEE_ABI = [
  "function getHedgeFeeConfig() view returns (uint256, uint256, uint256, uint256, uint256)",
  "function initializeHedgeFees(uint256,uint256,uint256,uint256,uint256) external",
];

const NETWORK_CONFIG = {
  base: {
    diamond: "0xcC594031d1c059Eb1d6bCb0c7b1c82D31115E6E6",
    safe:    "0x7909a2f1fAd63678eEDcC5A75462B66D062189Bb",
    usdcDecimals: 6,
  },
  bsc: {
    diamond: "0xcC594031d1c059Eb1d6bCb0c7b1c82D31115E6E6",
    safe:    "0x2a0ab363E01b518B189218e39f79Bfc3AE310807",
    usdcDecimals: 18,
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
    { gasLimit: 180_000 }
  );
  console.log(`  Submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt.blockNumber} (status=${receipt.status})`);
  if (receipt.status !== 1) throw new Error("Transaction reverted");
  return receipt;
}

async function main() {
  const { ethers, network } = hre;
  const netName = network.name; // "base" or "bsc"

  const cfg = NETWORK_CONFIG[netName];
  if (!cfg) throw new Error(`Unsupported network "${netName}". Use --network base or --network bsc`);

  const key1 = process.env.SAFE_OWNER_KEY_1;
  const key2 = process.env.SAFE_OWNER_KEY_2;
  if (!key1 || !key2) throw new Error("Set SAFE_OWNER_KEY_1 and SAFE_OWNER_KEY_2 env vars");

  const provider = ethers.provider;
  const signer1  = new ethers.Wallet(key1, provider);
  const signer2  = new ethers.Wallet(key2, provider);
  console.log(`\nNetwork  : ${netName}`);
  console.log(`Diamond  : ${cfg.diamond}`);
  console.log(`Safe     : ${cfg.safe}`);
  console.log(`Signer1  : ${signer1.address}`);
  console.log(`Signer2  : ${signer2.address}`);

  const safe  = new ethers.Contract(cfg.safe,    SAFE_ABI, signer1);
  const hedge = new ethers.Contract(cfg.diamond, FEE_ABI,  provider);

  // Read current fee config to preserve non-creation-fee rates
  console.log(`\nReading current fee config from chain...`);
  const fees = await hedge.getHedgeFeeConfig();
  const [currentCreationFee, hedgerFeeRate, hedgerPayoutFeeRate, lpProfitFeeRate, creatorLoyaltyRate] = fees;
  console.log(`  Current creation fee : ${ethers.formatUnits(currentCreationFee, cfg.usdcDecimals)} USDC`);
  console.log(`  hedgerFeeRate        : ${currentCreationFee !== undefined ? Number(hedgerFeeRate) : 'n/a'}`);
  console.log(`  hedgerPayoutFeeRate  : ${Number(hedgerPayoutFeeRate)}`);
  console.log(`  lpProfitFeeRate      : ${Number(lpProfitFeeRate)}`);
  console.log(`  creatorLoyaltyRate   : ${Number(creatorLoyaltyRate)}`);

  // $2.00 in the correct decimals for this network's USDC
  const newCreationFee = ethers.parseUnits("2", cfg.usdcDecimals);
  console.log(`\nNew creation fee: $2.00 = ${newCreationFee} (${cfg.usdcDecimals}-decimal)`);

  if (currentCreationFee === newCreationFee) {
    console.log("Creation fee is already $2.00 — nothing to do.");
    return;
  }

  // Encode initializeHedgeFees call
  const iface = new ethers.Interface(FEE_ABI);
  const calldata = iface.encodeFunctionData("initializeHedgeFees", [
    newCreationFee,
    hedgerFeeRate,
    hedgerPayoutFeeRate,
    lpProfitFeeRate,
    creatorLoyaltyRate,
  ]);

  // Confirm Safe owners include our signers
  const owners = await safe.getOwners();
  console.log(`\nSafe owners: ${owners.join(", ")}`);
  if (!owners.map(o => o.toLowerCase()).includes(signer1.address.toLowerCase()))
    throw new Error(`Signer1 (${signer1.address}) is not a Safe owner`);
  if (!owners.map(o => o.toLowerCase()).includes(signer2.address.toLowerCase()))
    throw new Error(`Signer2 (${signer2.address}) is not a Safe owner`);

  console.log(`\nExecuting initializeHedgeFees via Safe (2-of-3)...`);
  await execSafeTx(safe, signer1, signer2, cfg.diamond, calldata);

  // Verify
  const updated = await hedge.getHedgeFeeConfig();
  console.log(`\nVerification:`);
  console.log(`  New creation fee on-chain: ${ethers.formatUnits(updated[0], cfg.usdcDecimals)} USDC`);
  if (ethers.formatUnits(updated[0], cfg.usdcDecimals) === "2.0") {
    console.log("  SUCCESS — creation fee is now $2.00");
  } else {
    console.log("  WARNING — fee is not $2.00, got:", updated[0].toString());
  }
}

main().catch((err) => {
  console.error("\nERROR:", err.message || err);
  process.exitCode = 1;
});
