import { Wallet, BigNumber } from 'ethers'
import { ethers, upgrades } from 'hardhat'
import { Fixture } from 'ethereum-waffle'
import { TestERC20 } from '../../typechain-types/contracts/utils/TestERC20'
import { Swap } from '../../typechain-types/contracts/Swap'
import { StakingPool } from '../../typechain-types/contracts/StakingPool'
import { VeToken } from '../../typechain-types/contracts/VeToken'
import { VeTokenDistributor } from '../../typechain-types/contracts/VeTokenDistributor'

export const bigNumber18 = BigNumber.from("1000000000000000000")  // 1e18
export const bigNumber17 = BigNumber.from("100000000000000000")  //1e17
export const bigNumber8 = BigNumber.from("100000000")  //1e8

async function testERC20(): Promise<TestERC20> {
    let factory = await ethers.getContractFactory('TestERC20')
    let token = (await factory.deploy("TestERC20", "TToken")) as TestERC20
    return token
}

interface SwapFixture {
    fromToken: TestERC20
    toToken: TestERC20
    swap: Swap
}

export const swapFixture: Fixture<SwapFixture> = async function ([wallet]: Wallet[]): Promise<SwapFixture> {
    let fromToken = await testERC20();
    let toToken = await testERC20();

    const ratio = ethers.utils.parseEther("0.8")
    let swapFactory = await ethers.getContractFactory('Swap')
    let swap = (await swapFactory.deploy(
        wallet.address,
        wallet.address,
        fromToken.address,
        toToken.address,
        ratio
    )) as Swap

    return { fromToken, toToken, swap };
}

interface StakingPoolFixture {
    token: TestERC20
    stakingPool: StakingPool
}

export const stakingPoolFixture: Fixture<StakingPoolFixture> = async function ([wallet]: Wallet[]): Promise<StakingPoolFixture> {
    let token = await testERC20();

    let stakingPoolFactory = await ethers.getContractFactory('StakingPool')
    let stakingPool = (await upgrades.deployProxy(stakingPoolFactory, [wallet.address, token.address, wallet.address, 0])) as StakingPool
    return { token, stakingPool };
}

interface VeTokenFixture {
    token: TestERC20
    veToken: VeToken
}

export const veTokenFixture: Fixture<VeTokenFixture> = async function ([wallet]: Wallet[]): Promise<VeTokenFixture> {
    let token = await testERC20();

    const startTime = BigNumber.from(Date.now()).div(1000)
    let veTokenFactory = await ethers.getContractFactory('VeToken')
    let veToken = (await upgrades.deployProxy(veTokenFactory, [wallet.address, startTime, token.address, wallet.address])) as VeToken
    return { token, veToken };
}

interface VeTokenDistributorFixture {
    token: TestERC20
    veToken: VeToken
    rewardToken: TestERC20
    veTokenDistributor: VeTokenDistributor
}

export const veTokenDistributorFixture: Fixture<VeTokenDistributorFixture> = async function ([wallet, vault]: Wallet[]): Promise<VeTokenDistributorFixture> {
    let token = await testERC20();
    let rewardToken = await testERC20();

    const startTime = BigNumber.from(Date.now()).div(1000)
    let veTokenFactory = await ethers.getContractFactory('VeToken')
    let veToken = (await upgrades.deployProxy(veTokenFactory, [wallet.address, startTime, token.address, wallet.address])) as VeToken

    let veTokenDistributorFactory = await ethers.getContractFactory('VeTokenDistributor')
    let veTokenDistributor = (await upgrades.deployProxy(veTokenDistributorFactory, [wallet.address, vault.address, rewardToken.address, veToken.address])) as VeTokenDistributor
    return { token, veToken, rewardToken, veTokenDistributor };
}