// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./libraries/TransferHelper.sol";
import "./interfaces/ISwap.sol";

/**
 * @title Swap Contract
 * @notice A token swap contract that enables fixed-ratio token exchanges
 * Supports both ERC20 tokens and native ETH
 * Uses OpenZeppelin upgradeable patterns for proxy deployment
 * Implements access control for administrative functions
 * Protected against reentrancy attacks
 */
contract Swap is ISwap, AccessControl, ReentrancyGuard, Pausable {
    // Role definitions
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    // State variables
    address public fromToken; // Source token address (address(0) for ETH)
    address public toToken; // Destination token address (address(0) for ETH)
    uint256 public ratio; // Exchange ratio (scaled by 1e18)

    receive() external payable {}

    /**
     * @notice Initializes the contract with initial parameters
     * @param admin Address that will have admin role
     * @param manager Address that will have manager role
     * @param fromToken_ Address of source token (address(0) for ETH)
     * @param toToken_ Address of destination token (address(0) for ETH)
     * @param ratio_ Initial exchange ratio (scaled by 1e18)
     */
    constructor(address admin, address manager, address fromToken_, address toToken_, uint256 ratio_) {
        require(admin != address(0), "Swap: admin cannot be zero address");
        require(manager != address(0), "Swap: manager cannot be zero address");
        require(fromToken_ != toToken_, "Swap: tokens cannot be identical");

        _setupRole(DEFAULT_ADMIN_ROLE, admin);
        _setupRole(ADMIN_ROLE, admin);
        _setupRole(MANAGER_ROLE, manager);

        fromToken = fromToken_;
        toToken = toToken_;
        ratio = ratio_;
    }

    /**
     * @notice Sets new exchange ratio
     * @param ratio_ New ratio value (scaled by 1e18)
     * @return bool Success indicator
     */
    function setRatio(uint256 ratio_) external onlyRole(MANAGER_ROLE) returns (bool) {
        uint256 oldRatio = ratio;
        ratio = ratio_;

        emit RatioUpdated(msg.sender, oldRatio, ratio_);
        return true;
    }

    /**
     * @notice Executes token swap
     * @param to Recipient address
     * @param amount Amount of source tokens to swap
     * @return bool Success indicator
     */
    function swap(address to, uint256 amount) external payable nonReentrant whenNotPaused returns (bool) {
        require(to != address(0), "Swap: recipient cannot be zero address");
        require(amount > 0, "Swap: amount must be greater than 0");

        uint256 toTokenAmount = (amount * ratio) / 1e18;
        require(toTokenAmount > 0, "Swap: output amount is 0");

        if (fromToken == address(0)) {
            // ETH -> Token
            require(msg.value == amount, "Swap: incorrect ETH amount");
            require(IERC20(toToken).balanceOf(address(this)) >= toTokenAmount, "Swap: insufficient token balance");

            TransferHelper.safeTransfer(IERC20(toToken), to, toTokenAmount);
        } else if (toToken == address(0)) {
            // Token -> ETH
            require(msg.value == 0, "Swap: ETH not accepted");
            require(address(this).balance >= toTokenAmount, "Swap: insufficient ETH balance");

            TransferHelper.safeTransferFrom(IERC20(fromToken), msg.sender, address(this), amount);
            TransferHelper.safeTransferETH(to, toTokenAmount);
        } else {
            // Token -> Token
            require(msg.value == 0, "Swap: ETH not accepted");
            require(IERC20(toToken).balanceOf(address(this)) >= toTokenAmount, "Swap: insufficient token balance");

            TransferHelper.safeTransferFrom(IERC20(fromToken), msg.sender, address(this), amount);
            TransferHelper.safeTransfer(IERC20(toToken), to, toTokenAmount);
        }

        emit SwapExecuted(msg.sender, fromToken, toToken, ratio, amount, toTokenAmount);
        return true;
    }

    /**
     * @notice Withdraws tokens from contract
     * @param token Token address (address(0) for ETH)
     * @param to Recipient address
     * @param amount Amount to withdraw
     * @return bool Success indicator
     */
    function withdraw(address token, address to, uint256 amount) external onlyRole(MANAGER_ROLE) returns (bool) {
        require(to != address(0), "Swap: recipient cannot be zero address");
        require(amount > 0, "Swap: amount must be greater than 0");

        if (token == address(0)) {
            require(address(this).balance >= amount, "Swap: insufficient ETH balance");
            TransferHelper.safeTransferETH(to, amount);
        } else {
            require(IERC20(token).balanceOf(address(this)) >= amount, "Swap: insufficient token balance");
            TransferHelper.safeTransfer(IERC20(token), to, amount);
        }

        emit WithdrawExecuted(msg.sender, token, to, amount);
        return true;
    }

    /**
     * @notice Pauses contract operations
     */
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses contract operations
     */
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
