require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true
    }
  },
  networks: {
    lisk: {
      url: "https://rpc.api.lisk.com",
      chainId: 1135,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    }
  },
  etherscan: {
    apiKey: {
      lisk: "placeholder"
    },
    customChains: [
      {
        network: "lisk",
        chainId: 1135,
        urls: {
          apiURL:     "https://blockscout.lisk.com/api",
          browserURL: "https://blockscout.lisk.com"
        }
      }
    ]
  },
  sourcify: { enabled: false },
  paths: {
    sources: "./src",
    tests:   "./test",
    cache:   "./cache-lisk",
    artifacts: "./artifacts"
  }
};
