import { BigNumber, Wallet } from "ethers";
import { ethers, waffle } from "hardhat";
import { TestERC20 } from "../typechain-types/contracts/utils/TestERC20";
import { StakingPool } from "../typechain-types/contracts/StakingPool";
import { expect } from "chai";
import { stakingPoolFixture } from "./shared/fixtures"

const createFixtureLoader = waffle.createFixtureLoader;

describe("StakingPool", async () => {
    let wallet: Wallet, userA: Wallet, userB: Wallet;
    let token: TestERC20;
    let stakingPool: StakingPool;
    let loadFixture: ReturnType<typeof createFixtureLoader>;

    const WEEK_1 = BigNumber.from(7 * 24 * 3600); // 1 week in seconds
    const WEEK_4 = BigNumber.from(28 * 24 * 3600); // 4 weeks in seconds

    before("Create fixture loader", async () => {
        [wallet, userA, userB] = await (ethers as any).getSigners();
        loadFixture = createFixtureLoader([wallet]);
    });

    beforeEach("Deploy contracts", async () => {
        ({ token, stakingPool } = await loadFixture(stakingPoolFixture));

        // Distribute tokens to users
        await token.transfer(userA.address, ethers.constants.WeiPerEther.mul(2000));
        await token.transfer(userB.address, ethers.constants.WeiPerEther.mul(2000));

        // Approve spending
        await token.connect(userA).approve(stakingPool.address, ethers.constants.MaxUint256);
        await token.connect(userB).approve(stakingPool.address, ethers.constants.MaxUint256);
        await token.approve(stakingPool.address, ethers.constants.MaxUint256);
    });

    describe("Staking", () => {
        it("Should stake tokens correctly", async () => {
            const stakeAmount = ethers.constants.WeiPerEther.mul(100);
            await expect(stakingPool.connect(userA).stake(stakeAmount))
                .to.emit(stakingPool, "Staked")
                .withArgs(userA.address, stakeAmount, stakeAmount);

            expect(await stakingPool.totalStaked()).to.eq(stakeAmount);
            expect(await stakingPool.totalShares()).to.eq(stakeAmount);
            expect(await stakingPool.totalSharesOf(userA.address)).to.eq(stakeAmount);
        });

        it("Should fail stake with zero amount", async () => {
            await expect(
                stakingPool.connect(userA).stake(0)
            ).to.be.revertedWith("ZeroAmount");
        });

        it("Should calculate shares correctly for multiple stakes", async () => {
            // First stake
            await stakingPool.connect(userA).stake(ethers.constants.WeiPerEther.mul(100));

            // Simulate rewards
            await stakingPool.setRewardPerBlock(ethers.constants.WeiPerEther);
            await ethers.provider.send("evm_mine", []);

            // Second stake should get fewer shares for same amount
            const secondStakeAmount = ethers.constants.WeiPerEther.mul(100);
            const tx = await stakingPool.connect(userB).stake(secondStakeAmount);
            const receipt = await tx.wait();

            const stakedEvent = receipt.events?.find(e => e.event === "Staked");
            const sharesReceived = stakedEvent?.args?.shares;

            expect(sharesReceived).to.be.lt(secondStakeAmount);
        });
    })

    describe("Unstaking", () => {
        const stakeAmount = ethers.constants.WeiPerEther.mul(100);

        beforeEach(async () => {
            // Setup staking environment
            await stakingPool.connect(userA).stake(stakeAmount);
        });

        describe("Request Unstake", () => {
            it("Should create unstake request with 1 week lock", async () => {
                const shares = stakeAmount.div(2); // Withdraw half of shares

                const tx = await stakingPool.connect(userA).requestUnstake(shares, WEEK_1);
                const block = await ethers.provider.getBlock(tx.blockNumber!);
                const unlockTime = BigNumber.from(block.timestamp).add(WEEK_1);

                await expect(tx)
                    .to.emit(stakingPool, "UnstakeRequested")
                    .withArgs(userA.address, shares, unlockTime);

                // Verify state updates
                expect(await stakingPool.lockedShares(userA.address)).to.eq(shares);
                expect(await stakingPool.balanceOf(userA.address)).to.eq(shares); // Available shares halved

                // Verify request record
                const request = await stakingPool.unstakeRequests(userA.address, 0);
                expect(request.shares).to.eq(shares);
                expect(request.unlockTime).to.eq(unlockTime);
                expect(request.ratio).to.eq(95); // 1 week unlock ratio 95%
                expect(request.processed).to.be.false;
            });

            it("Should create unstake request with 4 weeks lock", async () => {
                const shares = stakeAmount;

                const tx = await stakingPool.connect(userA).requestUnstake(shares, WEEK_4);
                const block = await ethers.provider.getBlock(tx.blockNumber!);
                const unlockTime = BigNumber.from(block.timestamp).add(WEEK_4);

                // Verify 4-week lock request
                const request = await stakingPool.unstakeRequests(userA.address, 0);
                expect(request.ratio).to.eq(100); // 4-week unlock ratio 100%
                expect(request.unlockTime).to.eq(unlockTime);
            });

            it("Should allow multiple unstake requests", async () => {
                // Create two unstake requests with different durations
                await stakingPool.connect(userA).requestUnstake(stakeAmount.div(4), WEEK_1);
                await stakingPool.connect(userA).requestUnstake(stakeAmount.div(4), WEEK_4);

                expect(await stakingPool.lockedShares(userA.address))
                    .to.eq(stakeAmount.div(2)); // Total locked shares
                expect(await stakingPool.balanceOf(userA.address))
                    .to.eq(stakeAmount.div(2)); // Remaining available shares
            });

            it("Should fail with invalid duration", async () => {
                await expect(
                    stakingPool.connect(userA).requestUnstake(stakeAmount, WEEK_1.add(1))
                ).to.be.revertedWith("InvalidDuration");
            });

            it("Should fail with zero amount", async () => {
                await expect(
                    stakingPool.connect(userA).requestUnstake(0, WEEK_1)
                ).to.be.revertedWith("ZeroAmount");
            });

            it("Should fail with insufficient balance", async () => {
                await expect(
                    stakingPool.connect(userA).requestUnstake(stakeAmount.mul(2), WEEK_1)
                ).to.be.revertedWith("InsufficientBalance");
            });
        });

        describe("Batch Unstake", () => {
            it("Should process single matured request correctly", async () => {
                // Create unstake request
                await stakingPool.connect(userA).requestUnstake(stakeAmount, WEEK_1);

                // Wait for unlock time
                await ethers.provider.send("evm_increaseTime", [WEEK_1.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                // Process batch unstake requests
                const beforeBalance = await token.balanceOf(userA.address);
                const tx = await stakingPool.connect(userA).batchUnstake();

                // Calculate expected return amount (95% unlock ratio)
                const expectedAmount = stakeAmount.mul(95).div(100);

                await expect(tx)
                    .to.emit(stakingPool, "Unstaked")
                    .withArgs(userA.address, expectedAmount);

                // Verify state updates
                const afterBalance = await token.balanceOf(userA.address);
                expect(afterBalance.sub(beforeBalance)).to.eq(expectedAmount);
                expect(await stakingPool.totalStaked()).to.eq(stakeAmount.sub(expectedAmount));
                expect(await stakingPool.totalShares()).to.eq(0);
                expect(await stakingPool.lockedShares(userA.address)).to.eq(0);

                // Verify request state
                const request = await stakingPool.unstakeRequests(userA.address, 0);
                expect(request.processed).to.be.true;
            });

            it("Should process multiple matured requests in single transaction", async () => {
                // Create multiple unstake requests
                await stakingPool.connect(userA).requestUnstake(stakeAmount.div(2), WEEK_1);
                await stakingPool.connect(userA).requestUnstake(stakeAmount.div(2), WEEK_4);

                // Wait for the longest unlock time
                await ethers.provider.send("evm_increaseTime", [WEEK_4.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                // Process all requests in batch
                const beforeBalance = await token.balanceOf(userA.address);
                await stakingPool.connect(userA).batchUnstake();
                const afterBalance = await token.balanceOf(userA.address);

                // Calculate expected total return (95% for first request, 100% for second)
                const expectedAmount = stakeAmount.div(2).mul(95).div(100)
                    .add(stakeAmount.div(2));

                expect(afterBalance.sub(beforeBalance)).to.eq(expectedAmount);
                expect(await stakingPool.totalShares()).to.eq(0);
            });

            it("Should skip unmatured requests", async () => {
                // Create two unstake requests with different durations
                await stakingPool.connect(userA).requestUnstake(stakeAmount.div(2), WEEK_1);
                await stakingPool.connect(userA).requestUnstake(stakeAmount.div(2), WEEK_4);

                // Wait only 1 week
                await ethers.provider.send("evm_increaseTime", [WEEK_1.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                // Execute batch unstake
                const beforeBalance = await token.balanceOf(userA.address);
                await stakingPool.connect(userA).batchUnstake();
                const afterBalance = await token.balanceOf(userA.address);

                // Only the first request should be processed
                const expectedAmount = stakeAmount.div(2).mul(95).div(100);
                expect(afterBalance.sub(beforeBalance)).to.eq(expectedAmount);

                // Verify remaining state
                expect(await stakingPool.totalShares()).to.eq(stakeAmount.div(2));
                expect(await stakingPool.lockedShares(userA.address)).to.eq(stakeAmount.div(2));
            });
        });

        describe("Get Redeemable Shares", () => {
            it("Should return correct redeemable shares", async () => {
                // Create multiple unstake requests
                await stakingPool.connect(userA).requestUnstake(stakeAmount.div(4), WEEK_1);
                await stakingPool.connect(userA).requestUnstake(stakeAmount.div(2), WEEK_4);

                // Initial should have no redeemable shares
                expect(await stakingPool.getRedeemableShares(userA.address)).to.eq(0);

                // Wait 1 week
                await ethers.provider.send("evm_increaseTime", [WEEK_1.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                // Should only have first request redeemable
                expect(await stakingPool.getRedeemableShares(userA.address))
                    .to.eq(stakeAmount.div(4));

                // Wait 4 weeks
                await ethers.provider.send("evm_increaseTime", [WEEK_4.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                // All requests should be redeemable
                expect(await stakingPool.getRedeemableShares(userA.address))
                    .to.eq(stakeAmount.mul(3).div(4));
            });

            it("Should exclude processed requests", async () => {
                await stakingPool.connect(userA).requestUnstake(stakeAmount, WEEK_1);

                await ethers.provider.send("evm_increaseTime", [WEEK_1.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                // Process unstake request before
                expect(await stakingPool.getRedeemableShares(userA.address))
                    .to.eq(stakeAmount);

                // Process unstake request
                await stakingPool.connect(userA).batchUnstake();

                // Processed should have no redeemable shares
                expect(await stakingPool.getRedeemableShares(userA.address))
                    .to.eq(0);
            });
        });
    });

    describe("Rewards", () => {
        const stakeAmount = ethers.constants.WeiPerEther.mul(1000);
        const rewardPerBlock = ethers.constants.WeiPerEther; // 1 token per block

        beforeEach(async () => {
            // Reset reward rate
            await stakingPool.setRewardPerBlock(rewardPerBlock);
        });

        describe("Checkpoint Mechanism", () => {
            it("Should not distribute rewards on first checkpoint", async () => {
                const vaultBalance = await token.balanceOf(wallet.address);

                // First stake triggers checkpoint
                await stakingPool.connect(userA).stake(stakeAmount);

                // First checkpoint should not generate rewards
                expect(await token.balanceOf(wallet.address)).to.eq(vaultBalance);
                expect(await stakingPool.totalStaked()).to.eq(stakeAmount);
            });

            it("Should calculate and transfer rewards correctly", async () => {
                // Initial stake
                await stakingPool.connect(userA).stake(stakeAmount);
                const initialTotalStaked = await stakingPool.totalStaked();

                // Record start block number
                const startBlock = await ethers.provider.getBlockNumber();

                // Mine 10 blocks
                const blocksToMine = 10;
                for (let i = 0; i < blocksToMine; i++) {
                    await ethers.provider.send("evm_mine", []);
                }

                // Record userB stake block number
                const preStakeBlock = await ethers.provider.getBlockNumber();

                // Trigger new checkpoint
                const vaultBalanceBefore = await token.balanceOf(wallet.address);
                await stakingPool.connect(userB).stake(stakeAmount);
                const postStakeBlock = await ethers.provider.getBlockNumber();
                const vaultBalanceAfter = await token.balanceOf(wallet.address);

                // Calculate actual mined blocks
                const actualBlocks = postStakeBlock - startBlock;

                // Verify reward transfer
                const expectedReward = rewardPerBlock.mul(actualBlocks);
                expect(vaultBalanceBefore.sub(vaultBalanceAfter)).to.eq(expectedReward);

                // Verify totalStaked increase
                expect(await stakingPool.totalStaked())
                    .to.eq(initialTotalStaked.add(expectedReward).add(stakeAmount));

                // Verify block change
                expect(postStakeBlock).to.eq(preStakeBlock + 1);
                expect(actualBlocks).to.eq(blocksToMine + 1);
            });
        });

        describe("Reward Distribution", () => {
            it("Should distribute rewards proportionally to shares", async () => {
                // userA first stake
                await stakingPool.connect(userA).stake(stakeAmount);
                const userAInitialShares = await stakingPool.totalSharesOf(userA.address);
                const startBlock = await ethers.provider.getBlockNumber();

                // Wait 5 blocks
                const blocks1 = 5;
                for (let i = 0; i < blocks1; i++) {
                    await ethers.provider.send("evm_mine", []);
                }

                // userB stake same amount
                const preUserBStakeBlock = await ethers.provider.getBlockNumber();
                await stakingPool.connect(userB).stake(stakeAmount);
                const postUserBStakeBlock = await ethers.provider.getBlockNumber();
                const userBInitialShares = await stakingPool.totalSharesOf(userB.address);

                // Verify first stage blocks
                const phase1Blocks = postUserBStakeBlock - startBlock;
                expect(phase1Blocks).to.eq(blocks1 + 1); // +1 is userB's stake transaction

                // userB should get fewer shares (because totalStaked has increased with rewards)
                expect(userBInitialShares).to.be.lt(userAInitialShares);

                // Wait 5 more blocks
                const blocks2 = 5;
                for (let i = 0; i < blocks2; i++) {
                    await ethers.provider.send("evm_mine", []);
                }

                // Trigger checkpoint and record blocks
                const preCheckpointBlock = await ethers.provider.getBlockNumber();
                await stakingPool.connect(userA).requestUnstake(userAInitialShares, WEEK_4);
                await stakingPool.connect(userB).requestUnstake(userBInitialShares, WEEK_4);
                const postCheckpointBlock = await ethers.provider.getBlockNumber();

                // Verify second stage blocks
                const phase2Blocks = postCheckpointBlock - postUserBStakeBlock;
                expect(phase2Blocks).to.eq(blocks2 + 2); // +2 is two requestUnstake transactions

                await ethers.provider.send("evm_increaseTime", [WEEK_4.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                const userARedeemed = await stakingPool.connect(userA).callStatic.batchUnstake();
                const userBRedeemed = await stakingPool.connect(userB).callStatic.batchUnstake();

                // userA should get more total return (staked longer)
                expect(userARedeemed).to.be.gt(userBRedeemed);
            });

            it("Should handle rewards after partial unstake", async () => {
                // Initial stake
                await stakingPool.connect(userA).stake(stakeAmount);
                const initialShares = await stakingPool.totalSharesOf(userA.address);

                // Wait for block to generate rewards
                for (let i = 0; i < 5; i++) {
                    await ethers.provider.send("evm_mine", []);
                }

                // Withdraw half shares
                const halfShares = initialShares.div(2);
                await stakingPool.connect(userA).requestUnstake(halfShares, WEEK_1);

                await ethers.provider.send("evm_increaseTime", [WEEK_1.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                // First withdraw
                const preUnstakeBalance = await token.balanceOf(userA.address);
                const expectedFirstUnstake = await stakingPool.connect(userA).callStatic.batchUnstake();
                await stakingPool.connect(userA).batchUnstake();
                const postUnstakeBalance = await token.balanceOf(userA.address);

                // Calculate actual amount and expected difference for first withdraw
                const actualFirstUnstake = postUnstakeBalance.sub(preUnstakeBalance);
                const firstExtraReward = actualFirstUnstake.sub(expectedFirstUnstake);

                // Verify first withdraw difference (block reward * 50% * 95%)
                const rewardPerBlock = await stakingPool.rewardPerBlock();
                const expectedFirstExtraReward = rewardPerBlock
                    .div(2)  // Withdraw half shares
                    .mul(95).div(100);  // 95% unlock ratio
                expect(firstExtraReward).to.eq(expectedFirstExtraReward);

                // Wait for new rewards to generate
                for (let i = 0; i < 5; i++) {
                    await ethers.provider.send("evm_mine", []);
                }

                // Withdraw remaining shares
                const remainingShares = await stakingPool.totalSharesOf(userA.address);
                await stakingPool.connect(userA).requestUnstake(remainingShares, WEEK_1);

                await ethers.provider.send("evm_increaseTime", [WEEK_1.toNumber()]);
                await ethers.provider.send("evm_mine", []);

                // Second withdraw
                const preSecondUnstakeBalance = await token.balanceOf(userA.address);
                const expectedSecondUnstake = await stakingPool.connect(userA).callStatic.batchUnstake();
                await stakingPool.connect(userA).batchUnstake();
                const postSecondUnstakeBalance = await token.balanceOf(userA.address);

                // Calculate actual amount and expected difference for second withdraw
                const actualSecondUnstake = postSecondUnstakeBalance.sub(preSecondUnstakeBalance);
                const secondExtraReward = actualSecondUnstake.sub(expectedSecondUnstake);

                // Verify second withdraw difference (block reward * 100% * 95%)
                const expectedSecondExtraReward = rewardPerBlock
                    // No need to divide by 2, because now it's all remaining shares
                    .mul(95).div(100);  // 95% unlock ratio
                expect(secondExtraReward).to.eq(expectedSecondExtraReward);

                // Verify both withdraws include base reward
                const baseAmount = stakeAmount.div(2).mul(95).div(100);
                expect(expectedFirstUnstake).to.be.gt(baseAmount);
                expect(expectedSecondUnstake).to.be.gt(baseAmount);
            });

            it("Should allow reward rate change during active stakes", async () => {
                // Update lastCheckpoint
                await stakingPool.connect(userA).stake(stakeAmount);

                // Record initial state
                const preStakeBalance = await token.balanceOf(wallet.address);
                const preStakeTotal = await stakingPool.totalStaked();

                // Mine blocks, accumulate initial rewards
                const blocks1 = 5;
                for (let i = 0; i < blocks1; i++) {
                    await ethers.provider.send("evm_mine", []);
                }

                // Execute stake, will generate a new block reward
                await stakingPool.connect(userA).stake(stakeAmount.div(4));

                // Increase reward rate, this operation will generate a new block
                const newRewardRate = rewardPerBlock.mul(2);
                await stakingPool.setRewardPerBlock(newRewardRate);

                // Mine blocks, use new reward rate
                const blocks2 = 5;
                for (let i = 0; i < blocks2; i++) {
                    await ethers.provider.send("evm_mine", []);
                }

                // Execute stake, will generate a new block reward
                await stakingPool.connect(userA).stake(stakeAmount.div(4));

                // Calculate expected total reward
                // First stage: (5 + 1) blocks (includes stake) * initial reward rate
                const phase1Reward = rewardPerBlock.mul(blocks1 + 1);

                // Second stage: (5 + 2) blocks (includes setRewardPerBlock, stake) * new reward rate
                const phase2Reward = newRewardRate.mul(blocks2 + 2);

                // Calculate total reward
                const expectedTotalReward = phase1Reward.add(phase2Reward)

                // Verify total reward transferred out
                const postStakeBalance = await token.balanceOf(wallet.address);
                const actualReward = preStakeBalance.sub(postStakeBalance);
                expect(actualReward).to.eq(expectedTotalReward);

                // Verify totalStaked increase
                const totalStakedIncrease = (await stakingPool.totalStaked())
                    .sub(preStakeTotal)
                    .sub(stakeAmount.div(2)); // Subtract new stake amount

                expect(totalStakedIncrease).to.eq(expectedTotalReward);
            });
        });
    });
})