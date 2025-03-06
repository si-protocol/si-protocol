// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStakingPool is IERC20Upgradeable {
    // Errors
    error ZeroAmount();
    error InvalidDuration();
    error InsufficientBalance(); 
    error TransferFailed();
    error InvalidRatio();
    error InvalidAddress();
    error NoAvailableStakes();

    // Events
    event Staked(address indexed user, uint256 shares, uint256 amount);
    event UnstakeRequested(address indexed user, uint256 shares, uint256 unlockTime);
    event Unstaked(address indexed user, uint256 amount);
    event RewardAdded(uint256 blockNumber, uint256 reward);
    event RatioUpdated(uint256 duration, uint256 ratio);
    event RewardRateUpdated(uint256 newRate);
    event VaultUpdated(address newVault);

    // Structs
    struct UnstakeRequest {
        uint256 shares;
        uint256 unlockTime;
        uint256 ratio;
        bool processed;
    }
    
    // Core functions
    function stake(uint256 amount) external returns (uint256 shares);
    function requestUnstake(uint256 shares, uint256 duration) external;
    function batchUnstake() external returns (uint256 redeemedAmount);

    // View functions
    function getRedeemableShares(address user) external view returns (uint256 redeemableShares);
    function totalSharesOf(address account) external view returns (uint256);
    function unstakeRequests(address account, uint256 index) external view returns (uint256 shares, uint256 unlockTime, uint256 ratio, bool processed);
    function lockedShares(address account) external view returns (uint256);
    function totalShares() external view returns (uint256);
    function totalStaked() external view returns (uint256);
    function lastCheckpoint() external view returns (uint256);
    function rewardPerBlock() external view returns (uint256);
    function vault() external view returns (address);
    function token() external view returns (IERC20);
    function unlockRatio(uint256 duration) external view returns (uint256);

    // Admin functions
    function setUnlockRatio(uint256 duration, uint256 ratio) external;
    function setRewardPerBlock(uint256 _rewardPerBlock) external;
    function setVault(address _vault) external;
    function pause() external;
    function unpause() external;
    function emergencyWithdraw(address tokenAddress, uint256 amount) external;

    // Constants
    function ADMIN_ROLE() external view returns (bytes32);
    function MANAGER_ROLE() external view returns (bytes32);
    function WEEK_1() external view returns (uint256);
    function WEEK_4() external view returns (uint256);
}