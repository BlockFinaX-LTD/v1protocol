/**
 * diamond.test.js — exercises the Diamond cut and loupe machinery.
 *
 * Covers:
 *   - Add: a brand-new facet's selectors become callable
 *   - Replace: a selector starts dispatching to a different facet
 *   - Remove: the selector becomes uncallable
 *   - Loupe: facets(), facetFunctionSelectors(), facetAddresses(), facetAddress()
 *     correctly reflect the current routing table
 *   - Authority: only the contract owner can perform a cut
 *   - Edge cases:
 *       - cannot Add an existing selector
 *       - cannot Replace with the same facet address
 *       - cannot Remove a selector that doesn't exist
 *       - Remove cuts must use facetAddress = address(0) per EIP-2535
 */

const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { deployDiamondFixture, getSelectors } = require("../helpers/fixtures");

const ACTION = { Add: 0, Replace: 1, Remove: 2 };

async function deployTestFacet(name = "TestPureFacet") {
  const Factory = await ethers.getContractFactory(name);
  const f = await Factory.deploy();
  await f.waitForDeployment();
  return f;
}

describe("Diamond — cut & loupe machinery", function () {

  describe("Add", function () {
    it("makes the new facet's selectors callable on the Diamond", async function () {
      const { signers, addresses, loupe } = await loadFixture(deployDiamondFixture);
      const test = await deployTestFacet();
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);

      const selectors = getSelectors(test);
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: selectors }],
        ethers.ZeroAddress, "0x",
      );

      // Bind the test ABI to the Diamond and call the new functions.
      const viaDiamond = await ethers.getContractAt("TestPureFacet", addresses.diamond);
      expect(await viaDiamond.getMagicNumber()).to.equal(42n);
      expect(await viaDiamond.getMagicString()).to.equal("hello");
      expect(await viaDiamond.echo(7n)).to.equal(7n);

      // Loupe reflects the new facet.
      expect(await loupe.facetAddress(test.interface.getFunction("getMagicNumber").selector))
        .to.equal(await test.getAddress());
      const facetSelectors = await loupe.facetFunctionSelectors(await test.getAddress());
      expect(facetSelectors.length).to.equal(selectors.length);
    });

    it("reverts when trying to Add a selector that already exists", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const test = await deployTestFacet();
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);

      // Add once.
      const selector = test.interface.getFunction("getMagicNumber").selector;
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: [selector] }],
        ethers.ZeroAddress, "0x",
      );
      // Add again → revert.
      await expect(cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: [selector] }],
        ethers.ZeroAddress, "0x",
      )).to.be.revertedWith("LibDiamondCut: Can't add function that already exists");
    });

    it("reverts when facetAddress is zero", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
      await expect(cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: ethers.ZeroAddress, action: ACTION.Add, functionSelectors: ["0xdeadbeef"] }],
        ethers.ZeroAddress, "0x",
      )).to.be.revertedWith("LibDiamondCut: Add facet can't be address(0)");
    });
  });

  describe("Replace", function () {
    it("re-routes the selector to the new facet; other selectors are untouched", async function () {
      const { signers, addresses, loupe } = await loadFixture(deployDiamondFixture);
      const v1 = await deployTestFacet("TestPureFacet");
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);

      // Add v1 (3 selectors).
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await v1.getAddress(), action: ACTION.Add, functionSelectors: getSelectors(v1) }],
        ethers.ZeroAddress, "0x",
      );

      // Deploy v2 and Replace ONLY getMagicNumber.
      const v2 = await deployTestFacet("TestPureFacetV2");
      const magicSelector = v1.interface.getFunction("getMagicNumber").selector;
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await v2.getAddress(), action: ACTION.Replace, functionSelectors: [magicSelector] }],
        ethers.ZeroAddress, "0x",
      );

      // getMagicNumber now returns 100 (v2 implementation).
      const viaDiamond = await ethers.getContractAt("TestPureFacet", addresses.diamond);
      expect(await viaDiamond.getMagicNumber()).to.equal(100n);
      // The other v1 selectors still work.
      expect(await viaDiamond.getMagicString()).to.equal("hello");
      expect(await viaDiamond.echo(99n)).to.equal(99n);

      // Loupe shows the new routing.
      expect(await loupe.facetAddress(magicSelector)).to.equal(await v2.getAddress());
    });

    it("regression: Replace into a brand-new facet REGISTERS it in facetAddresses[]", async function () {
      // This test pins the LibDiamond.replaceFunctions fix. Pre-fix, when a Replace cut
      // moved selectors to a facet address that wasn't already in facetAddresses[],
      // the new address was NEVER added — selector routing worked but the Loupe lied.
      // We ran into this in production after the v8 upgrade and had to do a corrective
      // Remove+Add cut on three mainnet Diamonds (see scripts/rebuild-facet-table.js).
      // After the fix, Replace into a new facet address must push that address into
      // facetAddresses[] just like Add does.

      const { signers, addresses, loupe } = await loadFixture(deployDiamondFixture);
      const v1 = await deployTestFacet("TestPureFacet");
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);

      // Step 1: Add v1 with one selector. Now v1's address IS in facetAddresses[].
      const sel = v1.interface.getFunction("getMagicNumber").selector;
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await v1.getAddress(), action: ACTION.Add, functionSelectors: [sel] }],
        ethers.ZeroAddress, "0x",
      );
      const v1Addr = (await v1.getAddress()).toLowerCase();
      let addrs = (await loupe.facetAddresses()).map(a => a.toLowerCase());
      expect(addrs.includes(v1Addr)).to.equal(true);

      // Step 2: deploy a brand-new v2 and Replace. The v2 address is NEW to the Diamond.
      const v2 = await deployTestFacet("TestPureFacetV2");
      const v2Addr = (await v2.getAddress()).toLowerCase();
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await v2.getAddress(), action: ACTION.Replace, functionSelectors: [sel] }],
        ethers.ZeroAddress, "0x",
      );

      // The selector must route to v2 ...
      expect((await loupe.facetAddress(sel)).toLowerCase()).to.equal(v2Addr);
      // ... AND v2's address must now be in facetAddresses[] (this is what the bug fix asserts).
      addrs = (await loupe.facetAddresses()).map(a => a.toLowerCase());
      expect(addrs.includes(v2Addr)).to.equal(true);
    });

    it("reverts when replacing a selector with the same facet (no-op cut)", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const v1 = await deployTestFacet("TestPureFacet");
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
      const selector = v1.interface.getFunction("getMagicNumber").selector;
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await v1.getAddress(), action: ACTION.Add, functionSelectors: [selector] }],
        ethers.ZeroAddress, "0x",
      );
      await expect(cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await v1.getAddress(), action: ACTION.Replace, functionSelectors: [selector] }],
        ethers.ZeroAddress, "0x",
      )).to.be.revertedWith("LibDiamondCut: Can't replace function with same function");
    });
  });

  describe("Remove", function () {
    it("removes the selector — calling it now reverts in the fallback", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const test = await deployTestFacet();
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
      const selector = test.interface.getFunction("getMagicNumber").selector;
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Add, functionSelectors: [selector] }],
        ethers.ZeroAddress, "0x",
      );
      // Remove (per EIP-2535: facetAddress must be zero on Remove).
      await cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: ethers.ZeroAddress, action: ACTION.Remove, functionSelectors: [selector] }],
        ethers.ZeroAddress, "0x",
      );

      const viaDiamond = await ethers.getContractAt("TestPureFacet", addresses.diamond);
      await expect(viaDiamond.getMagicNumber()).to.be.revertedWith("Diamond: Function does not exist");
    });

    it("reverts if Remove cut uses a non-zero facetAddress", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const test = await deployTestFacet();
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
      await expect(cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: await test.getAddress(), action: ACTION.Remove, functionSelectors: ["0xdeadbeef"] }],
        ethers.ZeroAddress, "0x",
      )).to.be.revertedWith("LibDiamondCut: Remove facet address must be address(0)");
    });

    it("reverts when removing a selector that doesn't exist", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
      await expect(cutAt.connect(signers.owner).diamondCut(
        [{ facetAddress: ethers.ZeroAddress, action: ACTION.Remove, functionSelectors: ["0xdeadbeef"] }],
        ethers.ZeroAddress, "0x",
      )).to.be.revertedWith("LibDiamondCut: Can't remove function that doesn't exist");
    });
  });

  describe("Authority", function () {
    it("non-owner cannot cut", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      const cutAt = await ethers.getContractAt("BlockFinaXDiamondCutFacet", addresses.diamond);
      await expect(cutAt.connect(signers.stranger).diamondCut([], ethers.ZeroAddress, "0x"))
        .to.be.revertedWith("LibDiamond: Must be contract owner");
    });
  });

  describe("Loupe — view consistency", function () {
    it("facets() returns one entry per registered facet with its full selector list", async function () {
      const { addresses, loupe } = await loadFixture(deployDiamondFixture);
      const facets = await loupe.facets();
      // Fixture registers 4 facets: cut, loupe, hedge, oracle.
      expect(facets.length).to.equal(4);
      for (const f of facets) {
        expect(f.facetAddress).to.not.equal(ethers.ZeroAddress);
        expect(f.functionSelectors.length).to.be.gt(0);
      }
    });

    it("facetAddresses() returns each facet exactly once", async function () {
      const { loupe } = await loadFixture(deployDiamondFixture);
      const list = await loupe.facetAddresses();
      const set = new Set(list.map(a => a.toLowerCase()));
      expect(set.size).to.equal(list.length);
      expect(list.length).to.equal(4);
    });

    it("facetAddress(unknown selector) returns address(0)", async function () {
      const { loupe } = await loadFixture(deployDiamondFixture);
      expect(await loupe.facetAddress("0xdeadbeef")).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Diamond constructor", function () {
    it("rejects zero owner / zero cut facet / zero USDC", async function () {
      const Diamond = await ethers.getContractFactory("BlockFinaXDiamond");
      const Cut = await ethers.getContractFactory("BlockFinaXDiamondCutFacet");
      const cut = await Cut.deploy(); await cut.waitForDeployment();
      const Mock = await ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy("USDC", "USDC", 6); await usdc.waitForDeployment();

      await expect(Diamond.deploy(ethers.ZeroAddress, await cut.getAddress(), await usdc.getAddress()))
        .to.be.revertedWith("Diamond: zero owner");

      const [a] = await ethers.getSigners();
      await expect(Diamond.deploy(a.address, ethers.ZeroAddress, await usdc.getAddress()))
        .to.be.revertedWith("Diamond: zero cut facet");
      await expect(Diamond.deploy(a.address, await cut.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWith("Diamond: zero USDC");
    });

    it("rejects raw ETH transfers (USDC-only contract)", async function () {
      const { signers, addresses } = await loadFixture(deployDiamondFixture);
      await expect(signers.stranger.sendTransaction({
        to: addresses.diamond, value: ethers.parseEther("1"),
      })).to.be.revertedWith("Diamond: ETH not accepted. Use USDC.");
    });
  });
});
