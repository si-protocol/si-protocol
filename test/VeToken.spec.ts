import { BigNumber, Wallet } from "ethers";
import { ethers, waffle, network } from "hardhat";
import { TestERC20 } from "../typechain-types/contracts/utils/TestERC20";
import { VeToken } from "../typechain-types/contracts/VeToken";
import { expect } from "chai";
import { veTokenFixture } from "./shared/fixtures";
import { time } from "./shared/utils";

const createFixtureLoader = waffle.createFixtureLoader;

describe("VeToken", async () => {
    let wallet: Wallet, userA: Wallet, userB: Wallet;
    let token: TestERC20;
    let veToken: VeToken;
    let loadFixture: ReturnType<typeof createFixtureLoader>;
    let startTime: BigNumber;

    const WEEK = 7 * 24 * 60 * 60; // 1 week in seconds

    before("Create fixture loader", async () => {
        [wallet, userA, userB] = await (ethers as any).getSigners();
        loadFixture = createFixtureLoader([wallet]);
    });

    beforeEach("Deploy contracts", async () => {
        ({ token, veToken } = await loadFixture(veTokenFixture));

        // Distribute tokens to users
        await token.transfer(userA.address, ethers.constants.WeiPerEther.mul(1000));
        await token.transfer(userB.address, ethers.constants.WeiPerEther.mul(1000));

        // Approve veToken contract
        await token.connect(userA).approve(veToken.address, ethers.constants.MaxUint256);
        await token.connect(userB).approve(veToken.address, ethers.constants.MaxUint256);

        startTime = await veToken.startTime();
    });

    describe("Lock", () => {
        const MIN_AMOUNT = ethers.utils.parseEther("0.01");
        const LOCK_AMOUNT = ethers.utils.parseEther("100");

        it("Should create lock position correctly", async () => {
            const lockWeeks = 10;

            // Create lock
            await expect(veToken.connect(userA).lock(LOCK_AMOUNT, lockWeeks, false))
                .to.emit(veToken, "LockCreated")
                .withArgs(userA.address, LOCK_AMOUNT, lockWeeks, false);

            // Check user state
            const lockData = await veToken.getLockedData(userA.address);
            expect(lockData.locked).to.equal(LOCK_AMOUNT);
            expect(lockData.lockWeeks).to.equal(lockWeeks);
            expect(lockData.autoLock).to.be.false;

            // Check token transfer
            expect(await token.balanceOf(veToken.address)).to.equal(LOCK_AMOUNT);
            expect(await token.balanceOf(userA.address)).to.equal(ethers.utils.parseEther("900")); // 1000 - 100

            // Check voting power
            const votingPower = LOCK_AMOUNT.mul(lockWeeks);
            expect(await veToken.balanceOf(userA.address)).to.equal(votingPower);
        });

        it("Should fail if amount is too small", async () => {
            const tooSmall = MIN_AMOUNT.sub(1);
            await expect(
                veToken.connect(userA).lock(tooSmall, 10, false)
            ).to.be.revertedWith("Lock amount must be greater or equal than 0.01");
        });

        it("Should fail if lock period exceeds max weeks", async () => {
            const tooLong = 53; // MAX_LOCK_WEEKS + 1
            await expect(
                veToken.connect(userA).lock(LOCK_AMOUNT, tooLong, false)
            ).to.be.revertedWith("The number of week exceeds MAX_LOCK_WEEKS");
        });

        it("Should fail if account already has locked position", async () => {
            // Create first lock
            await veToken.connect(userA).lock(LOCK_AMOUNT, 10, false);

            // Attempt second lock
            await expect(
                veToken.connect(userA).lock(LOCK_AMOUNT, 10, false)
            ).to.be.revertedWith("There is already lock position");
        });

        it("Should update global state correctly", async () => {
            const lockWeeks = 10;
            const currentWeek = await veToken.getCurrentWeek();

            await veToken.connect(userA).lock(LOCK_AMOUNT, lockWeeks, false);

            // Check total locked amount
            const totalLocked = await veToken.getTotalLockedAtWeek(currentWeek);
            expect(totalLocked).to.equal(LOCK_AMOUNT);

            // Check total supply (voting power)
            const expectedSupply = LOCK_AMOUNT.mul(lockWeeks);
            expect(await veToken.totalSupply()).to.equal(expectedSupply);
        });

        it("Should handle auto lock correctly", async () => {
            const lockWeeks = 10;

            await veToken.connect(userA).lock(LOCK_AMOUNT, lockWeeks, true);

            const lockData = await veToken.getLockedData(userA.address);
            expect(lockData.autoLock).to.be.true;

            // Auto locked positions should not set unlock time
            const currentWeek = await veToken.getCurrentWeek();
            const totalLockedData = await veToken.totalLockedData(currentWeek);
            expect(totalLockedData.autoLockAmount).to.equal(LOCK_AMOUNT);
        });

        it("Should maintain correct state across blocks", async () => {
            const lockWeeks = 10;
            await veToken.connect(userA).lock(LOCK_AMOUNT, lockWeeks, false);

            // Move forward a few blocks
            await time.increaseTime(WEEK);

            const votingPower = await veToken.balanceOf(userA.address);
            const expectedPower = LOCK_AMOUNT.mul(lockWeeks - 1); // Reduced by 1 week
            expect(votingPower).to.equal(expectedPower);
        });
    });

    describe("Relock", () => {
        const LOCK_AMOUNT = ethers.utils.parseEther("100");
        const INITIAL_LOCK_WEEKS = 4;

        beforeEach(async () => {
            // Create initial lock position
            await veToken.connect(userA).lock(LOCK_AMOUNT, INITIAL_LOCK_WEEKS, false);
        });

        it("Should relock expired position", async () => {
            // Move time past lock period
            await time.increaseTime(INITIAL_LOCK_WEEKS * WEEK + 1);

            const newLockWeeks = 10;
            await expect(veToken.connect(userA).relockUnclaimed(newLockWeeks, false))
                .to.emit(veToken, "LockCreated")
                .withArgs(userA.address, LOCK_AMOUNT, newLockWeeks, false);

            const lockData = await veToken.getLockedData(userA.address);
            expect(lockData.locked).to.equal(LOCK_AMOUNT);
            expect(lockData.lockWeeks).to.equal(newLockWeeks);
            expect(lockData.autoLock).to.be.false;

            const votingPower = LOCK_AMOUNT.mul(newLockWeeks);
            expect(await veToken.balanceOf(userA.address)).to.equal(votingPower);
        });

        it("Should fail if position is not expired", async () => {
            // Move time but not past lock period
            await time.increaseTime(INITIAL_LOCK_WEEKS * WEEK - WEEK);

            await expect(
                veToken.connect(userA).relockUnclaimed(10, false)
            ).to.be.revertedWith("Thers is already lock position");
        });

        it("Should fail if no previous position exists", async () => {
            await expect(
                veToken.connect(userB).relockUnclaimed(10, false)
            ).to.be.revertedWith("Zero amount of token can be relock");
        });

        it("Should allow changing autoLock status during relock", async () => {
            await time.increaseTime(INITIAL_LOCK_WEEKS * WEEK + 1);

            // Relock with autoLock enabled
            await veToken.connect(userA).relockUnclaimed(10, true);

            const lockData = await veToken.getLockedData(userA.address);
            expect(lockData.autoLock).to.be.true;

            // Verify autoLock amount updated in global state
            const currentWeek = await veToken.getCurrentWeek();
            const totalLockedData = await veToken.totalLockedData(currentWeek);
            expect(totalLockedData.autoLockAmount).to.equal(LOCK_AMOUNT);
        });

        it("Should handle multiple relocks correctly", async () => {
            // First relock
            await time.increaseTime(INITIAL_LOCK_WEEKS * WEEK + 1);
            await veToken.connect(userA).relockUnclaimed(6, false);

            // Second relock
            await time.increaseTime(6 * WEEK + 1);
            await veToken.connect(userA).relockUnclaimed(8, false);

            const lockData = await veToken.getLockedData(userA.address);
            expect(lockData.lockWeeks).to.equal(8);
            expect(lockData.locked).to.equal(LOCK_AMOUNT);
        });

        it("Should fail if trying to relock with balance", async () => {
            await expect(
                veToken.connect(userA).relockUnclaimed(10, false)
            ).to.be.revertedWith("Thers is already lock position");
        });
    });

    describe("Claim", () => {
        const LOCK_AMOUNT = ethers.utils.parseEther("100");
        const LOCK_WEEKS = 4;

        describe("Regular Claim", () => {
            beforeEach(async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
            });

            it("Should allow claiming after lock period", async () => {
                await time.increaseTime(LOCK_WEEKS * WEEK + 1);

                await expect(veToken.connect(userA).claim())
                    .to.emit(veToken, "Claimed")
                    .withArgs(userA.address, LOCK_AMOUNT);

                // Verify token transfer
                expect(await token.balanceOf(userA.address)).to.equal(ethers.utils.parseEther("1000"));
                expect(await token.balanceOf(veToken.address)).to.equal(0);

                // Verify lock data cleared
                const lockData = await veToken.getLockedData(userA.address);
                expect(lockData.locked).to.equal(0);
                expect(lockData.lockWeeks).to.equal(0);
            });

            it("Should fail claiming during lock period", async () => {
                await time.increaseTime(LOCK_WEEKS * WEEK - WEEK); // Not quite expired

                await expect(veToken.connect(userA).claim())
                    .to.be.revertedWith("The position is still in lock period");
            });

            it("Should fail claiming with zero balance", async () => {
                await expect(veToken.connect(userB).claim())
                    .to.be.revertedWith("There locked position is zero");
            });
        });

        describe("Early Claim", () => {
            it("Should calculate penalty correctly for early claim", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                await time.increaseTime(WEEK); // 1 week in

                const penalty = await veToken.getPenalty(userA.address);
                const expectedPenalty = LOCK_AMOUNT.mul(LOCK_WEEKS - 1).div(52); // (amount * remainingWeeks) / MAX_WEEKS

                expect(penalty).to.equal(expectedPenalty);

                const expectedReturn = LOCK_AMOUNT.sub(penalty);
                await expect(veToken.connect(userA).claimEarly())
                    .to.emit(veToken, "ClaimedEarly")
                    .withArgs(userA.address, expectedReturn, penalty);

                expect(await token.balanceOf(userA.address)).to.equal(ethers.utils.parseEther("900").add(expectedReturn));
                expect(await veToken.totalPenalty()).to.equal(penalty);
            });

            it("Should handle auto-lock position early claim", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, true);

                const penalty = await veToken.getPenalty(userA.address);
                const expectedPenalty = LOCK_AMOUNT.mul(LOCK_WEEKS).div(52); // (amount * totalWeeks) / MAX_WEEKS

                expect(penalty).to.equal(expectedPenalty);
            });

            it("Should update state correctly after early claim", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                await veToken.connect(userA).claimEarly();

                const lockData = await veToken.getLockedData(userA.address);
                expect(lockData.locked).to.equal(0);
                expect(lockData.lockWeeks).to.equal(0);
                expect(lockData.autoLock).to.be.false;
                expect(await veToken.balanceOf(userA.address)).to.equal(0);
            });

            it("Should fail early claim when regular claim is available", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                await time.increaseTime(LOCK_WEEKS * WEEK + 1);

                await expect(veToken.connect(userA).claimEarly())
                    .to.be.revertedWith("Please call the function claim");
            });
        });

        describe("Penalty Management", () => {
            it("Should allow manager to withdraw penalties", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                await veToken.connect(userA).claimEarly();

                const penalty = await veToken.totalPenalty();
                const preWalletBalance = await token.balanceOf(wallet.address)
                await expect(veToken.withdraw())
                    .to.emit(veToken, "Withdraw")
                    .withArgs(wallet.address, penalty);
                const postWalletBalance = await token.balanceOf(wallet.address)

                expect(postWalletBalance.sub(preWalletBalance)).to.equal(penalty);
                expect(await veToken.totalPenalty()).to.equal(0);
            });

            it("Should fail penalty withdrawal by non-manager", async () => {
                await expect(veToken.connect(userA).withdraw())
                    .to.be.revertedWith("AccessControl");
            });

            it("Should fail penalty withdrawal with zero penalty", async () => {
                await expect(veToken.withdraw())
                    .to.be.revertedWith("The total penalty is zero");
            });
        });
    });

    describe("Auto Lock", () => {
        const LOCK_AMOUNT = ethers.utils.parseEther("100");
        const LOCK_WEEKS = 4;

        beforeEach(async () => {
            await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
        });

        describe("Enable Auto Lock", () => {
            it("Should enable auto lock correctly", async () => {
                await veToken.connect(userA).enableAutoLock();

                const lockData = await veToken.getLockedData(userA.address);
                expect(lockData.autoLock).to.be.true;
                expect(lockData.locked).to.equal(LOCK_AMOUNT);

                const currentWeek = await veToken.getCurrentWeek();
                const totalLockedData = await veToken.totalLockedData(currentWeek);
                expect(totalLockedData.autoLockAmount).to.equal(LOCK_AMOUNT);
            });

            it("Should fail enabling auto lock without position", async () => {
                await expect(veToken.connect(userB).enableAutoLock())
                    .to.be.revertedWith("no lock data");
            });

            it("Should fail enabling already auto locked position", async () => {
                await veToken.connect(userA).enableAutoLock();
                await expect(veToken.connect(userA).enableAutoLock())
                    .to.be.revertedWith("already auto lock");
            });

            it("Should maintain correct voting power after enabling", async () => {
                const beforePower = await veToken.balanceOf(userA.address);
                await veToken.connect(userA).enableAutoLock();
                const afterPower = await veToken.balanceOf(userA.address);

                expect(afterPower).to.equal(beforePower);
            });
        });

        describe("Disable Auto Lock", () => {
            beforeEach(async () => {
                await veToken.connect(userA).enableAutoLock();
            });

            it("Should disable auto lock correctly", async () => {
                await veToken.connect(userA).disableAutoLock();

                const lockData = await veToken.getLockedData(userA.address);
                expect(lockData.autoLock).to.be.false;
                expect(lockData.locked).to.equal(LOCK_AMOUNT);

                const currentWeek = await veToken.getCurrentWeek();
                const totalLockedData = await veToken.totalLockedData(currentWeek);
                expect(totalLockedData.autoLockAmount).to.equal(0);
            });

            it("Should fail disabling non-auto locked position", async () => {
                await veToken.connect(userA).disableAutoLock();
                await expect(veToken.connect(userA).disableAutoLock())
                    .to.be.revertedWith("The position can not be disable");
            });

            it("Should update unlock time when disabling", async () => {
                await veToken.connect(userA).disableAutoLock();
                const currentWeek = await veToken.getCurrentWeek();
                const unlockWeek = currentWeek + LOCK_WEEKS;

                const totalUnlocked = await veToken.totalUnlockedData(unlockWeek);
                expect(totalUnlocked).to.equal(LOCK_AMOUNT);
            });
        });

        describe("Auto Lock State Management", () => {
            it("Should handle time progression correctly with auto lock", async () => {
                await veToken.connect(userA).enableAutoLock();
                await time.increaseTime(LOCK_WEEKS * WEEK);

                // Auto locked position should maintain voting power
                const votingPower = await veToken.balanceOf(userA.address);
                expect(votingPower).to.equal(LOCK_AMOUNT.mul(LOCK_WEEKS));
            });

            it("Should calculate early claim penalty correctly for auto lock", async () => {
                await veToken.connect(userA).enableAutoLock();

                const penalty = await veToken.getPenalty(userA.address);
                const expectedPenalty = LOCK_AMOUNT.mul(LOCK_WEEKS).div(52);
                expect(penalty).to.equal(expectedPenalty);
            });

            it("Should handle checkpoint updates with auto lock", async () => {
                await veToken.connect(userA).enableAutoLock();
                await time.increaseTime(WEEK * 2);

                // Force checkpoint update
                await veToken.connect(userB).lock(LOCK_AMOUNT, LOCK_WEEKS, false);

                const currentWeek = await veToken.getCurrentWeek();
                const totalLockedData = await veToken.totalLockedData(currentWeek);
                expect(totalLockedData.autoLockAmount).to.equal(LOCK_AMOUNT);
            });
        });
    });

    describe("Balance and Supply", () => {
        const LOCK_AMOUNT = ethers.utils.parseEther("100");
        const LOCK_WEEKS = 4;

        describe("Balance Calculations", () => {
            it("Should decay balance linearly over time", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);

                await veToken.balanceOf(userA.address);

                // Check balance after each week
                for (let i = 1; i <= LOCK_WEEKS; i++) {
                    await time.increaseTime(WEEK);
                    const expectedBalance = LOCK_AMOUNT.mul(LOCK_WEEKS - i);
                    const currentBalance = await veToken.balanceOf(userA.address);
                    expect(currentBalance).to.equal(expectedBalance);
                }
            });

            it("Should maintain constant balance with auto-lock", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, true);
                const initialBalance = await veToken.balanceOf(userA.address);

                await time.increaseTime(WEEK * 2);
                const midBalance = await veToken.balanceOf(userA.address);

                expect(midBalance).to.equal(initialBalance);
            });

            it("Should calculate historical balances correctly", async () => {
                const timestamp = await veToken.startTime();
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);

                await time.increaseTime(WEEK * 2);

                const historicalBalance = await veToken.balanceOfAtTime(userA.address, timestamp.add(WEEK));
                expect(historicalBalance).to.equal(LOCK_AMOUNT.mul(LOCK_WEEKS - 1));
            });
        });

        describe("Total Supply", () => {
            it("Should track total supply with multiple users", async () => {
                // First user locks
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);

                // Second user locks
                await veToken.connect(userB).lock(LOCK_AMOUNT, LOCK_WEEKS * 2, false);
                const supplyAfterSecond = await veToken.totalSupply();

                expect(supplyAfterSecond).to.equal(
                    LOCK_AMOUNT.mul(LOCK_WEEKS).add(LOCK_AMOUNT.mul(LOCK_WEEKS * 2))
                );

                // Check decay
                await time.increaseTime(WEEK);
                const supplyAfterWeek = await veToken.totalSupply();
                expect(supplyAfterWeek).to.equal(
                    LOCK_AMOUNT.mul(LOCK_WEEKS - 1).add(LOCK_AMOUNT.mul(LOCK_WEEKS * 2 - 1))
                );
            });

            it("Should calculate historical total supply correctly", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                await veToken.connect(userB).lock(LOCK_AMOUNT, LOCK_WEEKS, false);

                const timestamp = (await ethers.provider.getBlock('latest')).timestamp;
                await time.increaseTime(WEEK * 2);

                const historicalSupply = await veToken.totalSupplyAtTime(timestamp);
                expect(historicalSupply).to.equal(LOCK_AMOUNT.mul(LOCK_WEEKS).mul(2));
            });

            it("Should calculate historical total supply correctly afer claimed with multi users", async () => {
                // User locks
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                await veToken.connect(userB).lock(LOCK_AMOUNT, LOCK_WEEKS * 2, false);

                const firstWeek = await veToken.getCurrentWeek()
                const firstSupply = await veToken.totalSupplyAtWeek(firstWeek);
                expect(firstSupply).to.equal(
                    LOCK_AMOUNT.mul(LOCK_WEEKS).add(LOCK_AMOUNT.mul(LOCK_WEEKS * 2))
                );

                // Increase time for one week
                await time.increaseTime(WEEK);
                const secondWeek = await veToken.getCurrentWeek()
                const secondSupply = await veToken.totalSupplyAtWeek(secondWeek);
                expect(secondSupply).to.equal(
                    LOCK_AMOUNT.mul(LOCK_WEEKS - 1).add(LOCK_AMOUNT.mul(LOCK_WEEKS * 2 - 1))
                );

                // UserB claim ealy after one week
                await time.increaseTime(WEEK);
                await veToken.connect(userB).claimEarly();

                // Check the history total state correct
                const historySecondSupply = await veToken.totalSupplyAtWeek(secondWeek);
                expect(historySecondSupply).to.equal(
                    LOCK_AMOUNT.mul(LOCK_WEEKS - 1).add(LOCK_AMOUNT.mul(LOCK_WEEKS * 2 - 1))
                );

                // Check the current total state correct
                const currentWeek = await veToken.getCurrentWeek()
                const supply = await veToken.totalSupplyAtWeek(currentWeek);
                expect(supply).to.equal(LOCK_AMOUNT.mul(LOCK_WEEKS - 2));
            });


            it("Should handle supply changes at week boundaries", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);

                // Move to exact week boundary
                const currentWeek = await veToken.getCurrentWeek();
                const nextWeekStart = (currentWeek + 1) * WEEK + Number(await veToken.startTime());
                await time.setBlockTimestamp(nextWeekStart);

                const supplyAtBoundary = await veToken.totalSupply();
                expect(supplyAtBoundary).to.equal(LOCK_AMOUNT.mul(LOCK_WEEKS - 1));
            });
        });

        describe("Locked Amounts", () => {
            it("Should track total locked amount correctly", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                const currentWeek = await veToken.getCurrentWeek();

                const totalLocked = await veToken.getTotalLockedAtWeek(currentWeek);
                expect(totalLocked).to.equal(LOCK_AMOUNT);

                await time.increaseTime(LOCK_WEEKS * WEEK);
                const totalLockedAfter = await veToken.getTotalLockedAtWeek(currentWeek + LOCK_WEEKS);
                expect(totalLockedAfter).to.equal(0);
            });

            it("Should handle locked amount changes with multiple users", async () => {
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                await veToken.connect(userB).lock(LOCK_AMOUNT.mul(2), LOCK_WEEKS, false);

                const currentWeek = await veToken.getCurrentWeek();
                const totalLocked = await veToken.getTotalLockedAtWeek(currentWeek);
                expect(totalLocked).to.equal(LOCK_AMOUNT.mul(3));
            });
        });
    });

    describe("Admin Functions", () => {
        const LOCK_AMOUNT = ethers.utils.parseEther("100");
        const LOCK_WEEKS = 4;

        describe("Penalty Receiver Management", () => {
            it("Should allow admin to change penalty receiver", async () => {
                await expect(veToken.setPenaltyReceiver(userB.address))
                    .to.emit(veToken, "PenaltyReceiverChanged")
                    .withArgs(userB.address);

                expect(await veToken.penaltyReceiver()).to.equal(userB.address);
            });

            it("Should prevent non-admin from changing penalty receiver", async () => {
                await expect(veToken.connect(userA).setPenaltyReceiver(userB.address))
                    .to.be.revertedWith("AccessControl");
            });

            it("Should not allow setting zero address as penalty receiver", async () => {
                await expect(veToken.setPenaltyReceiver(ethers.constants.AddressZero))
                    .to.be.revertedWith("Inalid new address");
            });

            it("Should not allow setting current address as penalty receiver", async () => {
                const currentReceiver = await veToken.penaltyReceiver();
                await expect(veToken.setPenaltyReceiver(currentReceiver))
                    .to.be.revertedWith("Inalid new address");
            });
        });

        describe("Penalty Withdrawal", () => {
            beforeEach(async () => {
                // Create penalty by early claim
                await veToken.connect(userA).lock(LOCK_AMOUNT, LOCK_WEEKS, false);
                await veToken.connect(userA).claimEarly();
            });

            it("Should allow manager to withdraw penalties", async () => {
                const penalty = await veToken.totalPenalty();
                const initBalance = await token.balanceOf(wallet.address);

                await expect(veToken.withdraw())
                    .to.emit(veToken, "Withdraw")
                    .withArgs(wallet.address, penalty);

                expect(await token.balanceOf(wallet.address)).to.equal(initBalance.add(penalty));
                expect(await veToken.totalPenalty()).to.equal(0);
            });

            it("Should prevent non-manager from withdrawing penalties", async () => {
                await expect(veToken.connect(userB).withdraw())
                    .to.be.revertedWith("AccessControl");
            });

            it("Should prevent withdrawal with no penalties", async () => {
                await veToken.withdraw(); // First withdrawal
                await expect(veToken.withdraw())
                    .to.be.revertedWith("The total penalty is zero");
            });
        });
    });
});