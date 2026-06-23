/**
 * ownershipFacet.test.js — the standalone BlockFinaXOwnershipFacet.
 *
 * The default fixture serves ownership through HedgeFacet's own functions, so the dedicated
 * BlockFinaXOwnershipFacet contract is otherwise never exercised. Here we deploy a minimal
 * Diamond (cut facet only) and Add the OwnershipFacet selectors, then drive the two-step
 * ownership flow plus the owner()/pendingOwner() views through it.
 */

const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { getSelectors } = require("../helpers/fixtures");

const ACTION = { Add: 0, Replace: 1, Remove: 2 };

async function deployOwnershipDiamond() {
  const [owner, alice, bob] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdc = await Mock.deploy("USDC", "USDC", 6);
  await usdc.waitForDeployment();

  const Cut = await ethers.getContractFactory("BlockFinaXDiamondCutFacet");
  const cut = await Cut.deploy();
  await cut.waitForDeployment();

  const Diamond = await ethers.getContractFactory("BlockFinaXDiamond");
  const diamond = await Diamond.deploy(owner.address, await cut.getAddress(), await usdc.getAddress());
  await diamond.waitForDeployment();
  const dAddr = await diamond.getAddress();

  const Own = await ethers.getContractFactory("BlockFinaXOwnershipFacet");
  const own = await Own.deploy();
  await own.waitForDeployment();

  const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", dAddr);
  await cutAt.connect(owner).diamondCut(
    [{ facetAddress: await own.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(own) }],
    ethers.ZeroAddress, "0x",
  );

  const ownership = await ethers.getContractAt("BlockFinaXOwnershipFacet", dAddr);
  return { ownership, owner, alice, bob };
}

describe("BlockFinaXOwnershipFacet (standalone)", function () {
  it("owner() returns the constructor owner; pendingOwner() starts empty", async function () {
    const { ownership, owner } = await loadFixture(deployOwnershipDiamond);
    expect(await ownership.owner()).to.equal(owner.address);
    expect(await ownership.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("non-owner cannot start a transfer", async function () {
    const { ownership, alice, bob } = await loadFixture(deployOwnershipDiamond);
    await expect(ownership.connect(alice).transferOwnership(bob.address))
      .to.be.revertedWith("LibDiamond: Must be contract owner");
  });

  it("transferOwnership rejects the zero address", async function () {
    const { ownership, owner } = await loadFixture(deployOwnershipDiamond);
    await expect(ownership.connect(owner).transferOwnership(ethers.ZeroAddress))
      .to.be.revertedWith("LibDiamond: New owner is zero address");
  });

  it("two-step transfer: owner unchanged until pending owner accepts", async function () {
    const { ownership, owner, alice } = await loadFixture(deployOwnershipDiamond);
    await ownership.connect(owner).transferOwnership(alice.address);
    expect(await ownership.pendingOwner()).to.equal(alice.address);
    expect(await ownership.owner()).to.equal(owner.address); // still the old owner
  });

  it("only the pending owner can accept", async function () {
    const { ownership, owner, alice, bob } = await loadFixture(deployOwnershipDiamond);
    await ownership.connect(owner).transferOwnership(alice.address);
    await expect(ownership.connect(bob).acceptOwnership())
      .to.be.revertedWith("LibDiamond: Not pending owner");
  });

  it("acceptOwnership finalises the transfer and clears pendingOwner", async function () {
    const { ownership, owner, alice } = await loadFixture(deployOwnershipDiamond);
    await ownership.connect(owner).transferOwnership(alice.address);
    await ownership.connect(alice).acceptOwnership();
    expect(await ownership.owner()).to.equal(alice.address);
    expect(await ownership.pendingOwner()).to.equal(ethers.ZeroAddress);

    // Old owner no longer has privileges; new owner does.
    await expect(ownership.connect(owner).transferOwnership(owner.address))
      .to.be.revertedWith("LibDiamond: Must be contract owner");
    await expect(ownership.connect(alice).transferOwnership(owner.address)).to.not.be.reverted;
  });
});
