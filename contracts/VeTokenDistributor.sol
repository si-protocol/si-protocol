// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IVeToken.sol";

/**
 * @title VeTokenDistributor
 * @notice Manages the distribution of reward tokens to veToken holders based on their weekly balances
 * @dev Uses OpenZeppelin's upgradeable pattern and access control
 */
contract VeTokenDistributor is Initializable, AccessControlUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant MANAGER = keccak256("MANAGER");

    address public vault;
    uint16 public lastCheckpointWeek;
    uint256 public lastCheckpointBalance;

    IERC20 public rewardToken;
    IVeToken public veToken;

    // Amount of rewards distributed per week
    mapping(uint256 => uint256) public rewardPerWeek;

    // Last week when user claimed their rewards
    mapping(address => uint16) public lastClaimedWeek;

    event Claim(address account, address token, uint256 amount);
    event Withdraw(address token, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract with required addresses
     * @param manager_ Address with MANAGER role
     * @param vault_ Address holding reward tokens
     * @param rewardToken_ Address of the reward token
     * @param veToken_ Address of the veToken contract
     */
    function initialize(address manager_, address vault_, address rewardToken_, address veToken_) external initializer {
        __AccessControl_init();
        require(manager_ != address(0), "Manager can not be zero address");
        require(vault_ != address(0), "Reward manager can not be zero address");
        require(rewardToken_ != address(0), "Reward token can not be zero address");
        require(veToken_ != address(0), "VeToken can not be zero address");

        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(MANAGER, manager_);

        vault = vault_;
        rewardToken = IERC20(rewardToken_);
        veToken = IVeToken(veToken_);
    }

    /**
     * @notice Updates the reward manager address
     * @param vault_ New reward manager address
     */
    function setupVault(address vault_) external onlyRole(MANAGER) {
        vault = vault_;
    }

    /**
     * @notice Claims available rewards for the caller
     * @param to Address to receive the rewards
     */
    function claim(address to) external {
        _checkpoint();

        (uint256 claimableAmount, ) = getClaimable(msg.sender);
        lastClaimedWeek[msg.sender] = lastCheckpointWeek;
        lastCheckpointBalance -= claimableAmount;

        rewardToken.safeTransferFrom(vault, to, claimableAmount);
        emit Claim(msg.sender, address(rewardToken), claimableAmount);
    }

    /**
     * @notice Manually triggers a checkpoint update
     */
    function checkPoint() external {
        _checkpoint();
    }

    /**
     * @notice Calculates confirmed claimable rewards for an account
     * @param account Address to check rewards for
     * @return Claimable amount and last checkpoint week
     */
    function getClaimable(address account) public view returns (uint256, uint256) {
        require(account != address(0), "Account can not be zero address");
        uint16 lastWeek = lastClaimedWeek[account];
        if (lastWeek == lastCheckpointWeek) return (0, lastCheckpointWeek);

        if (lastWeek == 0) {
            IVeToken.AccountData memory accountData = veToken.getLockedData(account);
            lastWeek = accountData.lastLockWeek;
        }

        uint256 claimableAmount;
        for (uint16 i = lastWeek; i < lastCheckpointWeek; i++) {
            uint256 accountWeight = veToken.balanceOfAtWeek(account, i);
            uint256 totalWeight = veToken.totalSupplyAtWeek(i);
            if (accountWeight == 0 || rewardPerWeek[i] == 0 || accountWeight > totalWeight) continue;
            claimableAmount += (rewardPerWeek[i] * accountWeight * 1e18) / totalWeight;
        }

        return (claimableAmount / 1e18, lastCheckpointWeek);
    }

    /**
     * @notice Improved version of estimating claimable rewards
     * @dev Separates calculation logic into helper functions for better readability
     * @param account Address to estimate rewards for
     * @return Estimated claimable amount
     */
    function estimateClaimable(address account) public view returns (uint256) {
        require(account != address(0), "Account can not be zero address");
        uint16 currentWeek = veToken.getCurrentWeek();
        uint16 lastWeek = lastClaimedWeek[account];

        if (currentWeek == 0) return 0;
        if (lastWeek == lastCheckpointWeek && lastCheckpointWeek == currentWeek) return 0;

        if (lastWeek == 0) {
            IVeToken.AccountData memory accountData = veToken.getLockedData(account);
            lastWeek = accountData.lastLockWeek;
        }

        uint256 claimableAmount;
        if (lastWeek < lastCheckpointWeek && lastCheckpointWeek == currentWeek) {
            // Case 1: Calculate verified rewards only
            claimableAmount = _calculateConfirmedRewards(account, lastWeek, lastCheckpointWeek);
        } else if (lastWeek < lastCheckpointWeek && lastCheckpointWeek < currentWeek) {
            // Case 2: Calculate both verified rewards and estimated rewards
            claimableAmount = _calculateConfirmedRewards(account, lastWeek, lastCheckpointWeek);
            claimableAmount += _calculateEstimatedRewards(account, lastCheckpointWeek, currentWeek);
        } else if (lastWeek == lastCheckpointWeek && lastCheckpointWeek < currentWeek) {
            // Case 3: Calculate estimated rewards only
            claimableAmount = _calculateEstimatedRewards(account, lastCheckpointWeek, currentWeek);
        }

        return claimableAmount / 1e18;
    }

    /**
     * @notice Calculates claimable rewards for a specific week
     * @param account Address to check rewards for
     * @param week Week number to check
     * @return amount Claimable amount for the specified week
     */
    function getClaimableAtWeek(address account, uint16 week) external view returns (uint256 amount) {
        uint256 accountWeight = veToken.balanceOfAtWeek(account, week);
        if (accountWeight == 0) {
            return 0;
        }

        uint256 totalWeight = veToken.totalSupplyAtWeek(week);
        if (totalWeight == 0) {
            return 0;
        }

        amount = (rewardPerWeek[week] * accountWeight) / totalWeight;
        return amount;
    }

    /**
     * @notice Allows manager to withdraw tokens from the contract
     * @param token Token address to withdraw
     * @param amount Amount to withdraw
     */
    function withdraw(address token, uint256 amount) external onlyRole(MANAGER) {
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdraw(token, amount);
    }

    /**
     * @notice Internal function to update reward state to current week
     * @dev Updates rewardPerWeek mapping based on increased balance
     */
    function _checkpoint() internal {
        uint16 currentWeek = veToken.getCurrentWeek();
        uint256 currentBalance = rewardToken.balanceOf(vault);

        if (lastCheckpointWeek == currentWeek) {
            return;
        } else if (lastCheckpointWeek < currentWeek) {
            uint256 increasedBalance;
            if (currentBalance > lastCheckpointBalance) {
                increasedBalance = currentBalance - lastCheckpointBalance;
            }

            if (lastCheckpointWeek + 1 == currentWeek) {
                rewardPerWeek[lastCheckpointWeek] = increasedBalance;
            } else {
                uint256 calculatedWeight;
                for (uint16 i = lastCheckpointWeek; i < currentWeek; i++) {
                    calculatedWeight += veToken.totalSupplyAtWeek(i);
                }

                if (calculatedWeight == 0) {
                    calculatedWeight = 1;
                }

                for (uint16 i = lastCheckpointWeek; i < currentWeek; i++) {
                    uint256 weekWeight = veToken.totalSupplyAtWeek(i);
                    uint256 rewardWeek = (weekWeight * increasedBalance) / calculatedWeight;
                    rewardPerWeek[i] = rewardWeek;
                }
            }
        }

        lastCheckpointWeek = currentWeek;
        lastCheckpointBalance = currentBalance;
    }

    function _calculateEstimatedRewards(
        address account,
        uint16 fromWeek,
        uint16 toWeek
    ) internal view returns (uint256) {
        uint256 lastBalance = rewardToken.balanceOf(vault);
        if (lastBalance <= lastCheckpointBalance) {
            return 0;
        }

        uint256 increasedBalance = lastBalance - lastCheckpointBalance;
        uint256 calculatedWeight;

        // Compute the sum of weights for the target period range
        for (uint16 i = fromWeek; i < toWeek; i++) {
            calculatedWeight += veToken.totalSupplyAtWeek(i);
        }

        if (calculatedWeight == 0) {
            return 0;
        }

        uint256 estimatedAmount;
        // Distribute incremental rewards according to weekly weighting ratios
        for (uint16 i = fromWeek; i < toWeek; i++) {
            uint256 accountWeight = veToken.balanceOfAtWeek(account, i);
            uint256 weekWeight = veToken.totalSupplyAtWeek(i);
            if (accountWeight == 0 || weekWeight == 0 || accountWeight > weekWeight) continue;

            uint256 weekReward = (weekWeight * increasedBalance) / calculatedWeight;
            estimatedAmount += (weekReward * accountWeight * 1e18) / weekWeight;
        }

        return estimatedAmount;
    }

    function _calculateConfirmedRewards(
        address account,
        uint16 fromWeek,
        uint16 toWeek
    ) internal view returns (uint256) {
        uint256 confirmedAmount;
        for (uint16 i = fromWeek; i <= toWeek; ++i) {
            uint256 accountWeight = veToken.balanceOfAtWeek(account, i);
            uint256 totalWeight = veToken.totalSupplyAtWeek(i);
            if (accountWeight == 0 || totalWeight == 0 || rewardPerWeek[i] == 0 || accountWeight > totalWeight)
                continue;
            confirmedAmount += (rewardPerWeek[i] * accountWeight * 1e18) / totalWeight;
        }
        return confirmedAmount;
    }
}
