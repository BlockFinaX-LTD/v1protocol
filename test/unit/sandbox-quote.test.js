const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySandbox } = require("../../scripts/deploy-sandbox");

// Run with the main application's built sandbox quote module to prove ABI/signature parity.
(process.env.SANDBOX_QUOTE_MODULE ? describe : describe.skip)("Sandbox quote interoperability", function () {
  it("accepts the pricing service's attestation on the real protocol", async function () {
    const { sandboxQuote } = require(process.env.SANDBOX_QUOTE_MODULE);
    const { token, hedge, manifest } = await deploySandbox();
    const [owner] = await ethers.getSigners();
    const signer = ethers.Wallet.createRandom();
    await hedge.setPricingEngineSigner(signer.address);
    await token.approve(manifest.diamond, ethers.MaxUint256);
    const now = await time.latest();
    const body = { pair: "USD/GHS", strike: 11, payoutCap: 12, notional: 100, expiryUnixSeconds: now + 86400 * 30, strikeAbove: true, chainId: 84532, diamondAddress: manifest.diamond, creator: owner.address };
    const quote = await sandboxQuote(body, { diamond: manifest.diamond, signerKey: signer.privateKey }, now);
    await hedge.createEvent({ name: "Signed partner pool", underlying: body.pair, strike: 11000000, payoutCap: 12000000, premiumRate: quote.premiumRateFixed6, expiryDate: body.expiryUnixSeconds, allowExternalLp: true, initialLiquidity: 1000000000, initialRate: 10000000, strikeAbove: true, paymentToken: manifest.token, signature: quote.attestation.signature, quoteTimestamp: quote.attestation.quoteTimestamp, quoteNonce: quote.attestation.quoteNonce });
    expect(await hedge.getEventQuoteSigner(1)).to.equal(signer.address);
  });
});
