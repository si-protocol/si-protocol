## Table of Contents
- [Project Overview](#project-overview)
- [System Architecture](#system-architecture)
- [Core Contracts](#core-contracts)
  - [Token Swap Contract](#token-swap-contract)
  - [Staking Pool Contract](#staking-pool-contract)
  - [Voting Rights Contract](#voting-rights-contract)
  - [Reward Distribution Contract](#reward-distribution-contract)
- [System Security](#system-security)
- [Governance Mechanism](#governance-mechanism)

## Project Overview

This project implements a complete token governance ecosystem, including core functionalities such as token swapping, staking mining, governance voting, and reward distribution. The system operates through the collaboration of multiple smart contracts, providing users with comprehensive DeFi features and governance participation mechanisms.

## System Architecture

The project consists of four core contracts:
- Token Swap Contract (Swap): Provides token exchange functionality, supporting swaps between ETH and ERC20 tokens
- Staking Pool Contract (StakingPool): Manages user token staking, offering flexible staking periods and yield distribution
- Voting Rights Contract (VeToken): Implements a voting weight system based on lock-up time
- Reward Distribution Contract (VeTokenDistributor): Responsible for distributing ecosystem rewards based on voting weight

Main interactions between contracts:
- StakingPool and Swap: Users can obtain tokens for staking through Swap
- VeToken and StakingPool: Staked tokens can be used to obtain voting weight
- VeTokenDistributor and VeToken: Distributes rewards based on voting weight

## Core Contracts

### Token Swap Contract

#### Contract Overview

The Swap contract implements a fixed-rate token exchange functionality, supporting bidirectional exchanges between ERC20 tokens and ETH. The contract is deployed using a proxy pattern and includes permission control and security protection mechanisms.

#### Permission System

The contract implements two-level permission control:
- ADMIN_ROLE: System administrator, can pause/resume contract
- MANAGER_ROLE: Operations manager, can adjust exchange rates and withdraw funds

#### Economic Model

- Exchange Mechanism: Uses fixed exchange rates for token swaps
- Rate Precision: Ratios are scaled with 1e18 as base
- Supported Types:
  - ERC20 token → ERC20 token
  - ERC20 token → ETH
  - ETH → ERC20 token

#### Core Functions

##### Token Exchange
```solidity
function swap(address to, uint256 amount) external payable nonReentrant whenNotPaused returns (bool)
```
- Function Description: Executes token exchange operation
- Parameters:
  - to: Address receiving tokens
  - amount: Amount of tokens to exchange
- Requirements:
  - Input amount must be greater than 0
  - Contract must have sufficient output token balance

##### Rate Setting
```solidity
function setRatio(uint256 ratio_) external onlyRole(MANAGER_ROLE) returns (bool)
```
- Function Description: Sets token exchange ratio
- Parameters: ratio_ is the new exchange ratio (based on 1e18)
- Permission: Only callable by MANAGER_ROLE

##### Fund Withdrawal
```solidity
function withdraw(address token, address to, uint256 amount) external onlyRole(MANAGER_ROLE) returns (bool)
```
- Function Description: Withdraws tokens or ETH from contract
- Parameters:
  - token: Token address (address(0) for ETH)
  - to: Receiving address
  - amount: Withdrawal amount
- Permission: Only callable by MANAGER_ROLE

##### Emergency Controls
```solidity
function pause() external onlyRole(ADMIN_ROLE)
function unpause() external onlyRole(ADMIN_ROLE)
```
- Function Description: Pause/resume contract functionality
- Permission: Only callable by ADMIN_ROLE

### Staking Pool Contract

#### Contract Overview

The StakingPool contract implements a flexible token staking system, supporting multi-term staking and block-based reward distribution. The contract uses a share-based staking mechanism to ensure fair distribution and implements differentiated unlock ratios for different lock periods.

#### Permission System

The contract implements two-level permission control:
- ADMIN_ROLE: System administrator, can set unlock ratios, reward rates, and other core parameters
- MANAGER_ROLE: Operations manager, can perform emergency withdrawals

#### Economic Model

- Staking Mechanism:
  - Users receive share certificates for staked tokens
  - Share price = Total staked amount / Total shares
  - Shares are transferable but locked during lock period

- Unlock Mechanism:
  - 1-week lock period: 95% unlock ratio
  - 4-week lock period: 100% unlock ratio
  - Unlock ratios adjustable by administrator

- Reward System:
  - Fixed rewards per block
  - Rewards automatically added to total staking pool
  - Users receive rewards proportional to their shares

#### Core Functions

##### Token Staking
```solidity
function stake(uint256 amount) external nonReentrant whenNotPaused returns (uint256 shares)
```
- Function Description: Stake tokens to receive share certificates
- Parameters: amount is the number of tokens to stake
- Returns: Number of shares received
- Requirements: Stake amount must be greater than 0

##### Unstake Request
```solidity
function requestUnstake(uint256 shares, uint256 duration) external nonReentrant whenNotPaused
```
- Function Description: Request to unlock staked shares
- Parameters:
  - shares: Number of shares to unlock
  - duration: Lock period (WEEK_1 or WEEK_4)
- Requirements:
  - Share amount must be greater than 0
  - User must have sufficient available shares

##### Withdraw Stakes
```solidity
function batchUnstake() external nonReentrant whenNotPaused returns (uint256 redeemedAmount)
```
- Function Description: Withdraw all matured staking requests
- Returns: Amount of tokens successfully withdrawn
- Conditions: Must wait for lock period to end

##### Share Transfer
```solidity
function transfer(address to, uint256 amount) public virtual override returns (bool)
function transferFrom(address from, address to, uint256 amount) public virtual override returns (bool)
```
- Function Description: Transfer unlocked staking shares
- Restriction: Locked shares cannot be transferred

##### Management Functions
```solidity
function setUnlockRatio(uint256 duration, uint256 ratio) external onlyRole(ADMIN_ROLE)
function setRewardPerBlock(uint256 _rewardPerBlock) external onlyRole(ADMIN_ROLE)
function setVault(address _vault) external onlyRole(ADMIN_ROLE)
```
- Function Description: Set system parameters
- Permission: Only callable by ADMIN_ROLE

### Voting Rights Contract

#### Contract Overview

The VeToken contract implements a time-locked voting rights token system. Users receive voting weight by locking base tokens, with weight decaying over time, supporting flexible lock periods and automatic renewal mechanisms.

#### Permission System

The contract implements two-level permission control:
- DEFAULT_ADMIN_ROLE: Administrator, can set penalty receiving address
- MANAGER role: Manager, can withdraw accumulated penalties

#### Economic Model

- Lock Mechanism:
  - Minimum lock amount: 0.01 base tokens
  - Maximum lock period: 52 weeks
  - Voting weight = Locked amount × Remaining lock weeks

- Penalty Mechanism:
  - Early unlock penalty: (Locked amount × Remaining weeks) / 52
  - Penalties go to designated receiving address
  - Early unlocks under auto-lock also incur penalties

#### Core Functions

##### Token Locking
```solidity
function lock(uint256 amount, uint16 week, bool autoLock) external
```
- Function Description: Lock tokens to receive voting weight
- Parameters:
  - amount: Amount of tokens to lock
  - week: Number of weeks to lock
  - autoLock: Whether to enable automatic renewal
- Requirements:
  - Lock amount ≥ 0.01
  - Only one lock position per address

##### Increase Lock
```solidity
function increaseAmount(uint256 amount) external
function increaseWeek(uint16 week) external
```
- Function Description: Increase locked amount or time
- Requirement: Must be within lock period

##### Unlock and Withdraw
```solidity
function claim() external returns (uint256)
function claimEarly() external returns (uint256)
```
- Function Description: Withdraw locked tokens
- Difference:
  - claim: Normal withdrawal after maturity
  - claimEarly: Early withdrawal with penalty

##### Auto-Lock Control
```solidity
function enableAutoLock() external
function disableAutoLock() external
```
- Function Description: Control auto-renewal status
- Note: Once enabled, can only unlock through early withdrawal

### Reward Distribution Contract

#### Contract Overview

The VeTokenDistributor contract manages and distributes reward tokens to veToken holders. It uses a week-based distribution mechanism, allocating rewards proportionally based on users' voting weight, supporting both confirmed and estimated reward calculations.

#### Permission System

The contract implements two-level permission control:
- DEFAULT_ADMIN_ROLE: Administrator role
- MANAGER role: Can set vault address and withdraw tokens

#### Economic Model

- Distribution Mechanism:
  - Weekly reward distribution
  - Reward ratio = Individual weight / Total weight
  - Supports accumulating multiple weeks for claims

- Reward Source:
  - Retrieved from designated vault contract
  - Weekly reward amounts calculated independently
  - Real-time tracking of vault balance changes

#### Core Functions

##### Reward Claiming
```solidity
function claim(address to) external
```
- Function Description: Claim accumulated reward tokens
- Parameters: to is the address receiving rewards
- Process:
  - Update checkpoint
  - Calculate claimable amount
  - Transfer rewards from vault

##### Reward Queries
```solidity
function getClaimable(address account) public view returns (uint256, uint256)
function estimateClaimable(address account) public view returns (uint256)
```
- Function Description: Query claimable reward amounts
- Difference:
  - getClaimable: Confirmed rewards
  - estimateClaimable: Includes estimated rewards

##### Checkpoint Update
```solidity
function checkPoint() external
```
- Function Description: Manually trigger checkpoint update
- Updates:
  - Current week's total rewards
  - Vault balance record
  - Last updated week

##### Management Functions
```solidity
function setupVault(address vault_) external onlyRole(MANAGER)
function withdraw(address token, uint256 amount) external onlyRole(MANAGER)
```
- Function Description: System parameter management
- Permission: Only executable by MANAGER

## System Security

All contracts implement multiple security protection mechanisms:
1. Upgradeable Design: All core contracts are deployed in upgradeable mode
2. Access Control: Implements role-based access control
3. Reentrancy Protection: Critical operations are protected by reentrancy guards
4. Pause Mechanism: Operations can be paused in emergencies
5. Data Validation: Complete input and state checks
6. Amount Verification: Strict numerical calculations and validation

## Governance Mechanism

The system implements a unified permission management system:
1. ADMIN Role Responsibilities:
   - System parameter settings
   - Emergency operation control
   - Contract upgrade management

2. MANAGER Role Responsibilities:
   - Daily operations management
   - Fund operation execution
   - Yield parameter adjustment

3. Regular User Permissions:
   - Token exchange operations
   - Staking and unlocking operations
   - Voting rights management
   - Reward claim operations