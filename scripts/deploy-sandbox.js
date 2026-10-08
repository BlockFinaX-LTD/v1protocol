const hre = require("hardhat");
const fs = require("node:fs");

async function deploySandbox() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (![84532, 31337].includes(chainId)) throw new Error("Sandbox deployment requires Base Sepolia or local Hardhat");
  const [owner] = await ethers.getSigners();
  if (!owner) throw new Error("Set SANDBOX_DEPLOYER_PRIVATE_KEY in .env.sandbox.local");
  const file = `deployments/sandbox-${hre.network.name}-${chainId}.json`;
  if (hre.network.name !== "hardhat" && chainId !== 31337 && fs.existsSync(file)) throw new Error(`Existing deployment at ${file}; refusing to overwrite it`);
  const deploy = async (name, args = []) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    console.log(`${name}: ${await c.getAddress()}`);
    return c;
  };
  const token = await deploy("SandboxUSD");
  const cut = await deploy("BlockFinaXDiamondCutFacet");
  const diamond = await deploy("BlockFinaXDiamond", [owner.address, await cut.getAddress(), await token.getAddress()]);
  const address = await diamond.getAddress();
  const names = ["BlockFinaXDiamondLoupeFacet", "BlockFinaXHedgeFacet", "BlockFinaXOracleFacet", "BlockFinaXOwnershipFacet"];
  const facets = {};
  const cuts = [];
  const used = new Set([cut.interface.getFunction("diamondCut").selector]);
  for (const name of names) {
    const c = await deploy(name);
    facets[name] = await c.getAddress();
    cuts.push({ facetAddress: await c.getAddress(), action: 0, functionSelectors: c.interface.fragments.filter(f => f.type === "function").map(f => c.interface.getFunction(f.format("sighash")).selector).filter(selector => { if (used.has(selector)) return false; used.add(selector); return true; }) });
  }
  await (await (await ethers.getContractAt("BlockFinaXDiamondCutFacet", address)).diamondCut(cuts, ethers.ZeroAddress, "0x")).wait();
  const hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", address);
  // Same fee percentages as production. Creation costs 25 valueless test dollars.
  await (await hedge.initializeHedgeFees(25_000_000, 5_000, 10_000, 10_000, 50_000)).wait();
  const oracle = process.env.SANDBOX_ORACLE_ADDRESS || owner.address;
  await (await hedge.setOracleAdmin(oracle)).wait();
  if (process.env.SANDBOX_PRICING_SIGNER_ADDRESS) await (await hedge.setPricingEngineSigner(process.env.SANDBOX_PRICING_SIGNER_ADDRESS)).wait();
  await (await token.claim()).wait();
  const manifest = { environment: "sandbox", chainId, diamond: address, token: await token.getAddress(), decimals: 6, owner: owner.address, oracle, pricingSigner: process.env.SANDBOX_PRICING_SIGNER_ADDRESS || ethers.ZeroAddress, facets, deployedAt: new Date().toISOString() };
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, token, hedge, diamond };
}

module.exports = { deploySandbox };
if (require.main === module) deploySandbox().catch(e => { console.error(e); process.exitCode = 1; });
