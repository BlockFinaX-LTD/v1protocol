/**
 * smoke.test.js — proves the fixture deploys cleanly. Run first to catch infra problems
 * before debugging real test failures.
 */
const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployDiamondFixture } = require("./fixtures");

describe("Fixture smoke test", function () {
  it("deploys Diamond, registers all facets, initialises fees, funds wallets", async function () {
    const { signers, usdc, hedge, oracle, loupe, addresses, constants } = await loadFixture(deployDiamondFixture);

    // Diamond registered every selector through Loupe.
    const facetAddresses = await loupe.facetAddresses();
    expect(facetAddresses.length).to.be.gte(3); // Loupe + Hedge + Oracle (Cut is registered in constructor)

    // Fees marked initialised.
    expect(await hedge.isFeesInitialized()).to.equal(true);

    // Oracle admin set.
    const cfg = await oracle.getOracleConfig();
    expect(cfg.maxOracles).to.equal(10n);

    // Wallets funded.
    const expectedBalance = 1_000_000n * constants.ONE_USDC;
    expect(await usdc.balanceOf(signers.creator.address)).to.equal(expectedBalance);
    expect(await usdc.balanceOf(signers.lp1.address)).to.equal(expectedBalance);
    expect(await usdc.balanceOf(signers.hedger1.address)).to.equal(expectedBalance);

    // Pre-approval works (allowance == max).
    const allowance = await usdc.allowance(signers.creator.address, addresses.diamond);
    expect(allowance).to.be.gt(10n ** 30n);
  });
});
