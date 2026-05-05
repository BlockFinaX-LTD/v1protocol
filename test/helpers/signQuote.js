/**
 * signQuote.js — test-side helper that signs a quote payload identically to
 * server/pricing/signer.ts so the on-chain ECDSA verification accepts it.
 *
 * Usage:
 *   const { signEventParams } = require("../helpers/signQuote");
 *   const signedParams = await signEventParams(signerWallet, params, {
 *     chainId, diamondAddress, creator,
 *   });
 *   await hedge.connect(creator).createEvent(signedParams);
 */

const { ethers } = require("hardhat");
const crypto = require("node:crypto");

/**
 * Sign a CreateEventParams object with the given wallet, returning a new params
 * object with the signature/timestamp/nonce filled in.
 *
 * @param {ethers.Wallet}   signerWallet  Wallet with the private key matching the
 *                                        Diamond's pricingEngineSigner.
 * @param {object}          params        CreateEventParams (from buildEventParams).
 * @param {object}          ctx           Binding context: { chainId, diamondAddress, creator }
 * @param {object}          [overrides]   Optional override for { quoteTimestamp, quoteNonce }
 *                                        — used by tests that want to forge a stale or
 *                                        replayed quote.
 * @returns {Promise<object>} params with signature, quoteTimestamp, quoteNonce populated.
 */
async function signEventParams(signerWallet, params, ctx, overrides = {}) {
  const quoteTimestamp = overrides.quoteTimestamp !== undefined
    ? BigInt(overrides.quoteTimestamp)
    : BigInt(Math.floor(Date.now() / 1000));
  const quoteNonce = overrides.quoteNonce ?? ("0x" + crypto.randomBytes(32).toString("hex"));

  // Mirror exactly what HedgeFacet._verifyQuoteSignature recovers against:
  //   keccak256(abi.encode(
  //     block.chainid, address(this), msg.sender,
  //     underlying, strike, payoutCap, premiumRate, expiryDate, initialRate, strikeAbove,
  //     quoteTimestamp, quoteNonce
  //   ))
  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "uint256", "address", "address",
        "string",
        "uint256", "uint256", "uint256", "uint256", "uint256", "bool",
        "uint256", "bytes32",
      ],
      [
        BigInt(ctx.chainId), ethers.getAddress(ctx.diamondAddress), ethers.getAddress(ctx.creator),
        params.underlying,
        BigInt(params.strike), BigInt(params.payoutCap),
        BigInt(params.premiumRate), BigInt(params.expiryDate),
        BigInt(params.initialRate), Boolean(params.strikeAbove),
        quoteTimestamp, quoteNonce,
      ],
    ),
  );

  // signMessage prefixes with "\x19Ethereum Signed Message:\n32" — matches
  // OpenZeppelin's MessageHashUtils.toEthSignedMessageHash on-chain.
  const signature = await signerWallet.signMessage(ethers.getBytes(messageHash));

  return {
    ...params,
    signature,
    quoteTimestamp,
    quoteNonce,
  };
}

module.exports = { signEventParams };
