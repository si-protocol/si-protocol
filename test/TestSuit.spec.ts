import { BigNumber, Wallet } from "ethers";
import { ethers, waffle, network } from "hardhat";
import { TestERC20 } from "../typechain-types/contracts/utils/TestERC20";
import { VeToken } from "../typechain-types/contracts/VeToken";
import { expect } from "chai";
import { veTokenFixture } from "./shared/fixtures";

const createFixtureLoader = waffle.createFixtureLoader;

describe("TestSuit", async () => {
    let wallet: Wallet, userA: Wallet, userB: Wallet;
    let token: TestERC20;
    let veToken: VeToken;
    let loadFixture: ReturnType<typeof createFixtureLoader>;
    let startTime: BigNumber;

    const WEEK = 7 * 24 * 60 * 60; // 1 week in seconds
    const MANAGER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("MANAGER"));
    
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

    describe("Initial State", () => {
        it("Should setup roles correctly", async () => {
            expect(await veToken.hasRole(await veToken.DEFAULT_ADMIN_ROLE(), wallet.address)).to.be.true;
            expect(await veToken.hasRole(MANAGER_ROLE, wallet.address)).to.be.true;
        });

        it("Should initialize with correct parameters", async () => {
            expect(await veToken.stakeToken()).to.equal(token.address);
            expect(await veToken.penaltyReceiver()).to.equal(wallet.address);
            expect(await veToken.startTime()).to.equal(startTime);
        });
    });

    describe("Lock", () => {
        it("Should create lock position correctly");
        it("Should fail if amount is too small");
        it("Should fail if lock period exceeds max weeks");
        it("Should fail if account already has locked position");
        it("Should update global state correctly");
    });

    describe("Relock", () => {
        it("Should relock expired position");
        it("Should fail if position is not expired");
        it("Should fail if no previous position exists");
    });

    describe("Claim", () => {
        it("Should allow claiming after lock period");
        it("Should fail claiming during lock period");
        it("Should handle early claim with penalty");
        it("Should fail claiming with zero balance");
    });

    describe("Auto Lock", () => {
        it("Should enable auto lock correctly");
        it("Should disable auto lock correctly");
        it("Should handle penalties differently for auto locked positions");
    });

    describe("Balance and Supply", () => {
        it("Should calculate balance correctly over time");
        it("Should calculate total supply correctly");
        it("Should track locked amounts accurately");
    });

    describe("Admin Functions", () => {
        it("Should allow penalty receiver change by admin");
        it("Should allow penalty withdrawal by manager");
        it("Should enforce role restrictions");
    });

    async function mineBlockAtTime(timestamp: number) {
        await network.provider.send("evm_mine", [timestamp]);
    }

    async function increaseTime(seconds: number) {
        await network.provider.send("evm_increaseTime", [seconds]);
        await network.provider.send("evm_mine", []);
    }
});