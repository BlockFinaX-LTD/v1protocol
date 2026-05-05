/**
 * upgrade-v6-audit.js
 *
 * Deploys all four updated facets (v6 — full security audit) and proposes a
 * single combined diamondCut through the TimelockCutFacet (48-hour delay).
 *
 * Audit fixes included in this batch:
 *   C-1  liquidityAtSettlement snapshot (LP withdrawal denominator)
 *   C-2  tokenReserves mapping replaces balanceOf() in recoverExpiredPayouts
 *   H-1  oracleV2Active guard moved into onlyOracleAdmin modifier
 *   H-2  premiumDust accumulator for integer rounding
 *   H-3  lastSubmitTime preservation on oracle disagreement clears
 *   H-4  DiamondLoupe NatSpec; confirmed selectorToFacetAndPosition correct
 *   M-1  settleEvent timing / strike-reached guard
 *   M-2  TimelockCutFacet bytecode validation on proposals
 *   M-3  buyProtection maxCost + deadline slippage guards
 *   M-4  (already in v3) proposalId nonce
 *   M-5  claimPremiums tokenReserves balance check
 *   M-6  removeOracle quorum guard
 *   M-7  addOracle config event
 *   L-1  EVENT_CREATION_FEE default 2 USDC
 *   L-2  rescueETH gas raised to 10 000
 *   L-3  settleEvent price ±100× initialRate guard
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-v6-audit.js --network lisk
 *
 * After 48 hours run:
 *   npx hardhat run scripts/execute-v6-audit.js --network lisk
 */

const hre = require("hardhat");
const fs  = require("fs");

const DEPLOYMENT_FILE = "deployments-v3-fixed-lisk-1775082736051.json";
const PROPOSAL_FILE   = "deployments-v6-proposal-lisk.json";

async function main() {
  const { ethers } = hre;

  const [deployer] = await ethers.getSigners();
  console.log("Deployer :", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance  :", ethers.formatEther(balance), "LSK\n");

  // ── Load current deployment state ────────────────────────────────────────
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`Deployment file not found: ${DEPLOYMENT_FILE}`);
  }
  const deployment  = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
  const DIAMOND     = deployment.diamond;
  console.log("Diamond  :", DIAMOND);

  // ── Deploy new facets ─────────────────────────────────────────────────────
  console.log("\n[1/4] Deploying BlockFinaXHedgeFacet v6...");
  const HedgeF  = await ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedge   = await HedgeF.deploy();
  await hedge.waitForDeployment();
  const hedgeAddr = await hedge.getAddress();
  console.log("  HedgeFacet     :", hedgeAddr);

  console.log("[2/4] Deploying BlockFinaXOracleFacet v6...");
  const OracleF  = await ethers.getContractFactory("BlockFinaXOracleFacet");
  const oracle   = await OracleF.deploy();
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log("  OracleFacet    :", oracleAddr);

  console.log("[3/4] Deploying BlockFinaXDiamondLoupeFacet v6...");
  const LoupeF  = await ethers.getContractFactory("BlockFinaXDiamondLoupeFacet");
  const loupe   = await LoupeF.deploy();
  await loupe.waitForDeployment();
  const loupeAddr = await loupe.getAddress();
  console.log("  LoupeFacet     :", loupeAddr);

  console.log("[4/4] Deploying BlockFinaXTimelockCutFacet v6...");
  const TimelockF  = await ethers.getContractFactory("BlockFinaXTimelockCutFacet");
  const timelock   = await TimelockF.deploy();
  await timelock.waitForDeployment();
  const timelockAddr = await timelock.getAddress();
  console.log("  TimelockFacet  :", timelockAddr);

  // ── Query Diamond loupe for current selector assignments ──────────────────
  console.log("\nQuerying Diamond loupe...");
  const loupeAbi = [
    "function facets() external view returns (tuple(address facetAddress, bytes4[] functionSelectors)[] memory)",
    "function facetAddress(bytes4 selector) view returns (address)",
  ];
  const diamond = await ethers.getContractAt(loupeAbi, DIAMOND);
  const currentFacets = await diamond.facets();

  // Build map: selector (lowercase) → current facet address
  const selectorToCurrentFacet = {};
  for (const f of currentFacets) {
    for (const sel of f.functionSelectors) {
      selectorToCurrentFacet[sel.toLowerCase()] = f.facetAddress.toLowerCase();
    }
  }
  console.log(`  ${Object.keys(selectorToCurrentFacet).length} selectors currently registered\n`);

  // ── Build per-facet selector lists ────────────────────────────────────────
  function getSelectors(factory) {
    return factory.interface.fragments
      .filter(f => f.type === "function")
      .map(f => f.selector);
  }

  const facetMap = [
    { name: "HedgeFacet",     addr: hedgeAddr,    factory: HedgeF   },
    { name: "OracleFacet",    addr: oracleAddr,   factory: OracleF  },
    { name: "LoupeFacet",     addr: loupeAddr,    factory: LoupeF   },
    { name: "TimelockFacet",  addr: timelockAddr, factory: TimelockF },
  ];

  // Track which selectors across ALL new facets are handled
  const allNewSelectors = new Set();
  facetMap.forEach(f => getSelectors(f.factory).forEach(s => allNewSelectors.add(s.toLowerCase())));

  const cuts = [];

  for (const { name, addr, factory } of facetMap) {
    const selectors = getSelectors(factory);
    const toAdd     = [];
    const toReplace = [];

    for (const sel of selectors) {
      const existing = selectorToCurrentFacet[sel.toLowerCase()];
      if (!existing || existing === ethers.ZeroAddress.toLowerCase()) {
        toAdd.push(sel);
      } else {
        toReplace.push(sel);
      }
    }

    console.log(`${name}:`);
    console.log(`  Add     : ${toAdd.length}`);
    console.log(`  Replace : ${toReplace.length}`);

    if (toAdd.length > 0)     cuts.push({ facetAddress: addr, action: 0, functionSelectors: toAdd });
    if (toReplace.length > 0) cuts.push({ facetAddress: addr, action: 1, functionSelectors: toReplace });
  }

  // Remove selectors from OLD facets that are no longer in any new facet
  const oldAddresses = new Set([
    deployment.facets.blockFinaXHedge?.toLowerCase(),
    deployment.facets.blockFinaXOracle?.toLowerCase(),
    deployment.facets.blockFinaXDiamondLoupe?.toLowerCase(),
    deployment.facets.blockFinaXTimelockCut?.toLowerCase(),
  ].filter(Boolean));

  const toRemove = [];
  for (const [sel, facetAddr] of Object.entries(selectorToCurrentFacet)) {
    if (oldAddresses.has(facetAddr) && !allNewSelectors.has(sel)) {
      toRemove.push(sel);
    }
  }
  if (toRemove.length > 0) {
    console.log(`\nRemoving ${toRemove.length} deprecated selector(s)`);
    cuts.push({ facetAddress: ethers.ZeroAddress, action: 2, functionSelectors: toRemove });
  }

  console.log(`\nTotal cut operations: ${cuts.length}`);
  if (cuts.length === 0) {
    console.log("Nothing to cut — aborting.");
    return;
  }

  // ── Submit via TimelockCutFacet ───────────────────────────────────────────
  console.log("\nProposing timelocked diamondCut...");
  const timelockCutAbi = [
    "function diamondCut(tuple(address facetAddress, uint8 action, bytes4[] functionSelectors)[] calldata _diamondCut, address _init, bytes calldata _calldata) external",
    "event CutProposed(bytes32 indexed proposalId, uint256 eta)",
  ];
  const timelockCutFacet = await ethers.getContractAt(timelockCutAbi, DIAMOND);

  const tx = await timelockCutFacet.diamondCut(cuts, ethers.ZeroAddress, "0x");
  console.log("  tx hash :", tx.hash);
  const receipt = await tx.wait();
  console.log("  confirmed in block", receipt.blockNumber);

  // Extract proposalId + eta from CutProposed event
  const iface = new ethers.Interface([
    "event CutProposed(bytes32 indexed proposalId, uint256 eta)",
  ]);
  let proposalId, eta;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "CutProposed") {
        proposalId = parsed.args.proposalId;
        eta        = parsed.args.eta;
        break;
      }
    } catch (_) {}
  }

  if (!proposalId) throw new Error("CutProposed event not found in receipt — check tx manually");

  const etaDate = new Date(Number(eta) * 1000).toISOString();
  console.log("\n" + "=".repeat(60));
  console.log("PROPOSAL SUBMITTED");
  console.log("=".repeat(60));
  console.log("proposalId  :", proposalId);
  console.log("eta (UTC)   :", etaDate);
  console.log("=".repeat(60));
  console.log(`\nRun execute-v6-audit.js after ${etaDate}`);

  // ── Save proposal for executor ────────────────────────────────────────────
  const proposal = {
    version: "v6-audit",
    diamond: DIAMOND,
    proposalId,
    eta: eta.toString(),
    etaISO: etaDate,
    newFacets: {
      blockFinaXHedge:        hedgeAddr,
      blockFinaXOracle:       oracleAddr,
      blockFinaXDiamondLoupe: loupeAddr,
      blockFinaXTimelockCut:  timelockAddr,
    },
    proposeTx: tx.hash,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(PROPOSAL_FILE, JSON.stringify(proposal, null, 2));
  console.log(`\nProposal saved to ${PROPOSAL_FILE}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
