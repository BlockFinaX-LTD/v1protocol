/**
 * check-ownership-direct.js — read the contractOwner field from each Diamond's
 * storage slot directly (since OwnershipFacet isn't cut into the production
 * Diamonds, owner() reverts).
 *
 * DiamondStorage layout (from libraries/LibDiamond.sol):
 *   bytes32 constant DIAMOND_STORAGE_POSITION = keccak256("diamond.standard.diamond.storage");
 *   struct DiamondStorage {
 *     mapping(bytes4 => address) selectorToFacetAndPosition;   // slot 0
 *     mapping(address => bytes4[]) facetFunctionSelectors;     // slot 1
 *     address[] facetAddresses;                                 // slot 2
 *     mapping(bytes4 => bool) supportedInterfaces;              // slot 3
 *     address contractOwner;                                    // slot 4
 *     address pendingOwner;                                     // slot 5
 *   }
 *
 * Slot of contractOwner = keccak256("diamond.standard.diamond.storage") + 4
 *
 * Usage:  node scripts/check-ownership-direct.js
 */

const { ethers } = require("ethers");
require("dotenv").config({ path: __dirname + "/../../.env" });

const DIAMOND_STORAGE_POSITION = ethers.keccak256(
  ethers.toUtf8Bytes("diamond.standard.diamond.storage")
);
// slot for contractOwner = position + 4
const CONTRACT_OWNER_SLOT = "0x" + (BigInt(DIAMOND_STORAGE_POSITION) + 4n).toString(16).padStart(64, "0");
const PENDING_OWNER_SLOT  = "0x" + (BigInt(DIAMOND_STORAGE_POSITION) + 5n).toString(16).padStart(64, "0");

const CHAINS = [
  { label: "Lisk", diamond: process.env.DIAMOND_ADDRESS,      rpc: process.env.LISK_RPC_URL || "https://rpc.api.lisk.com" },
  { label: "Base", diamond: process.env.BASE_DIAMOND_ADDRESS, rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org" },
  { label: "BSC",  diamond: process.env.BSC_DIAMOND_ADDRESS,  rpc: process.env.BSC_RPC_URL  || "https://bsc-dataseed.binance.org" },
];

const DEPLOYER_ADDR = "0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d";  // from earlier deployment files
const KNOWN = {
  lisk: { safe: "0xfce89FA90Ee1C78B15eE0f12f62B03153814699D", deployer: DEPLOYER_ADDR },
  base: { safe: "0x7909a2f1fAd63678eEDcC5A75462B66D062189Bb", deployer: DEPLOYER_ADDR },
  bsc:  { safe: "0x2a0ab363E01b518B189218e39f79Bfc3AE310807", deployer: DEPLOYER_ADDR },
};

(async () => {
  console.log("\nDiamond ownership check\n");
  console.log("contractOwner slot:", CONTRACT_OWNER_SLOT);
  console.log("");

  for (const c of CHAINS) {
    if (!c.diamond) {
      console.log(`${c.label}: SKIP (no DIAMOND_ADDRESS env)`);
      continue;
    }
    try {
      const provider = new ethers.JsonRpcProvider(c.rpc);
      const ownerSlotHex = await provider.getStorage(c.diamond, CONTRACT_OWNER_SLOT);
      const pendingSlotHex = await provider.getStorage(c.diamond, PENDING_OWNER_SLOT);
      // address is the lower 20 bytes of the 32-byte slot
      const owner = ethers.getAddress("0x" + ownerSlotHex.slice(-40));
      const pending = ethers.getAddress("0x" + pendingSlotHex.slice(-40));
      const known = KNOWN[c.label.toLowerCase()] || {};

      let ownerLabel = "(unknown address)";
      if (owner.toLowerCase() === known.safe?.toLowerCase()) ownerLabel = "= SAFE — multisig required";
      else if (owner.toLowerCase() === known.deployer?.toLowerCase()) ownerLabel = "= DEPLOYER — direct cut OK";

      console.log(`${c.label.padEnd(6)} diamond=${c.diamond}`);
      console.log(`        owner   = ${owner}  ${ownerLabel}`);
      console.log(`        pending = ${pending}`);
      console.log("");
    } catch (e) {
      console.log(`${c.label}: ERR ${e.message?.slice(0, 100)}`);
    }
  }
})();
