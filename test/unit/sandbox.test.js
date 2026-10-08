const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySandbox } = require("../../scripts/deploy-sandbox");

describe("Partner sandbox", function () {
  it("faucet claims real ERC20 test funds and prevents immediate repeat claims", async function () {
    const [, partner] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("SandboxUSD")).deploy();
    await token.connect(partner).claim();
    expect(await token.balanceOf(partner.address)).to.equal(10_000_000_000n);
    await expect(token.connect(partner).claim()).to.be.revertedWith("Sandbox: faucet cooldown");
    await time.increase(86_400);
    await token.connect(partner).claim();
    expect(await token.balanceOf(partner.address)).to.equal(20_000_000_000n);
  });

  it("deploys the protocol and completes create, buy, settle, and payout with test funds", async function () {
    const { token, hedge, manifest } = await deploySandbox();
    const [owner, partner] = await ethers.getSigners();
    await token.connect(partner).claim();
    await token.approve(manifest.diamond, ethers.MaxUint256);
    await token.connect(partner).approve(manifest.diamond, ethers.MaxUint256);
    const expiry = (await time.latest()) + 600;
    await hedge.createEvent({ name: "Sandbox integration", underlying: "USD/GHS", strike: 11_000_000, payoutCap: 12_000_000, premiumRate: 25_000, expiryDate: expiry, allowExternalLp: true, initialLiquidity: 1_000_000_000, initialRate: 10_000_000, strikeAbove: true, paymentToken: manifest.token, signature: "0x", quoteTimestamp: 0, quoteNonce: ethers.ZeroHash });
    await hedge.setPoolSettings(1, true, true);
    await hedge.connect(partner).buyProtection(1, 100_000_000, 5_000_000, expiry);
    await time.increaseTo(expiry + 1);
    await hedge.connect(owner).settleEvent(1, 12_000_000);
    const before = await token.balanceOf(partner.address);
    await hedge.connect(partner).claimPayout(1);
    expect(await token.balanceOf(partner.address)).to.be.greaterThan(before);
    expect((await hedge.getHedgePosition(1)).claimed).to.equal(true);
  });
});
