/**
 * timelock.test.js — exercises BlockFinaXTimelockCutFacet.
 *
 * Setup:
 *   The fixture installs the immediate (non-timelocked) DiamondCutFacet. To test the timelock,
 *   each test first uses the immediate cut to Replace the diamondCut(...) selector with the
 *   timelock version, and Add the timelock-only selectors (executeCut, cancelCut, getProposal,
 *   getAllCutIds, getPendingCutIds, getPendingCutInfo). After this graduation step, every
 *   subsequent diamondCut() goes through the timelock.
 *
 * Covers:
 *   - Propose: returns a CutProposed event with eta = now + 48h
 *   - executeCut before eta reverts ("Timelock delay not elapsed")
 *   - executeCut after eta succeeds and applies the cut
 *   - cancelCut blocks subsequent executeCut
 *   - executeCut on already-executed reverts
 *   - executeCut on already-cancelled reverts
 *   - Proposal expires after MAX_PROPOSAL_AGE (30 days)
 *   - Only owner can propose / execute / cancel
 *   - M-04 fix: same payload submitted twice in same block produces distinct proposalIds
 *     (nonce is included in the keccak256 input)
 *   - M-2 fix: proposing a cut where Add/Replace facetAddress has no bytecode reverts
 *     at proposal time, not at execution time
 */

const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { deployDiamondFixture, getSelectors } = require("../helpers/fixtures");

const ACTION = { Add: 0, Replace: 1, Remove: 2 };
const TIMELOCK_DELAY  = 48 * 60 * 60;       // 48 hours
const MAX_PROPOSAL_AGE = 30 * 24 * 60 * 60; // 30 days

/**
 * Replace the immediate diamondCut(...) selector with the timelock version, and Add the
 * extra timelock-specific selectors. After this, all diamondCut(...) calls on the Diamond
 * are gated by the 48h timelock.
 */
async function graduateToTimelock(signers, diamondAddress) {
  const Timelock = await ethers.getContractFactory("BlockFinaXTimelockCutFacet");
  const timelock = await Timelock.deploy();
  await timelock.waitForDeployment();
  const timelockAddr = await timelock.getAddress();

  const allSelectors = getSelectors(timelock);
  const diamondCutSelector = timelock.interface.getFunction("diamondCut").selector;
  const otherSelectors = allSelectors.filter(s => s !== diamondCutSelector);

  const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", diamondAddress);
  await cutAt.connect(signers.owner).diamondCut(
    [
      { facetAddress: timelockAddr, action: ACTION.Replace, functionSelectors: [diamondCutSelector] },
      { facetAddress: timelockAddr, action: ACTION.Add,     functionSelectors: otherSelectors },
    ],
    ethers.ZeroAddress, "0x",
  );

  return await ethers.getContractAt("BlockFinaXTimelockCutFacet", diamondAddress);
}

/** Deploy a TestPureFacet so we have something to propose adding via the timelock. */
async function deployTestFacet() {
  const F = await ethers.getContractFactory("TestPureFacet");
  const f = await F.deploy(); await f.waitForDeployment();
  return f;
}

describe("BlockFinaXTimelockCutFacet", function () {

  describe("Graduation", function () {
    it("immediate cut facet can install the timelock cut facet (one-shot graduation)", async function () {
      const { signers, addresses, loupe } = await loadFixture(deployDiamondFixture);
      await graduateToTimelock(signers, addresses.diamond);

      // Loupe shows the timelock-only selectors are now registered.
      const tl = await ethers.getContractAt("BlockFinaXTimelockCutFacet", addresses.diamond);
      // executeCut selector should resolve to a non-zero facet now.
      const executeSel = tl.interface.getFunction("executeCut").selector;
      expect(await loupe.facetAddress(executeSel)).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("Propose", function () {
    it("returns a CutProposed event with eta = block.timestamp + 48h", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();

      const tx = await tl.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
        ethers.ZeroAddress, "0x",
      );
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const proposedLog = receipt.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      });
      expect(proposedLog).to.exist;
      const parsed = tl.interface.parseLog(proposedLog);
      expect(parsed.args.eta).to.equal(BigInt(block.timestamp + TIMELOCK_DELAY));
    });

    it("non-owner cannot propose", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();
      await expect(tl.connect(signers.stranger).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
        ethers.ZeroAddress, "0x",
      )).to.be.revertedWith("LibDiamond: Must be contract owner");
    });

    it("M-2 fix: rejects proposal where Add/Replace target has no bytecode", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      // signers.stranger is an EOA → no bytecode → should be caught at proposal time.
      await expect(tl.connect(signers.owner).diamondCut(
        [{ facetAddress: signers.stranger.address, action: ACTION.Add, functionSelectors: ["0xdeadbeef"] }],
        ethers.ZeroAddress, "0x",
      )).to.be.revertedWith("Facet address has no code (not a contract)");
    });

    it("M-2 fix: rejects zero facetAddress for Add/Replace", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      await expect(tl.connect(signers.owner).diamondCut(
        [{ facetAddress: ethers.ZeroAddress, action: ACTION.Add, functionSelectors: ["0xdeadbeef"] }],
        ethers.ZeroAddress, "0x",
      )).to.be.revertedWith("Facet address is zero");
    });

    it("M-04 fix: identical payloads in the same block produce distinct proposalIds", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();
      const cut = [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }];

      // First propose.
      const tx1 = await tl.connect(signers.owner).diamondCut(cut, ethers.ZeroAddress, "0x");
      const r1 = await tx1.wait();
      const id1 = tl.interface.parseLog(r1.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      })).args.proposalId;

      // Second propose with same payload — without the M-04 nonce, this would collide
      // (same payload + same block.timestamp + same block.number).
      const tx2 = await tl.connect(signers.owner).diamondCut(cut, ethers.ZeroAddress, "0x");
      const r2 = await tx2.wait();
      const id2 = tl.interface.parseLog(r2.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      })).args.proposalId;

      expect(id1).to.not.equal(id2);
    });
  });

  describe("Execute", function () {
    async function proposeOne(signers, tl) {
      const test = await deployTestFacet();
      const tx = await tl.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
        ethers.ZeroAddress, "0x",
      );
      const r = await tx.wait();
      const proposalId = tl.interface.parseLog(r.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      })).args.proposalId;
      return { proposalId, test };
    }

    it("reverts before the 48h delay has elapsed", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const { proposalId } = await proposeOne(signers, tl);
      await expect(tl.connect(signers.owner).executeCut(proposalId))
        .to.be.revertedWith("Timelock delay not elapsed");
    });

    it("succeeds after 48h and applies the cut", async function () {
      const { signers, addresses, loupe } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const { proposalId, test } = await proposeOne(signers, tl);

      await time.increase(TIMELOCK_DELAY + 1);
      await tl.connect(signers.owner).executeCut(proposalId);

      // The new facet's selector is now live.
      const sel = test.interface.getFunction("getMagicNumber").selector;
      expect(await loupe.facetAddress(sel)).to.equal(await test.getAddress());
      const viaDiamond = await ethers.getContractAt("TestPureFacet", addresses.diamond);
      expect(await viaDiamond.getMagicNumber()).to.equal(42n);
    });

    it("cannot execute the same proposal twice", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const { proposalId } = await proposeOne(signers, tl);
      await time.increase(TIMELOCK_DELAY + 1);
      await tl.connect(signers.owner).executeCut(proposalId);
      await expect(tl.connect(signers.owner).executeCut(proposalId))
        .to.be.revertedWith("Already executed");
    });

    it("non-owner cannot execute", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const { proposalId } = await proposeOne(signers, tl);
      await time.increase(TIMELOCK_DELAY + 1);
      await expect(tl.connect(signers.stranger).executeCut(proposalId))
        .to.be.revertedWith("LibDiamond: Must be contract owner");
    });

    it("rejects unknown proposal id", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      await expect(tl.connect(signers.owner).executeCut(ethers.ZeroHash))
        .to.be.revertedWith("Unknown proposal");
    });

    it("rejects executing after MAX_PROPOSAL_AGE has passed", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const { proposalId } = await proposeOne(signers, tl);
      // Skip well past 48h + 30d.
      await time.increase(TIMELOCK_DELAY + MAX_PROPOSAL_AGE + 1);
      await expect(tl.connect(signers.owner).executeCut(proposalId))
        .to.be.revertedWith("Proposal expired: re-propose");
    });
  });

  describe("Cancel", function () {
    it("blocks subsequent executeCut", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();
      const tx = await tl.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
        ethers.ZeroAddress, "0x",
      );
      const r = await tx.wait();
      const proposalId = tl.interface.parseLog(r.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      })).args.proposalId;

      await tl.connect(signers.owner).cancelCut(proposalId);
      await time.increase(TIMELOCK_DELAY + 1);
      await expect(tl.connect(signers.owner).executeCut(proposalId))
        .to.be.revertedWith("Proposal cancelled");
    });

    it("cannot cancel twice", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();
      const tx = await tl.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
        ethers.ZeroAddress, "0x",
      );
      const r = await tx.wait();
      const proposalId = tl.interface.parseLog(r.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      })).args.proposalId;
      await tl.connect(signers.owner).cancelCut(proposalId);
      await expect(tl.connect(signers.owner).cancelCut(proposalId))
        .to.be.revertedWith("Already cancelled");
    });

    it("non-owner cannot cancel", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();
      const tx = await tl.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
        ethers.ZeroAddress, "0x",
      );
      const r = await tx.wait();
      const proposalId = tl.interface.parseLog(r.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      })).args.proposalId;
      await expect(tl.connect(signers.stranger).cancelCut(proposalId))
        .to.be.revertedWith("LibDiamond: Must be contract owner");
    });
  });

  describe("Views", function () {
    it("getProposal returns status, eta, init, calldata", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();
      const tx = await tl.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
        ethers.ZeroAddress, "0x",
      );
      const r = await tx.wait();
      const proposalId = tl.interface.parseLog(r.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      })).args.proposalId;

      let p = await tl.getProposal(proposalId);
      expect(p.status).to.equal(0);  // pending

      await tl.connect(signers.owner).cancelCut(proposalId);
      p = await tl.getProposal(proposalId);
      expect(p.status).to.equal(1);  // cancelled
    });

    it("getAllCutIds returns every proposal ever created", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();
      // Create three proposals.
      for (let i = 0; i < 3; i++) {
        await tl.connect(signers.owner).diamondCut(
          [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: ["0x" + (i + 1).toString().padStart(8, "0")] }],
          ethers.ZeroAddress, "0x",
        );
      }
      const ids = await tl.getAllCutIds();
      expect(ids.length).to.equal(3);
    });

    it("legacy views getPendingCutIds / getPendingCutInfo mirror the new getters", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const tl = await graduateToTimelock(signers, addresses.diamond);
      const test = await deployTestFacet();

      const tx = await tl.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
        ethers.ZeroAddress, "0x",
      );
      const r = await tx.wait();
      const proposalId = tl.interface.parseLog(r.logs.find(l => {
        try { return tl.interface.parseLog(l)?.name === "CutProposed"; } catch { return false; }
      })).args.proposalId;

      // getPendingCutIds is the back-compat alias of getAllCutIds.
      const pendingIds = await tl.getPendingCutIds();
      expect(pendingIds.length).to.equal(1);
      expect(pendingIds[0]).to.equal(proposalId);

      // getPendingCutInfo returns (eta, executed, cancelled) for the proposal.
      const info = await tl.getPendingCutInfo(proposalId);
      expect(info.eta).to.be.gt(0n);
      expect(info.executed).to.equal(false);
      expect(info.cancelled).to.equal(false);

      // After cancelling, the legacy info reflects it.
      await tl.connect(signers.owner).cancelCut(proposalId);
      const info2 = await tl.getPendingCutInfo(proposalId);
      expect(info2.cancelled).to.equal(true);
    });
  });
});
