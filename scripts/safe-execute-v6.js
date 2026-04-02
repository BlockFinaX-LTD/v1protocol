/**
 * safe-execute-v6.js
 *
 * Executes the v6 audit diamondCut through the Gnosis Safe (2-of-3).
 * Run this after the 48-hour timelock expires (after 2026-04-04T13:31:31Z).
 *
 * Required env vars:
 *   SAFE_OWNER_KEY_1   private key of any Safe owner
 *   SAFE_OWNER_KEY_2   private key of any other Safe owner
 *
 * Usage:
 *   SAFE_OWNER_KEY_1=0x... SAFE_OWNER_KEY_2=0x... \
 *     npx hardhat run scripts/safe-execute-v6.js --network lisk
 */

const hre = require("hardhat");
const fs  = require("fs");

const SAFE          = "0xfce89FA90Ee1C78B15eE0f12f62B03153814699D";
const PROPOSAL_FILE = "deployments-v6-proposal-lisk.json";

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

  if (!fs.existsSync(PROPOSAL_FILE)) throw new Error(`${PROPOSAL_FILE} not found — run upgrade-v6-audit.js first`);
  const proposal = JSON.parse(fs.readFileSync(PROPOSAL_FILE, "utf8"));

  const now = Math.floor(Date.now() / 1000);
  const eta = Number(proposal.eta);
  if (now < eta) {
    const hrs = ((eta - now) / 3600).toFixed(2);
    throw new Error(`Timelock not expired yet — ${hrs} hours remaining (ETA: ${proposal.etaISO})`);
  }

  const DIAMOND = proposal.diamond;
  console.log("Diamond     :", DIAMOND);
  console.log("proposalId  :", proposal.proposalId);
  console.log("ETA (UTC)   :", proposal.etaISO, "— EXPIRED ✓");

  const provider = hre.ethers.provider;
  const signer1  = new ethers.Wallet(key1, provider);
  const signer2  = new ethers.Wallet(key2, provider);

  console.log("\nSigner 1:", signer1.address);
  console.log("Signer 2:", signer2.address);

  const safe   = new ethers.Contract(SAFE, SAFE_ABI, signer1);
  const owners = await safe.getOwners();
  const ownerSet = new Set(owners.map(o => o.toLowerCase()));
  if (!ownerSet.has(signer1.address.toLowerCase())) throw new Error(`Signer 1 is not a Safe owner`);
  if (!ownerSet.has(signer2.address.toLowerCase())) throw new Error(`Signer 2 is not a Safe owner`);
  if (signer1.address.toLowerCase() === signer2.address.toLowerCase()) throw new Error("Need two distinct Safe owners");

  // Encode executeCut(bytes32) calldata
  const iface    = new ethers.Interface(["function executeCut(bytes32 _proposalId) external"]);
  const calldata = iface.encodeFunctionData("executeCut", [proposal.proposalId]);
  console.log("\nTarget  :", DIAMOND);
  console.log("Calldata:", calldata);

  const nonce = await safe.nonce();
  console.log("Safe nonce:", nonce.toString());

  const txHash = await safe.getTransactionHash(
    DIAMOND, 0, calldata, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress,
    nonce,
  );
  console.log("Safe tx hash:", txHash);

  const sig1 = await signer1.signMessage(ethers.getBytes(txHash));
  const sig2 = await signer2.signMessage(ethers.getBytes(txHash));

  function adjustV(sig) {
    const bytes = ethers.getBytes(sig);
    bytes[64] = bytes[64] < 27 ? bytes[64] + 31 : bytes[64] + 4;
    return ethers.hexlify(bytes);
  }

  let packed;
  if (signer1.address.toLowerCase() < signer2.address.toLowerCase()) {
    packed = adjustV(sig1) + adjustV(sig2).slice(2);
  } else {
    packed = adjustV(sig2) + adjustV(sig1).slice(2);
  }

  console.log("\nExecuting Safe transaction (executeCut)...");
  const tx = await safe.execTransaction(
    DIAMOND, 0, calldata, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress,
    packed,
  );
  console.log("tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);

  // Verify live facets
  const loupeAbi = ["function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])"];
  const loupe = new ethers.Contract(DIAMOND, loupeAbi, provider);
  const liveFacets = await loupe.facets();

  console.log("\n" + "=".repeat(60));
  console.log("V6 AUDIT UPGRADE EXECUTED VIA SAFE");
  console.log("=".repeat(60));
  console.log("Diamond   :", DIAMOND);
  console.log("Execute tx:", receipt.hash);
  console.log("\nNew facets active:");
  for (const [key, addr] of Object.entries(proposal.newFacets)) {
    console.log(`  ${key}: ${addr}`);
  }
  console.log("\nLive facets in Diamond:");
  for (const f of liveFacets) {
    console.log(`  ${f.facetAddress}  (${f.functionSelectors.length} selectors)`);
  }
  console.log("=".repeat(60));

  // Save final snapshot
  const fs2 = require("fs");
  const snapshot = {
    version: "v6-audit-final",
    diamond: DIAMOND,
    newFacets: proposal.newFacets,
    proposalId: proposal.proposalId,
    proposeTx: proposal.proposeTx,
    executeTx: receipt.hash,
    executedVia: "GnosisSafe",
    safeSigners: [signer1.address, signer2.address],
    executedAt: new Date().toISOString(),
    auditFindings: ["C-1","C-2","H-1","H-2","H-3","H-4","M-1","M-2","M-3","M-4","M-5","M-6","M-7","L-1","L-2","L-3"],
  };
  fs2.writeFileSync("deployments-v6-final-lisk.json", JSON.stringify(snapshot, null, 2));
  console.log("\nFinal snapshot saved to deployments-v6-final-lisk.json");
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
