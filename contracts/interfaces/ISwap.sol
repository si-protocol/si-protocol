// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

interface ISwap {
    // Events
    event SwapExecuted(
        address indexed caller,
        address indexed fromToken,
        address indexed toToken,
        uint256 ratio,
        uint256 fromAmount,
        uint256 toAmount
    );
    event WithdrawExecuted(address indexed caller, address indexed token, address indexed recipient, uint256 amount);
    event RatioUpdated(address indexed manager, uint256 oldRatio, uint256 newRatio);

    function swap(address to, uint256 amount) external payable returns (bool);

    // Manager functions
    function setRatio(uint256 ratio_) external returns (bool);

    function withdraw(address token, address to, uint256 amount) external returns (bool);

    // Admin functions
    function pause() external;

    function unpause() external;

    // View functions
    function ratio() external view returns (uint256);
}
