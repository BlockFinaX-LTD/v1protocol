# BlockFinaX v1 protocol

Smart contracts for BlockFinaX, a market for hedging foreign exchange risk in emerging markets. The on chain core is an [EIP-2535](https://eips.ethereum.org/EIPS/eip-2535) Diamond with hedge, pricing, and oracle facets.

The app that consumes these contracts (frontend + backend + pricing engine) lives in a separate repo: [BlockFinaX-LTD/BlockFinaXcode](https://github.com/BlockFinaX-LTD/BlockFinaXcode).

## Layout

```
src/                 Solidity sources
  Diamond.sol        EIP-2535 Diamond router
  facets/            HedgeFacet, OracleFacet, AccessControlFacet, ...
  interfaces/        external interfaces
  libraries/         storage layouts, math, helpers
  mocks/             test-only mocks (ERC20, oracle stubs)
  test/              Solidity-side tests
test/                JavaScript / TypeScript tests (Hardhat)
scripts/             deploy + upgrade + admin scripts
deployments/         deployed addresses by network
hardhat.config.js    main Hardhat config (Base, BSC, Polygon, etc.)
hardhat.lisk.config.js  Lisk-specific config
```

## Networks

Active deployments live in `deployments/`. The Diamond is deployed on:

- Base mainnet
- BNB Smart Chain mainnet
- Lisk mainnet (separate Hardhat config)
- Base Sepolia, BSC testnet, Lisk Sepolia (test)

## Getting started

```bash
npm install
cp .env.example .env   # fill in DEPLOYER_PRIVATE_KEY, RPC URLs, etc.
npm run compile
npm test
```

## Common scripts

```bash
npm run compile                 # hardhat compile
npm test                        # hardhat test

# deploy a fresh Diamond
npm run deploy:testnet          # Lisk Sepolia
npm run deploy:mainnet          # Lisk mainnet

# upgrade the hedge facet (v8) on each chain
npm run upgrade:hedge           # Lisk Sepolia
npm run upgrade:hedge:lisk      # Lisk mainnet
npm run upgrade:hedge:base      # Base mainnet
npm run upgrade:hedge:bsc       # BSC mainnet

# set the off-chain pricing engine signer
npm run set-pricing-signer
```

## How the app integrates

The off chain side reads the Diamond via plain `ethers.Contract` calls with hand maintained ABI fragments. There is no shared package; if you change a facet's external interface, the corresponding ABI fragment in the [app repo](https://github.com/BlockFinaX-LTD/BlockFinaXcode) (under `server/`) needs to be updated to match.

## License

MIT
