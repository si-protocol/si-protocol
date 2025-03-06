import { BigNumber, Wallet } from "ethers";
import { ethers, waffle } from "hardhat";
import { TestERC20 } from "../typechain-types/contracts/utils/TestERC20";
import { Swap } from "../typechain-types/contracts/Swap";
import { expect } from "chai";
import { swapFixture } from "./shared/fixtures"

const createFixtureLoader = waffle.createFixtureLoader;

describe("Swap", async () => {
    let wallet: Wallet, userA: Wallet, userB: Wallet;

    let fromToken: TestERC20;
    let toToken: TestERC20;
    let swap: Swap;

    let initRatio = ethers.utils.parseEther("0.8")

    let loadFixTure: ReturnType<typeof createFixtureLoader>;
    

    before("Create fixture loader", async () => {
        [wallet, userA, userB] = await (ethers as any).getSigners();
        loadFixTure = createFixtureLoader([wallet]);
    });

    beforeEach("Deploy instance", async () => {
        ({ fromToken, toToken, swap } = await loadFixTure(swapFixture));

        // Distribute the fromToken to user
        await fromToken.transfer(userA.address, ethers.constants.WeiPerEther.mul(1000));
        await fromToken.transfer(userB.address, ethers.constants.WeiPerEther.mul(1000));

        // Set the fromToken allowance
        await fromToken.connect(userA).approve(swap.address, ethers.constants.WeiPerEther.mul(1000));
        await fromToken.connect(userB).approve(swap.address, ethers.constants.WeiPerEther.mul(1000));

        // Deposit the toToken into Swap contract
        await toToken.transfer(swap.address, ethers.constants.WeiPerEther.mul(5000));
    });

    it("Check initial state", async () => {
        // Check the raito
        expect(await swap.ratio()).to.eq(initRatio)

        // Check account balance
        expect(await fromToken.balanceOf(userA.address)).to.eq(ethers.constants.WeiPerEther.mul(1000))
        expect(await fromToken.balanceOf(swap.address)).to.eq(0)
        expect(await toToken.balanceOf(swap.address)).to.eq(ethers.constants.WeiPerEther.mul(5000))
    });

    describe("function_swap", async () => {
        it('UserA swap 100 fromToken', async () => {
            await swap.connect(userA).swap(userA.address, ethers.constants.WeiPerEther.mul(100))

            // Check the userA state
            expect(await fromToken.balanceOf(userA.address)).to.eq(ethers.constants.WeiPerEther.mul(900))
            expect(await toToken.balanceOf(userA.address)).to.eq(ethers.constants.WeiPerEther.mul(80))

            // Check the contract state
            expect(await fromToken.balanceOf(swap.address)).to.eq(ethers.constants.WeiPerEther.mul(100))
            expect(await toToken.balanceOf(swap.address)).to.eq(ethers.constants.WeiPerEther.mul(4920))
        })
    })
});
