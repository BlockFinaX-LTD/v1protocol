/**
 * diamondInit.test.js — the `_init` delegatecall branch of LibDiamond.diamondCut().
 *
 * Every other diamond test passes _init = address(0) (no initializer). This file drives the
 * initializeDiamondCut() path: a successful initializer delegatecall, the enforceHasContractCode
 * guard (init address with no bytecode), and both revert-propagation branches (reason string
 * vs. empty revert data).
 */

const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { deployDiamondFixture, getSelectors } = require("../helpers/fixtures");

const ACTION = { Add: 0, Replace: 1, Remove: 2 };

async function deployInitFacet() {
  const F = await ethers.getContractFactory("TestInitFacet");
  const f = await F.deploy();
  await f.waitForDeployment();
  return f;
}

describe("LibDiamond.diamondCut — _init initializer path", function () {
  it("runs a successful initializer delegatecall during the cut", async function () {
    const { signers, addresses } = await loadFixture(deployDiamondFixture);
    const test = await ethers.getContractFactory("TestPureFacet").then(f => f.deploy());
    await test.waitForDeployment();
    const init = await deployInitFacet();

    const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
    const initCalldata = init.interface.encodeFunctionData("init", [7n]);

    // The DiamondCut event fires; the initializer delegatecall executes in the Diamond context.
    await expect(cutAt.connect(signers.owner).diamondCut(
      [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(test) }],
      await init.getAddress(),
      initCalldata,
    )).to.emit(cutAt, "DiamondCut");

    // The Add still took effect.
    const viaDiamond = await ethers.getContractAt("TestPureFacet", addresses.diamond);
    expect(await viaDiamond.getMagicNumber()).to.equal(42n);
  });

  it("reverts when _init address has no bytecode", async function () {
    const { signers, addresses } = await loadFixture(deployDiamondFixture);
    const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
    // Use an EOA as the init target → enforceHasContractCode must reject it.
    await expect(cutAt.connect(signers.owner).diamondCut(
      [],
      signers.stranger.address,
      "0x12345678",
    )).to.be.revertedWith("LibDiamondCut: _init address has no code");
  });

  it("propagates the initializer's revert reason string", async function () {
    const { signers, addresses } = await loadFixture(deployDiamondFixture);
    const init = await deployInitFacet();
    const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
    const data = init.interface.encodeFunctionData("initRevertWithReason", []);
    await expect(cutAt.connect(signers.owner).diamondCut([], await init.getAddress(), data))
      .to.be.revertedWith("init failed on purpose");
  });

  it("falls back to the generic message when the initializer reverts with no data", async function () {
    const { signers, addresses } = await loadFixture(deployDiamondFixture);
    const init = await deployInitFacet();
    const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
    const data = init.interface.encodeFunctionData("initRevertNoReason", []);
    await expect(cutAt.connect(signers.owner).diamondCut([], await init.getAddress(), data))
      .to.be.revertedWith("LibDiamondCut: _init function reverted");
  });
});
