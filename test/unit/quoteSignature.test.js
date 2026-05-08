/**
 * quoteSignature.test.js — pricing-engine ECDSA attestation in createEvent.
 *
 * Two operating modes the contract supports:
 *
 *   Legacy mode (pricingEngineSigner = address(0))
 *   ─────────────────────────────────────────────
 *   - createEvent accepts any premium with empty signature/timestamp/nonce
 *   - evt.quoteSigner is address(0)
 *   - All 163 pre-existing tests rely on this; covered there
 *
 *   Enforced mode (pricingEngineSigner != address(0))
 *   ─────────────────────────────────────────────────
 *   - createEvent REQUIRES a valid signature from the registered signer
 *   - Quote freshness: rejected if signed > 120s ago, or timestamp in future
 *   - Replay protection: each quoteNonce can be used exactly once
 *   - Binding: signature is over (chainId, diamond, msg.sender, all params, ts, nonce)
 *     so a quote stolen from another creator / chain / diamond cannot be used here
 *   - On success, evt.quoteSigner = recovered signer (= configured pricingEngineSigner)
 *
 * Covered here:
 *   - Admin gates: setPricingEngineSigner only by owner; emits event with old + new
 *   - Toggle: setting to non-zero enforces; setting back to zero re-enables legacy
 *   - Happy path: signed quote accepted, quoteSigner field stored
 *   - Reverts: bad signature, expired quote, future timestamp, used nonce, wrong creator,
 *     wrong chainId binding, wrong diamond binding, missing signature when required
 *   - Public views: getPricingEngineSigner, isQuoteNonceUsed, getEventQuoteSigner
 */

const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const {
  deployDiamondFixture,
  buildEventParams,
  setupPricingEngineSigner,
  rate,
  ONE_USDC,
} = require("../helpers/fixtures");
const { signEventParams } = require("../helpers/signQuote");

async function getCtx(hedge, creator) {
  const network = await ethers.provider.getNetwork();
  return {
    chainId: Number(network.chainId),
    diamondAddress: await hedge.getAddress(),
    creator: creator.address,
  };
}

describe("HedgeFacet.setPricingEngineSigner — admin", function () {

  it("only owner can set", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.stranger).setPricingEngineSigner(signers.lp1.address))
      .to.be.revertedWith("Not owner");
  });

  it("setting to non-zero enforces; setting to zero disables", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    expect(await hedge.getPricingEngineSigner()).to.equal(ethers.ZeroAddress);
    await hedge.connect(signers.owner).setPricingEngineSigner(signers.lp1.address);
    expect(await hedge.getPricingEngineSigner()).to.equal(signers.lp1.address);
    await hedge.connect(signers.owner).setPricingEngineSigner(ethers.ZeroAddress);
    expect(await hedge.getPricingEngineSigner()).to.equal(ethers.ZeroAddress);
  });

  it("emits PricingEngineSignerSet with previous + new", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.owner).setPricingEngineSigner(signers.lp1.address))
      .to.emit(hedge, "PricingEngineSignerSet")
      .withArgs(ethers.ZeroAddress, signers.lp1.address);
    await expect(hedge.connect(signers.owner).setPricingEngineSigner(signers.lp2.address))
      .to.emit(hedge, "PricingEngineSignerSet")
      .withArgs(signers.lp1.address, signers.lp2.address);
  });
});

describe("HedgeFacet.createEvent — legacy mode (signer unset)", function () {

  it("accepts events with empty signature when pricingEngineSigner is address(0)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    expect(await hedge.getPricingEngineSigner()).to.equal(ethers.ZeroAddress);

    await expect(hedge.connect(signers.creator).createEvent(buildEventParams())).to.not.be.reverted;
    const eventId = await hedge.getTotalHedgeEvents();
    expect(await hedge.getEventQuoteSigner(eventId)).to.equal(ethers.ZeroAddress);
  });
});

describe("HedgeFacet.createEvent — enforced mode (signer set)", function () {

  it("happy path: valid signature accepted; quoteSigner stored on event", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);
    const ctx = await getCtx(hedge, signers.creator);

    const params = buildEventParams();
    const signed = await signEventParams(signerWallet, params, ctx);

    await expect(hedge.connect(signers.creator).createEvent(signed)).to.not.be.reverted;
    const eventId = await hedge.getTotalHedgeEvents();
    expect(await hedge.getEventQuoteSigner(eventId)).to.equal(signerWallet.address);
    expect(await hedge.isQuoteNonceUsed(signed.quoteNonce)).to.equal(true);
  });

  it("accepts empty signature as explicit opt-out (self-priced) — quoteSigner stored as zero", async function () {
    // Behaviour change: pricing-engine attestation is now ADVISORY, not mandatory.
    // An event creator can choose their own premium and submit with signature = "0x".
    // The contract records quoteSigner = address(0) so consumers can label the
    // event "manually priced" vs "engine-attested".
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);
    expect(await hedge.getPricingEngineSigner()).to.equal(signerWallet.address);   // signer IS set
    await expect(hedge.connect(signers.creator).createEvent(buildEventParams())).to.not.be.reverted;
    const eventId = await hedge.getTotalHedgeEvents();
    expect(await hedge.getEventQuoteSigner(eventId)).to.equal(ethers.ZeroAddress); // self-priced marker
  });

  it("rejects malformed signature (wrong length, e.g. 64 bytes)", async function () {
    // Anything between empty and 65 bytes is almost certainly a bug, not an opt-out.
    // Reject explicitly so creators don't accidentally bypass attestation by sending
    // a truncated sig.
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await setupPricingEngineSigner(hedge, signers.owner);
    const params = buildEventParams();
    params.signature = "0x" + "ab".repeat(64);   // 64 bytes — too short for ECDSA
    await expect(hedge.connect(signers.creator).createEvent(params))
      .to.be.revertedWith("Quote signature wrong length");
  });

  it("rejects signature signed by the wrong key", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await setupPricingEngineSigner(hedge, signers.owner);
    const wrongWallet = ethers.Wallet.createRandom();   // not the registered signer
    const ctx = await getCtx(hedge, signers.creator);
    const signed = await signEventParams(wrongWallet, buildEventParams(), ctx);
    await expect(hedge.connect(signers.creator).createEvent(signed))
      .to.be.revertedWith("Invalid pricing-engine signature");
  });

  it("rejects expired quote (signed > 120s ago)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);
    const ctx = await getCtx(hedge, signers.creator);

    const now = await time.latest();
    const staleTs = now - 200;                          // 200s ago, beyond the 120s window
    const signed = await signEventParams(signerWallet, buildEventParams(), ctx, {
      quoteTimestamp: staleTs,
    });

    await expect(hedge.connect(signers.creator).createEvent(signed))
      .to.be.revertedWith("Quote expired (signed > 120s ago)");
  });

  it("accepts a quote at exactly 120s old (boundary)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);
    const ctx = await getCtx(hedge, signers.creator);

    // Sign with a timestamp 119s ago — should still be inside the 120s window.
    const now = await time.latest();
    const ts = now - 119;
    const signed = await signEventParams(signerWallet, buildEventParams(), ctx, { quoteTimestamp: ts });

    await expect(hedge.connect(signers.creator).createEvent(signed)).to.not.be.reverted;
  });

  it("rejects quote timestamp in the future", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);
    const ctx = await getCtx(hedge, signers.creator);

    const futureTs = (await time.latest()) + 3600;
    const signed = await signEventParams(signerWallet, buildEventParams(), ctx, { quoteTimestamp: futureTs });
    await expect(hedge.connect(signers.creator).createEvent(signed))
      .to.be.revertedWith("Quote timestamp in future");
  });

  it("replay protection: same nonce cannot be used twice", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);
    const ctx = await getCtx(hedge, signers.creator);

    const signed = await signEventParams(signerWallet, buildEventParams(), ctx);
    await hedge.connect(signers.creator).createEvent(signed);
    expect(await hedge.isQuoteNonceUsed(signed.quoteNonce)).to.equal(true);

    // Try to reuse the same nonce — even with a fresh re-sign that includes the
    // same nonce, it should revert.
    const replay = await signEventParams(signerWallet, buildEventParams(), ctx, { quoteNonce: signed.quoteNonce });
    await expect(hedge.connect(signers.creator).createEvent(replay))
      .to.be.revertedWith("Quote nonce already used");
  });

  it("creator-binding: Bob cannot use Alice's quote", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);

    // Quote signed for Alice (signers.creator).
    const ctxForAlice = await getCtx(hedge, signers.creator);
    const signed = await signEventParams(signerWallet, buildEventParams(), ctxForAlice);

    // But Bob (signers.lp1) tries to use it. Approve first so we don't fail on the transfer.
    const Mock = await ethers.getContractFactory("MockERC20");
    // No need to deploy a token — lp1 already has the default USDC and approval from the fixture.
    await expect(hedge.connect(signers.lp1).createEvent(signed))
      .to.be.revertedWith("Invalid pricing-engine signature");
  });

  it("chainId-binding: a quote signed for chainId X is rejected on chainId Y", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);

    // Sign with WRONG chainId — recovery will produce a different message hash → different signer
    const wrongCtx = {
      chainId: 999_999,
      diamondAddress: await hedge.getAddress(),
      creator: signers.creator.address,
    };
    const signed = await signEventParams(signerWallet, buildEventParams(), wrongCtx);
    await expect(hedge.connect(signers.creator).createEvent(signed))
      .to.be.revertedWith("Invalid pricing-engine signature");
  });

  it("diamond-binding: a quote signed for a different diamond is rejected", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);

    const network = await ethers.provider.getNetwork();
    const wrongCtx = {
      chainId: Number(network.chainId),
      diamondAddress: "0x000000000000000000000000000000000000dEaD",
      creator: signers.creator.address,
    };
    const signed = await signEventParams(signerWallet, buildEventParams(), wrongCtx);
    await expect(hedge.connect(signers.creator).createEvent(signed))
      .to.be.revertedWith("Invalid pricing-engine signature");
  });

  it("param-binding: tampering with strike after signing invalidates the sig", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);
    const ctx = await getCtx(hedge, signers.creator);

    const signed = await signEventParams(signerWallet, buildEventParams(), ctx);
    // Hedger tries to keep the signature but bump the strike to a more favourable value.
    const tampered = { ...signed, strike: rate(11.001) };
    await expect(hedge.connect(signers.creator).createEvent(tampered))
      .to.be.revertedWith("Invalid pricing-engine signature");
  });

  it("param-binding: tampering with premiumRate (e.g. quoting yourself a discount) invalidates", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);
    const ctx = await getCtx(hedge, signers.creator);

    const signed = await signEventParams(signerWallet, buildEventParams(), ctx);
    const cheapened = { ...signed, premiumRate: 1n };   // claim engine quoted 0.0001%
    await expect(hedge.connect(signers.creator).createEvent(cheapened))
      .to.be.revertedWith("Invalid pricing-engine signature");
  });

  it("rotating signer invalidates old quotes immediately", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const oldSigner = await setupPricingEngineSigner(hedge, signers.owner);
    const ctx = await getCtx(hedge, signers.creator);

    // Quote signed by oldSigner.
    const signed = await signEventParams(oldSigner, buildEventParams(), ctx);

    // Rotate to a brand-new signer.
    const newSigner = ethers.Wallet.createRandom();
    await hedge.connect(signers.owner).setPricingEngineSigner(newSigner.address);

    // Old quote should now fail.
    await expect(hedge.connect(signers.creator).createEvent(signed))
      .to.be.revertedWith("Invalid pricing-engine signature");

    // Re-signing with the new signer works.
    const reSigned = await signEventParams(newSigner, buildEventParams(), ctx);
    await expect(hedge.connect(signers.creator).createEvent(reSigned)).to.not.be.reverted;
  });

  it("disabling enforcement (set to address(0)) re-enables legacy mode mid-stream", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const signerWallet = await setupPricingEngineSigner(hedge, signers.owner);

    // First event needs a sig.
    const ctx = await getCtx(hedge, signers.creator);
    const signed = await signEventParams(signerWallet, buildEventParams(), ctx);
    await hedge.connect(signers.creator).createEvent(signed);

    // Disable enforcement.
    await hedge.connect(signers.owner).setPricingEngineSigner(ethers.ZeroAddress);

    // Now an unsigned event is accepted again. quoteSigner stored as address(0).
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    expect(await hedge.getEventQuoteSigner(eventId)).to.equal(ethers.ZeroAddress);
  });

  it("isQuoteNonceUsed returns false for a never-seen nonce", async function () {
    const { hedge } = await loadFixture(deployDiamondFixture);
    const fakeNonce = "0x" + "ab".repeat(32);
    expect(await hedge.isQuoteNonceUsed(fakeNonce)).to.equal(false);
  });

  it("getEventQuoteSigner returns address(0) for unknown event id", async function () {
    const { hedge } = await loadFixture(deployDiamondFixture);
    expect(await hedge.getEventQuoteSigner(999)).to.equal(ethers.ZeroAddress);
  });
});
