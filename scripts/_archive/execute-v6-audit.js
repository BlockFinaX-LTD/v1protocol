/**
 * execute-v6-audit.js
 *
 * Executes the timelocked v6 audit diamondCut after the 48-hour delay.
 * Must be run AFTER the ETA recorded in deployments-v6-proposal-lisk.json.
 *
 * Usage (run 48h after upgrade-v6-audit.js):
 *   npx hardhat run scripts/execute-v6-audit.js --network lisk
 */

const hre = require("hardhat");
const fs  = require("fs");

const PROPOSAL_FILE  = "deployments-v6-proposal-lisk.json";
const FINAL_SNAPSHOT = "deployments-v6-final-lisk.json";

async function main() {
  const { ethers } = hre;

  const [deployer] = await ethers.getSigners();
  console.log("Deployer :", deployer.address);

  if (!fs.existsSync(PROPOSAL_FILE)) {
    throw new Error(`Proposal file not found: ${PROPOSAL_FILE} — run upgrade-v6-audit.js first`);
  }
  const proposal = JSON.parse(fs.readFileSync(PROPOSAL_FILE, "utf8"));

  console.log("Diamond     :", proposal.diamond);
  console.log("proposalId  :", proposal.proposalId);
  console.log("ETA (UTC)   :", proposal.etaISO);

  const now = Math.floor(Date.now() / 1000);
  const eta = Number(proposal.eta);
  if (now < eta) {
    const secsLeft = eta - now;
    const hrsLeft  = (secsLeft / 3600).toFixed(2);
    throw new Error(`Timelock not expired yet — ${hrsLeft} hours remaining (ETA: ${proposal.etaISO})`);
  }
  console.log("\nTimelock expired — executing cut...");

  const executeCutAbi = [
    "function executeCut(bytes32 _proposalId) external",
    "event CutExecuted(bytes32 indexed proposalId)",
  ];
  const diamond = await ethers.getContractAt(executeCutAbi, proposal.diamond);

  const tx = await diamond.executeCut(proposal.proposalId);
  console.log("  tx hash :", tx.hash);
  const receipt = await tx.wait();
  console.log("  confirmed in block", receipt.blockNumber);

  // Verify the new facet addresses via loupe
  const loupeAbi = [
    "function facets() external view returns (tuple(address facetAddress, bytes4[] functionSelectors)[] memory)",
  ];
  const loupe = await ethers.getContractAt(loupeAbi, proposal.diamond);
  const liveFacets = await loupe.facets();

  console.log("\n" + "=".repeat(60));
  console.log("V6 AUDIT UPGRADE EXECUTED");
  console.log("=".repeat(60));
  console.log("Diamond     :", proposal.diamond);
  console.log("Execute tx  :", receipt.hash);
  console.log("\nLive facets post-upgrade:");
  for (const f of liveFacets) {
    console.log(`  ${f.facetAddress}  (${f.functionSelectors.length} selectors)`);
  }
  console.log("=".repeat(60));

  const snapshot = {
    version: "v6-audit-final",
    diamond: proposal.diamond,
    newFacets: proposal.newFacets,
    proposalId: proposal.proposalId,
    proposeTx: proposal.proposeTx,
    executeTx: receipt.hash,
    executedAt: new Date().toISOString(),
    auditFindings: [
      "C-1","C-2","H-1","H-2","H-3","H-4",
      "M-1","M-2","M-3","M-4","M-5","M-6","M-7",
      "L-1","L-2","L-3",
    ],
  };
  fs.writeFileSync(FINAL_SNAPSHOT, JSON.stringify(snapshot, null, 2));
  console.log(`\nFinal snapshot saved to ${FINAL_SNAPSHOT}`);

  // Verify commands
  console.log("\nVerify new facets on Blockscout:");
  for (const [key, addr] of Object.entries(proposal.newFacets)) {
    console.log(`  npx hardhat verify --network lisk ${addr}  # ${key}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
