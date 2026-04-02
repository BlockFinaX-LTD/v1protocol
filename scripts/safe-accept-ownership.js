/**
 * safe-accept-ownership.js
 *
 * Calls acceptOwnership() on the Diamond through the Gnosis Safe (2-of-3).
 * Uses two Safe owner private keys to sign and execute the transaction atomically.
 *
 * Required env vars:
 *   SAFE_OWNER_KEY_1   private key of any Safe owner
 *   SAFE_OWNER_KEY_2   private key of any other Safe owner
 *
 * Usage:
 *   SAFE_OWNER_KEY_1=0x... SAFE_OWNER_KEY_2=0x... \
 *     npx hardhat run scripts/safe-accept-ownership.js --network lisk
 */

const hre = require("hardhat");

const SAFE    = "0xfce89FA90Ee1C78B15eE0f12f62B03153814699D";
const DIAMOND = "0x885E663645173a0791b82f0e6608921D31E3D700";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)",
  "function getOwners() view returns (address[])",
];

async function main() {
  const { ethers } = hre;

  const key1 = process.env.SAFE_OWNER_KEY_1;
  const key2 = process.env.SAFE_OWNER_KEY_2;
  if (!key1 || !key2) throw new Error("Set SAFE_OWNER_KEY_1 and SAFE_OWNER_KEY_2 env vars");

  const provider = hre.ethers.provider;
  const signer1  = new ethers.Wallet(key1, provider);
  const signer2  = new ethers.Wallet(key2, provider);

  console.log("Signer 1:", signer1.address);
  console.log("Signer 2:", signer2.address);

  // Verify both are Safe owners
  const safe   = new ethers.Contract(SAFE, SAFE_ABI, signer1);
  const owners = await safe.getOwners();
  const ownerSet = new Set(owners.map(o => o.toLowerCase()));
  if (!ownerSet.has(signer1.address.toLowerCase())) throw new Error(`Signer 1 (${signer1.address}) is not a Safe owner`);
  if (!ownerSet.has(signer2.address.toLowerCase())) throw new Error(`Signer 2 (${signer2.address}) is not a Safe owner`);
  if (signer1.address.toLowerCase() === signer2.address.toLowerCase()) throw new Error("Both keys are the same address — need two distinct owners");

  // Encode acceptOwnership() calldata
  const iface    = new ethers.Interface(["function acceptOwnership() external"]);
  const calldata = iface.encodeFunctionData("acceptOwnership");
  console.log("\nTarget  :", DIAMOND);
  console.log("Calldata:", calldata);

  // Safe tx params (no gas refund, plain CALL)
  const nonce = await safe.nonce();
  console.log("Safe nonce:", nonce.toString());

  const txHash = await safe.getTransactionHash(
    DIAMOND,   // to
    0,         // value
    calldata,  // data
    0,         // operation (CALL)
    0,         // safeTxGas
    0,         // baseGas
    0,         // gasPrice
    ethers.ZeroAddress, // gasToken
    ethers.ZeroAddress, // refundReceiver
    nonce,
  );
  console.log("\nSafe tx hash:", txHash);

  // Both owners sign the hash (eth_sign style — Safe expects v+27)
  const sig1 = await signer1.signMessage(ethers.getBytes(txHash));
  const sig2 = await signer2.signMessage(ethers.getBytes(txHash));

  // Adjust v: signMessage produces v=27/28 via personalSign, Safe needs v+4 for eth_sign
  // Actually Safe uses two signature types; use contractSignature-style via signTypedData
  // Simplest: use approveHash flow for on-chain pre-approval — but for 1-shot we need packed sigs.
  // Safe 1.3.0 packed sig format: sort signers by address ascending, each sig = r(32) + s(32) + v(1)
  // For off-chain eth_sign: v must be 31 or 32 (v_from_sign + 4)
  function adjustV(sig) {
    const bytes = ethers.getBytes(sig);
    bytes[64] = bytes[64] < 27 ? bytes[64] + 31 : bytes[64] + 4; // convert to Safe's eth_sign type
    return ethers.hexlify(bytes);
  }

  let packed;
  if (signer1.address.toLowerCase() < signer2.address.toLowerCase()) {
    packed = adjustV(sig1) + adjustV(sig2).slice(2);
  } else {
    packed = adjustV(sig2) + adjustV(sig1).slice(2);
  }
  console.log("Packed signatures ready");

  // Execute
  console.log("\nExecuting Safe transaction...");
  const tx = await safe.execTransaction(
    DIAMOND,
    0,
    calldata,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    packed,
  );
  console.log("tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);

  // Verify
  const diamondOwnerAbi = ["function pendingOwner() view returns (address)"];
  const diamond = new ethers.Contract(DIAMOND, diamondOwnerAbi, provider);
  const pending = await diamond.pendingOwner().catch(() => "cleared");
  console.log("\npendingOwner() after tx:", pending);
  if (pending === ethers.ZeroAddress || pending === "cleared" || pending.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    console.log("✓ Ownership accepted — Safe is now Diamond owner");
  } else {
    console.log("pendingOwner still set:", pending, "— check transaction");
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
