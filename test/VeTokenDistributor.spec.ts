import { BigNumber, Wallet } from "ethers";
import { ethers, waffle } from "hardhat";
import { expect } from "chai";
import { veTokenDistributorFixture } from "./shared/fixtures";
import { TestERC20, VeToken, VeTokenDistributor } from "../typechain-types";
import { time } from "./shared/utils"

const createFixtureLoader = waffle.createFixtureLoader;

describe("VeTokenDistributor", () => {
    let wallet: Wallet, vault: Wallet, userA: Wallet, userB: Wallet, userC: Wallet;
    let token: TestERC20;
    let veToken: VeToken;
    let rewardToken: TestERC20;
    let distributor: VeTokenDistributor;
    let loadFixture: ReturnType<typeof createFixtureLoader>;

    // Define constants using BigNumber
    const WEEK_1 = BigNumber.from(7 * 24 * 3600);
    const AMOUNT_1000 = ethers.constants.WeiPerEther.mul(1000);
    const AMOUNT_300 = ethers.constants.WeiPerEther.mul(300);
    const AMOUNT_100 = ethers.constants.WeiPerEther.mul(100);

    before("Create fixture loader", async () => {
        [wallet, vault, userA, userB, userC] = await (ethers as any).getSigners();
        loadFixture = createFixtureLoader([wallet, vault]);
    });

    beforeEach("Deploy fresh contracts", async () => {
        ({ token, veToken, rewardToken, veTokenDistributor: distributor } =
            await loadFixture(veTokenDistributorFixture));

        // Set initial state    
        await token.transfer(userA.address, AMOUNT_1000);
        await token.transfer(userB.address, AMOUNT_1000);
        await token.transfer(userC.address, AMOUNT_1000);

        await token.connect(userA).approve(veToken.address, ethers.constants.MaxUint256);
        await token.connect(userB).approve(veToken.address, ethers.constants.MaxUint256);
        await token.connect(userC).approve(veToken.address, ethers.constants.MaxUint256);
        await rewardToken.connect(vault).approve(distributor.address, ethers.constants.MaxUint256);
    });

    describe("Checkpoint Mechanism", () => {
        let startTime: BigNumber;

        beforeEach(async () => {
            startTime = await veToken.startTime();
        });

        it("should not update checkpoint in same week", async () => {
            // First checkpoint
            await distributor.checkPoint();
            const week1 = await distributor.lastCheckpointWeek();
            const balance1 = await distributor.lastCheckpointBalance();

            // Checkpoint again in the same period
            await distributor.checkPoint();
            const week2 = await distributor.lastCheckpointWeek();
            const balance2 = await distributor.lastCheckpointBalance();

            // Check state remains unchanged
            expect(week2).to.equal(week1);
            expect(balance2).to.eq(balance1);
        });

        it("should update checkpoint with vault balance change", async () => {
            // First perform a checkpoint
            await distributor.checkPoint();
            const initialBalance = await rewardToken.balanceOf(vault.address);

            // Increase vault balance
            await rewardToken.transfer(vault.address, AMOUNT_1000);

            // Advance time to next week
            await time.increaseTime(WEEK_1.toNumber())
            await distributor.checkPoint();

            // Verify updates
            const currentWeek = await distributor.lastCheckpointWeek();
            const weekReward = await distributor.rewardPerWeek(currentWeek - 1);
            expect(weekReward).to.eq(AMOUNT_1000);
            expect(await distributor.lastCheckpointBalance()).to.eq(initialBalance.add(AMOUNT_1000));
        });

        it("should distribute rewards across multiple weeks", async () => {
            // Set initial veToken stake
            await veToken.connect(userA).lock(AMOUNT_100, 52, false);

            // Initial checkpoint
            await distributor.checkPoint();

            // Increase vault balance
            await rewardToken.transfer(vault.address, AMOUNT_300);

            // Advance three weeks
            for (let i = 0; i < 3; i++) {
                await time.increaseTime(WEEK_1.toNumber());
            }

            await distributor.checkPoint();

            // Check reward distribution for three weeks
            const currentWeek = await distributor.lastCheckpointWeek();
            let totalDistributed = BigNumber.from(0);

            for (let i = currentWeek - 3; i < currentWeek; i++) {
                const weekReward = await distributor.rewardPerWeek(i);
                totalDistributed = totalDistributed.add(weekReward);
            }

            // Verify total distributed rewards equals added amount
            expect(totalDistributed).to.closeTo(AMOUNT_300, 2);
        });

        it("should handle zero voting power periods", async () => {
            await rewardToken.transfer(vault.address, AMOUNT_1000);

            await time.increaseTime(WEEK_1.toNumber());

            await distributor.checkPoint();

            const currentWeek = await distributor.lastCheckpointWeek();
            const weekReward = await distributor.rewardPerWeek(currentWeek - 1);
            expect(weekReward).to.eq(AMOUNT_1000);
        });

        it("should not distribute when vault balance decreases", async () => {

            // First increase vault balance and checkpoint
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            // Pass week
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Decrease vault balance
            await rewardToken.connect(vault).transfer(wallet.address, AMOUNT_1000.div(2));
            // Pass week
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Verify no rewards distributed in new period
            const currentWeek = await distributor.lastCheckpointWeek();
            const weekReward = await distributor.rewardPerWeek(currentWeek);
            expect(weekReward).to.eq(0);
        });

        it("should checkpoint when users claim rewards", async () => {
            // Set initial veToken stake
            await veToken.connect(userA).lock(AMOUNT_100, 52, false);

            // Increase vault balance
            await rewardToken.transfer(vault.address, AMOUNT_1000);

            // Advance time and let user claim
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.connect(userA).claim(userA.address);

            // Verify checkpoint is updated
            const currentWeek = await veToken.getCurrentWeek();
            expect(await distributor.lastCheckpointWeek()).to.equal(currentWeek);
        });
    });

    describe("Rewards Distribution", () => {

        beforeEach(async () => {
            // Users A and B lock tokens respectively
            await veToken.connect(userA).lock(AMOUNT_100, 52, false); // Lock 100 tokens for 52 weeks
            await veToken.connect(userB).lock(AMOUNT_100, 52, false); // Lock 100 tokens for 26 weeks

            // Transfer reward tokens to vault
            await rewardToken.transfer(vault.address, AMOUNT_1000);
        });

        it("should distribute all rewards to single user", async () => {
            // Increase one week
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            const currentWeek = await distributor.lastCheckpointWeek();
            const userAWeight = await veToken.balanceOfAtWeek(userA.address, currentWeek);
            const totalWeight = await veToken.totalSupplyAtWeek(currentWeek);

            // Calculate expected rewards
            const expectedReward = AMOUNT_1000.mul(userAWeight).div(totalWeight);
            const [claimable] = await distributor.getClaimable(userA.address);

            expect(claimable).to.be.closeTo(expectedReward, 1); // Allow 1 wei error
        });

        it("should distribute rewards proportionally to veToken balance", async () => {
            // Increase one week
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            const currentWeek = await distributor.lastCheckpointWeek();

            // Get user weights
            const userAWeight = await veToken.balanceOfAtWeek(userA.address, currentWeek);
            const userBWeight = await veToken.balanceOfAtWeek(userB.address, currentWeek);
            const totalWeight = await veToken.totalSupplyAtWeek(currentWeek);

            // Calculate expected rewards
            const expectedRewardA = AMOUNT_1000.mul(userAWeight).div(totalWeight);
            const expectedRewardB = AMOUNT_1000.mul(userBWeight).div(totalWeight);

            // Get actual claimable rewards
            const [claimableA] = await distributor.getClaimable(userA.address);
            const [claimableB] = await distributor.getClaimable(userB.address);

            expect(claimableA).to.be.closeTo(expectedRewardA, 1);
            expect(claimableB).to.be.closeTo(expectedRewardB, 1);
            // Ensure total rewards equal initial rewards
            expect(claimableA.add(claimableB)).to.be.closeTo(AMOUNT_1000, 2);
        });

        it("should handle reward distribution across multiple weeks", async () => {
            // First week distribution, week index 0 rewardPerWeek[0] = x
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Record first week claimable rewards
            const [firstWeekClaimableA] = await distributor.getClaimable(userA.address);
            const [firstWeekClaimableB] = await distributor.getClaimable(userA.address);

            // userB claims early
            await veToken.connect(userB).claimEarly();

            // Second week distribution, week index 1 rewardPerWeek[1] = x
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Get total claimable rewards
            const [totalClaimableA] = await distributor.getClaimable(userA.address);
            const [totalClaimableB] = await distributor.getClaimable(userB.address);

            // userA should get half of first week and all of second week rewards
            expect(totalClaimableA).to.be.eq(firstWeekClaimableA.add(AMOUNT_1000));
            // userB should only get first week rewards
            expect(totalClaimableB).to.eq(firstWeekClaimableB);
        });

        it("should adjust rewards when veToken balance changes", async () => {
            // First week distribution, week index 0 rewardPerWeek[0] = x
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Record first week claimable rewards
            const [firstWeekClaimableA] = await distributor.getClaimable(userA.address);
            const [firstWeekClaimableB] = await distributor.getClaimable(userA.address);

            // userB claims early
            await veToken.connect(userB).claimEarly();

            // Second week distribution, week index 1 rewardPerWeek[1] = x
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Get total claimable rewards
            const [totalClaimableA] = await distributor.getClaimable(userA.address);
            const [totalClaimableB] = await distributor.getClaimable(userB.address);

            // userA should get half of first week and all of second week rewards
            expect(totalClaimableA).to.be.eq(firstWeekClaimableA.add(AMOUNT_1000));
            // userB should only get first week rewards
            expect(totalClaimableB).to.eq(firstWeekClaimableB);
        });

        it("should handle reward distribution with autoLock position", async () => {
            // userC creates autoLock position
            await veToken.connect(userC).lock(AMOUNT_100, 52, true);
            await distributor.checkPoint();

            // Advance multiple periods
            for (let i = 0; i < 3; i++) {
                await time.increaseTime(WEEK_1.toNumber());
                await rewardToken.transfer(vault.address, AMOUNT_1000);
                await distributor.checkPoint();
            }

            // autoLock position weight should remain constant
            const [claimableA] = await distributor.getClaimable(userA.address);
            const [claimableB] = await distributor.getClaimable(userB.address);
            expect(claimableA).to.eq(claimableB);
            const [claimableC] = await distributor.getClaimable(userC.address);
            expect(claimableA).to.lt(claimableC)
        });

        it("should not distribute rewards after lock expires", async () => {
            // userC creates autoLock position
            await veToken.connect(userC).lock(AMOUNT_100, 26, false);
            await distributor.checkPoint();

            // Advance until C's lock is about to expire
            for (let i = 0; i < 26; i++) {
                await time.increaseTime(WEEK_1.toNumber());
                await distributor.checkPoint();
            }

            // Add new rewards
            await time.increaseTime(WEEK_1.toNumber());
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await distributor.checkPoint();

            // C's lock has expired, should not receive new rewards
            const [claimableC] = await distributor.getClaimable(userC.address);
            expect(claimableC).to.eq(AMOUNT_1000.div(5));

            // A should still receive rewards
            const [claimableA] = await distributor.getClaimable(userA.address);
            expect(claimableA).to.be.eq(AMOUNT_1000.mul(9).div(10));
        });
    });

    describe("Rewards Claiming", () => {

        beforeEach(async () => {
            // Set initial state
            // User A locks 100 tokens for 52 weeks
            await veToken.connect(userA).lock(AMOUNT_100, 52, false);

            // Deposit 1000 reward tokens into vault
            await rewardToken.transfer(vault.address, AMOUNT_1000);

            // Increase one week to activate rewards
            await time.increaseTime(WEEK_1.toNumber());

            await distributor.checkPoint();
        });

        it("should allow user to claim rewards", async () => {
            // Get expected reward amount
            const [expectedReward] = await distributor.getClaimable(userA.address);

            // Record initial balances
            const initBalance = await rewardToken.balanceOf(userA.address);
            const initVaultBalance = await rewardToken.balanceOf(vault.address);

            // Execute claim
            await distributor.connect(userA).claim(userA.address);

            // Verify user balance increase
            expect(await rewardToken.balanceOf(userA.address))
                .to.eq(initBalance.add(expectedReward));

            // Verify vault balance decrease
            expect(await rewardToken.balanceOf(vault.address))
                .to.eq(initVaultBalance.sub(expectedReward));

            // Verify last claimed week updated
            expect(await distributor.lastClaimedWeek(userA.address))
                .to.eq(await distributor.lastCheckpointWeek());
        });

        it("should not allow claiming to zero address", async () => {
            await expect(
                distributor.connect(userA).claim(ethers.constants.AddressZero)
            ).to.be.revertedWith("ERC20: transfer to the zero address");
        });

        it("should handle multiple claims in different weeks", async () => {
            // First claim
            const [firstReward] = await distributor.getClaimable(userA.address);
            await distributor.connect(userA).claim(userA.address);

            // Increase new rewards and advance time
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Second claim
            const [secondReward] = await distributor.getClaimable(userA.address);
            await distributor.connect(userA).claim(userA.address);

            // Verify total claimed amount
            expect(await rewardToken.balanceOf(userA.address))
                .to.eq(firstReward.add(secondReward));
        });

        it("should not allow claiming in same week", async () => {
            // First claim
            await distributor.connect(userA).claim(userA.address);

            // Same period claim again
            const [claimable] = await distributor.getClaimable(userA.address);
            expect(claimable).to.eq(0);

            const balanceBefore = await rewardToken.balanceOf(userA.address);
            await distributor.connect(userA).claim(userA.address);
            expect(await rewardToken.balanceOf(userA.address)).to.eq(balanceBefore);
        });

        it("should handle claims across multiple weeks", async () => {
            // Increase multiple week rewards
            for (let i = 0; i < 3; i++) {
                await rewardToken.transfer(vault.address, AMOUNT_1000);
                await time.increaseTime(WEEK_1.toNumber());
                await distributor.checkPoint();
            }

            // Claim all week rewards at once
            const [totalReward] = await distributor.getClaimable(userA.address);
            await distributor.connect(userA).claim(userA.address);

            expect(await rewardToken.balanceOf(userA.address)).to.eq(totalReward);
            expect(await distributor.lastClaimedWeek(userA.address))
                .to.eq(await distributor.lastCheckpointWeek());
        });

        it("should handle claims when veToken balance changes", async () => {
            // Record first claimable amount
            const [firstClaimable] = await distributor.getClaimable(userA.address);

            // Unlock veToken early
            await veToken.connect(userA).claimEarly();

            // Increase new week
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Claim rewards
            await distributor.connect(userA).claim(userA.address);

            // Should only claim unlocked rewards
            expect(await rewardToken.balanceOf(userA.address)).to.eq(firstClaimable);
        });

        it("should update checkpoint when claiming", async () => {
            const weekBefore = await distributor.lastCheckpointWeek();

            // Advance time but do not checkpoint
            await time.increaseTime(WEEK_1.toNumber());

            // Claim trigger checkpoint
            await distributor.connect(userA).claim(userA.address);

            expect(await distributor.lastCheckpointWeek()).to.be.gt(weekBefore);
        });

        it("should handle claims with auto-lock positions", async () => {
            // Create autoLock position
            await veToken.connect(userC).lock(AMOUNT_100, 52, true);

            // Advance multiple weeks
            for (let i = 0; i < 3; i++) {
                await time.increaseTime(WEEK_1.toNumber());
                await rewardToken.transfer(vault.address, AMOUNT_100)
                await distributor.checkPoint();
            }

            // Auto-locked users should continue to receive rewards
            const [claimable] = await distributor.getClaimable(userC.address);
            expect(claimable).to.be.gt(0);

            await distributor.connect(userC).claim(userC.address);
            expect(await rewardToken.balanceOf(userC.address)).to.eq(claimable);
        });

        it("should properly update last checkpoint balance", async () => {
            const [claimable] = await distributor.getClaimable(userA.address);
            const balanceBefore = await distributor.lastCheckpointBalance();

            await distributor.connect(userA).claim(userA.address);

            expect(await distributor.lastCheckpointBalance())
                .to.eq(balanceBefore.sub(claimable));
        });
    });

    describe("Rewards Estimation", () => {

        beforeEach(async () => {
            // Set initial veToken locking
            await veToken.connect(userA).lock(AMOUNT_100, 52, false); // Non-autoLock
            await veToken.connect(userB).lock(AMOUNT_100, 52, true);  // AutoLock
        });

        it("should estimate zero rewards for first week", async () => {
            // First estimate, should be 0
            expect(await distributor.estimateClaimable(userA.address)).to.eq(0);
        });

        it("should estimate rewards after vault receives tokens", async () => {
            // Transfer reward tokens
            await rewardToken.transfer(vault.address, AMOUNT_1000);

            // Advance one week and checkpoint
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Estimate should match actual claimable value
            const [actualClaimable] = await distributor.getClaimable(userA.address);
            const estimated = await distributor.estimateClaimable(userA.address);

            expect(estimated).to.eq(actualClaimable);
        });

        it("should estimate rewards for multiple unclaimed weeks", async () => {
            // Transfer multiple week rewards
            for (let i = 0; i < 3; i++) {
                await rewardToken.transfer(vault.address, AMOUNT_1000);
                await time.increaseTime(WEEK_1.toNumber());
                await distributor.checkPoint();
            }

            // Estimate rewards should include all unclaimed weeks
            const estimated = await distributor.estimateClaimable(userA.address);
            const [actualClaimable] = await distributor.getClaimable(userA.address);

            expect(estimated).to.eq(actualClaimable);
        });

        it("should estimate future rewards based on current vault balance", async () => {
            // Transfer initial rewards and wait one week
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // Claim current rewards
            await distributor.connect(userA).claim(userA.address);

            // Transfer new rewards but do not checkpoint
            await rewardToken.transfer(vault.address, AMOUNT_1000);

            // Advance time, should be able to estimate future rewards
            await time.increaseTime(WEEK_1.toNumber());

            const estimated = await distributor.estimateClaimable(userA.address);
            expect(estimated).to.be.gt(0);
        });

        it("should estimate different rewards for autoLock vs non-autoLock", async () => {
            // Transfer rewards and wait multiple weeks
            await rewardToken.transfer(vault.address, AMOUNT_1000);

            // Advance multiple weeks
            for (let i = 0; i < 3; i++) {
                await time.increaseTime(WEEK_1.toNumber());
            }

            const estimatedA = await distributor.estimateClaimable(userA.address); // Non-autoLock
            const estimatedB = await distributor.estimateClaimable(userB.address); // AutoLock

            // Auto-locked users weight should not decrease with time, should receive more rewards
            expect(estimatedB).to.be.gt(estimatedA);
        });

        it("should update estimates after veToken balance changes", async () => {
            // Transfer rewards
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());

            // Record initial estimate
            const initialEstimate = await distributor.estimateClaimable(userA.address);

            // If here do not `checkPoint`, execute subsequent tests, then first week rewards will be merged with second week rewards,
            // calculated by total veToken stake weight.
            // Since second week will execute extraction operation, second week weight will decrease, resulting in first week total rewards
            // more than before. Since userA's first week weight remains unchanged, total rewards will increase.
            // userA total estimated rewards will increase.
            // This situation still needs to be avoided by single week trigger `checkPoint` method.
            await distributor.checkPoint()

            // userA unlock early, subsequent rewards are 0
            await veToken.connect(userA).claimEarly();

            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());

            // New estimate should equal initial estimate
            const newEstimate = await distributor.estimateClaimable(userA.address);
            expect(newEstimate).to.be.eq(initialEstimate);
        });

        it("should estimate zero rewards after lock expires", async () => {
            // Transfer initial rewards
            await rewardToken.transfer(vault.address, AMOUNT_1000);

            // Advance until Non-autoLock is about to expire
            for (let i = 0; i < 52; i++) {
                await time.increaseTime(WEEK_1.toNumber());
            }

            await time.increaseTime(WEEK_1.toNumber());

            const estimateA = await distributor.estimateClaimable(userA.address);
            const estimateB = await distributor.estimateClaimable(userB.address);
            expect(estimateB).to.gt(estimateA);
        });

        it("should handle estimation with zero total supply", async () => {
            // All users unlock early
            await veToken.connect(userA).claimEarly();
            await veToken.connect(userB).claimEarly();

            // Transfer new rewards
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());

            // Estimate should be 0 when total supply is 0
            expect(await distributor.estimateClaimable(userA.address)).to.eq(0);
            expect(await distributor.estimateClaimable(userB.address)).to.eq(0);
        });

        it("should estimate correctly with multi weeks and different rewards", async () => {
            // Transfer rewards and advance time
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());
            await distributor.checkPoint();

            // User C locks tokens
            await veToken.connect(userC).lock(AMOUNT_100, 52, false);
            await time.increaseTime(WEEK_1.toNumber());

            // User B estimate rewards > User A > User C == 0,
            const estimatedA = await distributor.estimateClaimable(userA.address);
            expect(estimatedA).to.be.gt(0);
            const estimated = await distributor.estimateClaimable(userC.address);
            expect(estimated).to.be.eq(0);
        });

        it("should estimate rewards consistently before and after checkpoint", async () => {
            await rewardToken.transfer(vault.address, AMOUNT_1000);
            await time.increaseTime(WEEK_1.toNumber());

            // checkpoint before estimate
            const estimatedBefore = await distributor.estimateClaimable(userA.address);

            await distributor.checkPoint();

            // checkpoint after estimate
            const estimatedAfter = await distributor.estimateClaimable(userA.address);
            const [actualClaimable] = await distributor.getClaimable(userA.address);

            // Estimate should remain consistent and match actual claimable value
            expect(estimatedBefore).to.eq(estimatedAfter);
            expect(estimatedAfter).to.eq(actualClaimable);
        });
    });

    describe("Access Control", () => {
        const AMOUNT_1000 = ethers.constants.WeiPerEther.mul(1000);

        it("should only allow manager to setup vault", async () => {
            // Non-manager call should fail
            await expect(
                distributor.connect(userA).setupVault(userA.address)
            ).to.be.reverted;

            // Manager call should succeed
            await distributor.connect(wallet).setupVault(userB.address);
            expect(await distributor.vault()).to.eq(userB.address);
        });

        it("should only allow manager to withdraw tokens", async () => {
            // Transfer tokens for testing
            await rewardToken.transfer(distributor.address, AMOUNT_1000);

            // Non-manager call should fail
            await expect(
                distributor.connect(userA).withdraw(rewardToken.address, AMOUNT_1000)
            ).to.be.reverted;

            // Manager call should succeed
            const balanceBefore = await rewardToken.balanceOf(wallet.address);
            await distributor.connect(wallet).withdraw(rewardToken.address, AMOUNT_1000);

            expect(await rewardToken.balanceOf(wallet.address))
                .to.eq(balanceBefore.add(AMOUNT_1000));
        });
    });
});