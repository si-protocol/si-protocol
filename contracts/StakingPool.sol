// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IStakingPool.sol";

/**
 * @title StakingPool
 * @notice An upgradeable staking contract that supports:
 * - Multiple staking periods with flexible unlock schedules
 * - Block-based reward distribution
 * - Share-based staking mechanism for fair reward distribution
 * - Role-based access control for admin functions
 */
contract StakingPool is
    Initializable,
    ERC20Upgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IStakingPool
{
    using SafeERC20 for IERC20;

    // Role definitions
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    uint256 public constant WEEK_1 = 1 weeks;
    uint256 public constant WEEK_4 = 4 weeks;

    IERC20 public token;
    uint256 public totalShares;
    uint256 public totalStaked;
    uint256 public lastCheckpoint;
    uint256 public rewardPerBlock;
    address public vault;

    mapping(uint256 => uint256) public unlockRatio;
    mapping(address => UnstakeRequest[]) public unstakeRequests;
    mapping(address => uint256) public lockedShares;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the staking pool with initial parameters
     * @param _manager Address of the token to be staked
     * @param _token Address of the token to be staked
     * @param _vault Address of the reward vault
     * @param _rewardPerBlock Number of tokens distributed as reward per block
     */
    function initialize(address _manager, address _token, address _vault, uint256 _rewardPerBlock) public initializer {
        if (_token == address(0)) revert InvalidAddress();
        if (_vault == address(0)) revert InvalidAddress();

        __ERC20_init("Stake Token", "STK");
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(ADMIN_ROLE, msg.sender);
        _setupRole(MANAGER_ROLE, _manager);

        token = IERC20(_token);
        vault = _vault;
        rewardPerBlock = _rewardPerBlock;

        unlockRatio[WEEK_1] = 95; // 95%
        unlockRatio[WEEK_4] = 100; // 100%
    }

    /**
     * @notice Stakes tokens in the pool
     * Mints shares based on the current share price (totalShares/totalStaked ratio)
     * Updates rewards before processing the stake
     * @param amount Amount of tokens to stake
     * @return shares Number of shares minted for the staked amount
     */
    function stake(uint256 amount) external nonReentrant whenNotPaused returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();

        _checkpoint();

        shares = _getShares(amount);
        if (shares == 0) revert ZeroAmount();

        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        totalStaked += amount;
        totalShares += shares;
        _mint(msg.sender, shares);

        emit Staked(msg.sender, shares, amount);
        return shares;
    }

    /**
     * @notice Initiates an unstake request
     * Tokens will be locked for the specified duration and can be redeemed after unlockTime
     * Different durations have different unlock ratios (e.g., 1 week = 95%, 4 weeks = 100%)
     * @param shares Number of shares to unstake
     * @param duration Lock duration (must be WEEK_1 or WEEK_4)
     */
    function requestUnstake(uint256 shares, uint256 duration) external nonReentrant whenNotPaused {
        if (shares == 0) revert ZeroAmount();
        if (duration != WEEK_1 && duration != WEEK_4) revert InvalidDuration();
        if (balanceOf(msg.sender) < shares) revert InsufficientBalance();

        _checkpoint();

        uint256 unlockTime = block.timestamp + duration;
        uint256 ratio = unlockRatio[duration];

        lockedShares[msg.sender] += shares;
        unstakeRequests[msg.sender].push(
            UnstakeRequest({shares: shares, unlockTime: unlockTime, ratio: ratio, processed: false})
        );

        emit UnstakeRequested(msg.sender, shares, unlockTime);
    }

    /**
     * @notice Processes all matured unstake requests for the caller
     * Only processes requests that have passed their unlock time
     * Returns tokens based on the unlock ratio specified in each request
     * @return redeemedAmount Total amount of tokens redeemed
     */
    function batchUnstake() external nonReentrant whenNotPaused returns (uint256 redeemedAmount) {
        UnstakeRequest[] storage requests = unstakeRequests[msg.sender];

        _checkpoint();

        uint256 initialShares = totalShares;
        uint256 initialStaked = totalStaked;
        uint256 sharesRedeemed;

        for (uint256 i = 0; i < requests.length; i++) {
            UnstakeRequest storage request = requests[i];

            if (request.processed || block.timestamp < request.unlockTime) {
                continue;
            }

            uint256 tokenAmount = (request.shares * initialStaked) / initialShares;
            uint256 finalAmount = (tokenAmount * request.ratio) / 100;

            redeemedAmount += finalAmount;
            sharesRedeemed += request.shares;
            request.processed = true;
        }

        if (redeemedAmount > 0) {
            lockedShares[msg.sender] -= sharesRedeemed;
            totalShares -= sharesRedeemed;
            totalStaked -= redeemedAmount;

            _burn(msg.sender, sharesRedeemed);

            if (!token.transfer(msg.sender, redeemedAmount)) revert TransferFailed();
            emit Unstaked(msg.sender, redeemedAmount);
        }

        return redeemedAmount;
    }

    function transfer(
        address to,
        uint256 amount
    ) public virtual override(ERC20Upgradeable, IERC20Upgradeable) returns (bool) {
        if (balanceOf(msg.sender) < amount) revert InsufficientBalance();
        return super.transfer(to, amount);
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override(ERC20Upgradeable, IERC20Upgradeable) returns (bool) {
        if (balanceOf(from) < amount) revert InsufficientBalance();
        return super.transferFrom(from, to, amount);
    }

    /**
     * @notice Returns the total number of shares that are ready to be unstaked
     * @param user Address of the user
     * @return redeemableShares Number of shares that can be unstaked
     */
    function getRedeemableShares(address user) external view returns (uint256 redeemableShares) {
        UnstakeRequest[] storage requests = unstakeRequests[user];

        for (uint256 i = 0; i < requests.length; i++) {
            UnstakeRequest storage request = requests[i];
            if (!request.processed && block.timestamp >= request.unlockTime) {
                redeemableShares += request.shares;
            }
        }
    }

    /**
     * @notice Returns the available (unlocked) balance of shares for an account
     * @param account Address of the account
     * @return Available balance (total balance minus locked shares)
     */
    function balanceOf(
        address account
    ) public view virtual override(ERC20Upgradeable, IERC20Upgradeable) returns (uint256) {
        return super.balanceOf(account) - lockedShares[account];
    }

    /**
     * @notice Returns the total balance of shares for an account including locked shares
     * @param account Address of the account
     * @return Total number of shares owned by the account
     */
    function totalSharesOf(address account) public view returns (uint256) {
        return super.balanceOf(account);
    }

    /**
     * @notice Updates the unlock ratio for a specific duration
     * @param duration Lock duration
     * @param ratio New unlock ratio (must be <= 100)
     */
    function setUnlockRatio(uint256 duration, uint256 ratio) external onlyRole(ADMIN_ROLE) {
        if (ratio > 100) revert InvalidRatio();
        unlockRatio[duration] = ratio;
        emit RatioUpdated(duration, ratio);
    }

    /**
     * @notice Updates the reward rate per block
     * @param _rewardPerBlock New reward amount per block
     */
    function setRewardPerBlock(uint256 _rewardPerBlock) external onlyRole(ADMIN_ROLE) {
        rewardPerBlock = _rewardPerBlock;
        emit RewardRateUpdated(_rewardPerBlock);
    }

    /**
     * @notice Updates the vault address used for reward distribution
     * @param _vault New vault address
     */
    function setVault(address _vault) external onlyRole(ADMIN_ROLE) {
        if (_vault == address(0)) revert InvalidAddress();
        vault = _vault;
        emit VaultUpdated(_vault);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Emergency function to withdraw any tokens from the contract
     * Only callable by admin role
     * @param tokenAddress Address of the token to withdraw
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address tokenAddress, uint256 amount) external onlyRole(MANAGER_ROLE) {
        if (!IERC20(tokenAddress).transfer(msg.sender, amount)) revert TransferFailed();
    }

    /**
     * @notice Updates reward checkpoint and distributes pending rewards
     * Calculates rewards based on blocks passed since last checkpoint
     * Transfers rewards from vault to contract
     */
    function _checkpoint() internal {
        uint256 currentBlock = block.number;
        if (currentBlock <= lastCheckpoint) return;

        uint256 reward;
        if (lastCheckpoint > 0) {
            uint256 blockDelta = currentBlock - lastCheckpoint;
            reward = blockDelta * rewardPerBlock;
        }

        if (reward > 0 && vault != address(0)) {
            if (!token.transferFrom(vault, address(this), reward)) revert TransferFailed();
            totalStaked += reward;
        }

        lastCheckpoint = currentBlock;
        emit RewardAdded(currentBlock, reward);
    }

    /**
     * @notice Calculates the number of shares to mint for a given token amount
     * Uses the current share price (totalShares/totalStaked ratio)
     * @param amount Amount of tokens
     * @return Number of shares
     */
    function _getShares(uint256 amount) internal view returns (uint256) {
        if (totalStaked == 0 || totalShares == 0) return amount;
        return (amount * totalShares) / totalStaked;
    }
}
