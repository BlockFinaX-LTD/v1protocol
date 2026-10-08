// This configuration never reads the production deployer key.
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: process.env.SANDBOX_ENV_FILE || ".env.sandbox.local" });
module.exports = {
  solidity: { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } },
  networks: {
    hardhat: { chainId: 84532 },
    baseSepolia: {
      url: process.env.SANDBOX_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.SANDBOX_DEPLOYER_PRIVATE_KEY ? [process.env.SANDBOX_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: { sources: "./src", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
};
