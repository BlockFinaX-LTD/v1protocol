/**
 * Creates and executes a Safe transaction on behalf of the multisig.
 *
 * For TESTNET: all three signer private keys can be provided directly to
 * simulate multi-sig approval in a single script run.
 *
 * For MAINNET: signers should use the Safe UI at app.safe.global or Safe CLI
 * to propose and collect signatures.
 *
 * Supported actions (set ACTION env var):
 *   acceptOwnership  — Safe accepts Diamond ownership (run after transfer-ownership-to-safe.js)
 *   withdrawFees     — Safe withdraws platform fees (set AMOUNT in USDC base units)
 *   pause            — Pause the Diamond
 *   unpause          — Unpause the Diamond
 *   diamondCut       — (manual) encode your own calldata and set CALLDATA env var
 *
 * Usage (testnet — all keys available):
 *   SAFE_ADDRESS=0x... DIAMOND_ADDRESS=0x... ACTION=acceptOwnership \
 *   SIGNER_A_KEY=0x... SIGNER_B_KEY=0x... \
 *     npx hardhat run scripts/safe-create-tx.js --network liskSepolia
 */

const hre = require("hardhat");
const { ethers } = hre;

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) returns (bool success)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

const DIAMOND_ABI = [
  "function acceptOwnership()",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function withdrawPlatformFees(uint256 amount)",
  "function pause()",
  "function unpause()",
];

function buildCalldata(action, diamond) {
  const iface = new ethers.Interface(DIAMOND_ABI);
  const amount = process.env.AMOUNT || "0";
  const customCalldata = process.env.CALLDATA;

  switch (action) {
    case "acceptOwnership": return iface.encodeFunctionData("acceptOwnership");
    case "withdrawFees":    return iface.encodeFunctionData("withdrawPlatformFees", [amount]);
    case "pause":           return iface.encodeFunctionData("pause");
    case "unpause":         return iface.encodeFunctionData("unpause");
    case "diamondCut":
      if (!customCalldata) throw new Error("Set CALLDATA env var for diamondCut action");
      return customCalldata;
    default:
      throw new Error(`Unknown ACTION: ${action}. Use acceptOwnership | withdrawFees | pause | unpause | diamondCut`);
  }
}

async function main() {
  const SAFE_ADDRESS    = process.env.SAFE_ADDRESS;
  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  const ACTION          = process.env.ACTION;
  const SIGNER_A_KEY    = process.env.SIGNER_A_KEY;
  const SIGNER_B_KEY    = process.env.SIGNER_B_KEY;

  if (!SAFE_ADDRESS || !DIAMOND_ADDRESS || !ACTION) {
    throw new Error("Set SAFE_ADDRESS, DIAMOND_ADDRESS, and ACTION env vars");
  }
  if (!SIGNER_A_KEY || !SIGNER_B_KEY) {
    throw new Error(
      "Set SIGNER_A_KEY and SIGNER_B_KEY (testnet only — use Safe UI for mainnet)"
    );
  }

  const provider = hre.ethers.provider;
  const signerA  = new ethers.Wallet(SIGNER_A_KEY, provider);
  const signerB  = new ethers.Wallet(SIGNER_B_KEY, provider);
  const executor = signerA;

  const safe = new ethers.Contract(SAFE_ADDRESS, SAFE_ABI, executor);

  const owners    = await safe.getOwners();
  const threshold = await safe.getThreshold();
  const nonce     = await safe.nonce();

  console.log("Safe:      ", SAFE_ADDRESS);
  console.log("Diamond:   ", DIAMOND_ADDRESS);
  console.log("Action:    ", ACTION);
  console.log("Owners:    ", owners);
  console.log("Threshold: ", threshold.toString());
  console.log("Nonce:     ", nonce.toString());

  const calldata = buildCalldata(ACTION);
  console.log("Calldata:  ", calldata);

  const txHash = await safe.getTransactionHash(
    DIAMOND_ADDRESS,
    0,
    calldata,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    nonce
  );

  console.log("\nSafe tx hash:", txHash);

  const sigA = await signerA.signMessage(ethers.getBytes(txHash));
  const sigB = await signerB.signMessage(ethers.getBytes(txHash));

  const adjustSig = (sig) => {
    let s = sig;
    const v = parseInt(s.slice(-2), 16);
    if (v < 27) s = s.slice(0, -2) + (v + 27).toString(16).padStart(2, "0");
    return s;
  };

  const sortedSigs = [
    { addr: signerA.address, sig: adjustSig(sigA) },
    { addr: signerB.address, sig: adjustSig(sigB) },
  ]
    .sort((a, b) => a.addr.toLowerCase().localeCompare(b.addr.toLowerCase()))
    .map((s) => s.sig.slice(2))
    .join("");

  const packedSigs = "0x" + sortedSigs;

  console.log("Signatures collected — executing Safe transaction...");
  const tx = await safe.execTransaction(
    DIAMOND_ADDRESS,
    0,
    calldata,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    packedSigs
  );
  const receipt = await tx.wait();
  console.log("\n✅ Safe transaction executed");
  console.log("Tx hash:", receipt.hash);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
