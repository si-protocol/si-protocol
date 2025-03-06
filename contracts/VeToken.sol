// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IVeToken, IERC20} from "./interfaces/IVeToken.sol";

contract VeToken is IVeToken, Initializable, AccessControlUpgradeable {
    using SafeERC20 for IERC20;

    uint256 public constant decimals = 18;
    bytes32 public constant MANAGER = keccak256("MANAGER");
    uint16 public constant MAX_LOCK_WEEKS = 52;
    string public constant name = "Vote-escrowed Token";
    string public constant symbol = "VToken";

    uint256 public startTime;
    uint256 public totalPenalty;
    address public penaltyReceiver;

    IERC20 public stakeToken;

    LockedData[65535] public totalLockedData;
    uint256[65535] public totalUnlockedData;
    mapping(address => AccountData) public accountData;
    mapping(address => LockedData[]) public accountLockedData;

    uint16 private _lastUpdateTotalWeek;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address manager_,
        uint256 startTime_,
        address stakeToken_,
        address penaltyReceiver_
    ) external initializer {
        require(manager_ != address(0), "Manager can not be zero address");
        require(stakeToken_ != address(0), "Stake token can not be zero address");
        require(penaltyReceiver_ != address(0), "Penalty receiver can not be zero address");
        // require(startTime_ > block.timestamp, "The start time must be in the future");
        __AccessControl_init();

        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(MANAGER, manager_);

        startTime = startTime_;
        stakeToken = IERC20(stakeToken_);
        penaltyReceiver = penaltyReceiver_;
    }

    /**
     * @notice Set penalty receiver
     */
    function setPenaltyReceiver(address penaltyReceiver_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(penaltyReceiver_ != address(0) && penaltyReceiver_ != penaltyReceiver, "Inalid new address");

        penaltyReceiver = penaltyReceiver_;
        emit PenaltyReceiverChanged(penaltyReceiver_);
    }

    /**
     * @notice Create a new lock and receive veToken as return
     * @param amount Amount of token to lock
     * @param week Number of weeks to lock
     * @param autoLock Auto lock status
     */
    function lock(uint256 amount, uint16 week, bool autoLock) external {
        require(amount >= 1e16, "Lock amount must be greater or equal than 0.01");
        require(accountData[msg.sender].locked == 0, "There is already lock position");

        _createLock(msg.sender, amount, week, autoLock);

        stakeToken.transferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Relock token
     * @param week the number of weeks to extend the lock
     * @param autoLock auto lock status
     */
    function relockUnclaimed(uint16 week, bool autoLock) external {
        require(balanceOf(msg.sender) == 0, "Thers is already lock position");

        AccountData memory _accountData = accountData[msg.sender];
        require(_accountData.locked > 0, "Zero amount of token can be relock");
        require(
            block.timestamp >= _accountData.lockTimestamp + uint256(_accountData.lockWeeks) * 1 weeks,
            "Lock position has not expired"
        );

        _createLock(msg.sender, _accountData.locked, week, autoLock);
    }

    /**
     * @notice Increase locked amount
     * @notice The operation require the lock position is still in period
     * @param amount amount of token to increase
     */
    function increaseAmount(uint256 amount) external {
        uint256 balance = balanceOf(msg.sender);
        require(balance > 0, "Thers is no lock position");
        require(amount >= 1e16, "Lock amount must be greater or equal than 0.01");

        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        // Checkpoint before update the current state
        _checkpoint();
        uint16 currentWeek = _lastUpdateTotalWeek;

        // Update user lock state
        AccountData memory _accountData = accountData[msg.sender];
        _accountData.locked += amount;
        _accountData.lockTimestamp = block.timestamp;
        if (!_accountData.autoLock) {
            _accountData.lockWeeks = _accountData.lastLockWeek + _accountData.lockWeeks - currentWeek;
            _accountData.lastLockWeek = currentWeek;
        }
        accountData[msg.sender] = _accountData;

        // Update the list of lock history
        uint256 newWeight = _accountData.locked * uint256(_accountData.lockWeeks);
        uint256 length = accountLockedData[msg.sender].length;
        LockedData memory lastAccountLockedData = accountLockedData[msg.sender][length - 1];
        if (lastAccountLockedData.week == currentWeek) {
            lastAccountLockedData.locked = _accountData.locked;
            lastAccountLockedData.weight = newWeight;
            lastAccountLockedData.autoLockAmount = _accountData.autoLock ? _accountData.locked : 0;
            accountLockedData[msg.sender][length - 1] = lastAccountLockedData;
        } else {
            accountLockedData[msg.sender].push(
                LockedData({
                    week: currentWeek,
                    locked: _accountData.locked,
                    weight: newWeight,
                    autoLockAmount: _accountData.autoLock ? _accountData.locked : 0
                })
            );
        }

        // Update the global lock state
        LockedData storage _totalLockedData = totalLockedData[currentWeek];
        _totalLockedData.locked += amount;
        _totalLockedData.weight += newWeight - balance;
        if (_accountData.autoLock) {
            _totalLockedData.autoLockAmount += amount;
        } else {
            totalUnlockedData[currentWeek + _accountData.lockWeeks] += amount;
        }

        emit LockAmountIncreased(msg.sender, amount);
    }

    /**
     * @notice Increase the number of lock week
     * @notice The operation require the lock position is still in period
     * @param week The number of week that will reset the old lock weeks
     */
    function increaseWeek(uint16 week) external {
        require(0 < week && week <= MAX_LOCK_WEEKS, "Invalid week");
        uint256 balance = balanceOf(msg.sender);
        require(balance > 0, "Thers is no lock position");

        // Checkpoint before update the current state
        _checkpoint();
        uint16 currentWeek = _lastUpdateTotalWeek;

        // Update user lock state
        AccountData memory _accountData = accountData[msg.sender];
        _accountData.lockTimestamp = block.timestamp;

        uint16 oldUnlockWeek = _accountData.lastLockWeek + _accountData.lockWeeks;
        uint16 increasedWeek;

        if (_accountData.autoLock) {
            require(week > _accountData.lockWeeks, "The number of new week must be greater than current");
            increasedWeek = week - _accountData.lockWeeks;
            _accountData.lockWeeks = week;
        } else {
            uint16 remainWeek = _accountData.lastLockWeek + _accountData.lockWeeks - currentWeek;
            require(week > remainWeek, "The number of new week must be greater than remain");
            increasedWeek = week - remainWeek;
            _accountData.lastLockWeek = currentWeek;
            _accountData.lockWeeks = week;
        }
        accountData[msg.sender] = _accountData;

        // Update the list of lock history
        uint256 length = accountLockedData[msg.sender].length;
        LockedData memory lastAccountLockedData = accountLockedData[msg.sender][length - 1];
        if (lastAccountLockedData.week == currentWeek) {
            lastAccountLockedData.weight = _accountData.locked * uint256(_accountData.lockWeeks);
            accountLockedData[msg.sender][length - 1] = lastAccountLockedData;
        } else {
            accountLockedData[msg.sender].push(
                LockedData({
                    week: currentWeek,
                    locked: _accountData.locked,
                    weight: _accountData.locked * uint256(_accountData.lockWeeks),
                    autoLockAmount: _accountData.autoLock ? _accountData.locked : 0
                })
            );
        }

        // Update the global lock state
        totalLockedData[currentWeek].weight += _accountData.locked * uint256(increasedWeek);
        if (!_accountData.autoLock) {
            totalUnlockedData[oldUnlockWeek] -= _accountData.locked;
            totalUnlockedData[_accountData.lastLockWeek + _accountData.lockWeeks] += _accountData.locked;
        }

        emit LockWeeksIncreased(msg.sender, week);
    }

    /**
     * @notice Claim the staked token when the lock period is over
     * @return uint256 The claimed amount
     */
    function claim() external returns (uint256) {
        AccountData storage _accountData = accountData[msg.sender];
        require(_accountData.locked > 0, "There locked position is zero");
        require(!_accountData.autoLock, "Can not claim the auto lock");
        require(
            block.timestamp >= _accountData.lockTimestamp + uint256(_accountData.lockWeeks) * 1 weeks,
            "The position is still in lock period"
        );

        _checkpoint();

        uint256 amount = _accountData.locked;
        _accountData.locked = 0;
        _accountData.lastLockWeek = 0;
        _accountData.lockWeeks = 0;
        _accountData.lockTimestamp = 0;

        stakeToken.safeTransfer(msg.sender, amount);

        emit Claimed(msg.sender, amount);
        return amount;
    }

    /**
     * @notice Claim tokens even if the lock is still ongoing, resulting in a penalty
     * @return uint256 The final claimed amount
     */
    function claimEarly() external returns (uint256) {
        AccountData memory _accountData = accountData[msg.sender];
        uint256 weight = balanceOf(msg.sender);
        uint16 unlockWeek = _accountData.lastLockWeek + _accountData.lockWeeks;

        require(
            _accountData.autoLock ||
                block.timestamp < _accountData.lockTimestamp + uint256(_accountData.lockWeeks) * 1 weeks,
            "Please call the function claim"
        );

        // Checkpoint before update the current state
        _checkpoint();
        uint16 currentWeek = _lastUpdateTotalWeek;

        // Calculate the penalty
        uint256 penalty;
        if (!_accountData.autoLock) {
            uint16 remainWeek = _accountData.lastLockWeek + _accountData.lockWeeks - currentWeek;
            if (remainWeek == 0) {
                remainWeek = 1;
            }
            penalty = (_accountData.locked * uint256(remainWeek)) / uint256(MAX_LOCK_WEEKS);
        } else {
            penalty = (_accountData.locked * uint256(_accountData.lockWeeks)) / uint256(MAX_LOCK_WEEKS);
        }
        totalPenalty += penalty;

        uint256 amount = _accountData.locked - penalty;

        // Update user lock state
        accountData[msg.sender] = AccountData({
            locked: 0,
            autoLock: false,
            lastLockWeek: 0,
            lockWeeks: 0,
            lockTimestamp: 0
        });

        // Update the list of lock history
        uint256 length = accountLockedData[msg.sender].length;
        LockedData memory lastAccountLockedData = accountLockedData[msg.sender][length - 1];
        if (lastAccountLockedData.week == currentWeek) {
            lastAccountLockedData.locked = 0;
            lastAccountLockedData.weight = 0;
            lastAccountLockedData.autoLockAmount = 0;
            accountLockedData[msg.sender][length - 1] = lastAccountLockedData;
        } else {
            accountLockedData[msg.sender].push(
                LockedData({week: currentWeek, locked: 0, weight: 0, autoLockAmount: 0})
            );
        }

        if (weight > 0) {
            totalLockedData[currentWeek].locked -= accountData[msg.sender].locked;
            totalLockedData[currentWeek].weight -= weight;
            totalUnlockedData[currentWeek] += accountData[msg.sender].locked;

            if (accountData[msg.sender].autoLock) {
                totalLockedData[currentWeek].autoLockAmount -= accountData[msg.sender].locked;
                totalUnlockedData[unlockWeek] -= accountData[msg.sender].locked;
            }
        }

        if (amount > 0) {
            stakeToken.safeTransfer(msg.sender, amount);
        }

        emit ClaimedEarly(msg.sender, amount, penalty);
        return amount;
    }

    /**
     * @notice Enable auto lock
     */
    function enableAutoLock() external {
        AccountData memory _accountData = accountData[msg.sender];
        require(balanceOf(msg.sender) > 0, "no lock data");
        require(!_accountData.autoLock, "already auto lock");

        _checkpoint();
        uint16 currentWeek = _lastUpdateTotalWeek;
        uint16 unlockWeek = _accountData.lastLockWeek + _accountData.lockWeeks;
        uint16 remainWeek = unlockWeek - currentWeek;

        // Update user lock state
        accountData[msg.sender] = AccountData({
            locked: _accountData.locked,
            autoLock: true,
            lastLockWeek: currentWeek,
            lockWeeks: remainWeek,
            lockTimestamp: block.timestamp
        });

        // Update the list of lock history
        uint256 length = accountLockedData[msg.sender].length;
        LockedData memory lastAccountLockedData = accountLockedData[msg.sender][length - 1];
        if (lastAccountLockedData.week == currentWeek) {
            lastAccountLockedData.autoLockAmount = _accountData.locked;
            accountLockedData[msg.sender][length - 1] = lastAccountLockedData;
        } else {
            accountLockedData[msg.sender].push(
                LockedData({
                    week: currentWeek,
                    locked: _accountData.locked,
                    weight: _accountData.locked * uint256(_accountData.lockWeeks),
                    autoLockAmount: _accountData.locked
                })
            );
        }

        // Update the global lock state
        totalLockedData[currentWeek].autoLockAmount += _accountData.locked;
        totalUnlockedData[unlockWeek] -= _accountData.locked;

        emit EnableAutoLock(msg.sender);
    }

    /**
     * @notice Disable auto lock
     */
    function disableAutoLock() external {
        AccountData memory _accountData = accountData[msg.sender];
        require(_accountData.locked > 0 && _accountData.autoLock, "The position can not be disable");

        _checkpoint();
        uint16 currentWeek = _lastUpdateTotalWeek;

        // Update user lock state
        accountData[msg.sender] = AccountData({
            locked: _accountData.locked,
            autoLock: false,
            lastLockWeek: currentWeek,
            lockWeeks: _accountData.lockWeeks,
            lockTimestamp: block.timestamp
        });

        // Update the list of lock history
        uint256 length = accountLockedData[msg.sender].length;
        LockedData memory lastAccountLockedData = accountLockedData[msg.sender][length - 1];
        if (lastAccountLockedData.week == currentWeek) {
            lastAccountLockedData.autoLockAmount = 0;
            accountLockedData[msg.sender][length - 1] = lastAccountLockedData;
        } else {
            accountLockedData[msg.sender].push(
                LockedData({
                    week: currentWeek,
                    locked: _accountData.locked,
                    weight: _accountData.locked * uint256(_accountData.lockWeeks),
                    autoLockAmount: 0
                })
            );
        }

        // Update the global lock state
        totalLockedData[currentWeek].autoLockAmount -= _accountData.locked;
        totalUnlockedData[currentWeek + _accountData.lockWeeks] += _accountData.locked;

        emit DisableAutoLock(msg.sender);
    }

    /**
     * @notice Claim penalty collected from early claim, only manager can call this function
     */
    function withdraw() external onlyRole(MANAGER) {
        require(totalPenalty > 0, "The total penalty is zero");

        uint256 amount = totalPenalty;
        totalPenalty = 0;

        stakeToken.safeTransfer(penaltyReceiver, amount);

        emit Withdraw(penaltyReceiver, amount);
    }

    /**
     * @notice Get week index according to the startTime
     * @param timestamp Specific timestamp
     * @return week
     */
    function getWeek(uint256 timestamp) public view returns (uint16) {
        uint256 week = (timestamp - startTime) / 1 weeks;
        if (week <= 65535) {
            return uint16(week);
        }
        revert("exceeds MAX_WEEKS");
    }

    /**
     * @notice Get current week i
     * @return week
     */
    function getCurrentWeek() public view returns (uint16) {
        return getWeek(block.timestamp);
    }

    /**
     * @notice Get veToken balance of account (aka user's Voting Power or Weight)
     * @param account Account address
     * @return veToken Balance of account
     */
    function balanceOf(address account) public view returns (uint256) {
        AccountData memory _accountData = accountData[account];
        if (_accountData.autoLock) {
            return _accountData.locked * uint256(_accountData.lockWeeks);
        } else {
            uint16 currentWeek = getCurrentWeek();
            uint256 unlockWeek = _accountData.lastLockWeek + _accountData.lockWeeks;
            if (unlockWeek > currentWeek) {
                return uint256(unlockWeek - currentWeek) * _accountData.locked;
            }
            return 0;
        }
    }

    /**
     * @notice Get veToken balance of account at time
     * @param account Account address
     * @param timestamp Timestamp in second
     * @return veToken Balance of the account
     */
    function balanceOfAtTime(address account, uint256 timestamp) public view returns (uint256) {
        return _balanceOfAtWeek(account, getWeek(timestamp));
    }

    /**
     * @notice Get veToken balance of account at week
     * @param account Account address
     * @param week Week number
     * @return veToken Balance of account
     */
    function balanceOfAtWeek(address account, uint16 week) public view returns (uint256) {
        return _balanceOfAtWeek(account, week);
    }

    /**
     * @notice Get veToken's total supply
     * @return total Supply of veToken
     */
    function totalSupply() public view returns (uint256) {
        return _totalSupplyAtWeek(getCurrentWeek());
    }

    /**
     * @notice Get veToken's total supply at week
     * @param week Week number
     * @return total Supply of veToken
     */
    function totalSupplyAtWeek(uint16 week) public view returns (uint256) {
        return _totalSupplyAtWeek(week);
    }

    /**
     * @notice Get total supply at time
     * @param timestamp Second timestamp
     * @return total Supply of veToken
     */
    function totalSupplyAtTime(uint256 timestamp) public view returns (uint256) {
        return _totalSupplyAtWeek(getWeek(timestamp));
    }

    /**
     * @notice Get locked data of account
     * @param account Account address
     * @return locked Data of the account
     */
    function getLockedData(address account) external view returns (AccountData memory) {
        return accountData[account];
    }

    /**
     * @notice Get penalty of the account
     * @param account Account address
     * @return uint256 The amount of penalty
     */
    function getPenalty(address account) external view returns (uint256) {
        uint16 currentWeek = getCurrentWeek();
        AccountData memory _accountData = accountData[account];

        if (
            !_accountData.autoLock &&
            block.timestamp >= _accountData.lockTimestamp + uint256(_accountData.lockWeeks) * 1 weeks
        ) return 0;

        uint256 penalty;
        if (!_accountData.autoLock) {
            uint16 remainWeek = _accountData.lastLockWeek + _accountData.lockWeeks - currentWeek;
            if (remainWeek == 0) {
                remainWeek = 1;
            }
            penalty = (_accountData.locked * uint256(remainWeek)) / uint256(MAX_LOCK_WEEKS);
        } else {
            penalty = (_accountData.locked * uint256(_accountData.lockWeeks)) / uint256(MAX_LOCK_WEEKS);
        }

        return penalty;
    }

    /**
     * @notice Get total locked data at week
     * @param week Week number
     * @return uint256 The locked amount in specific week
     */
    function getTotalLockedAtWeek(uint16 week) external view returns (uint256) {
        if (_lastUpdateTotalWeek >= week) {
            return totalLockedData[week].locked;
        }
        LockedData memory lastTotalLockedData = totalLockedData[_lastUpdateTotalWeek];
        uint256 locked = lastTotalLockedData.locked;

        for (uint16 i = _lastUpdateTotalWeek + 1; i <= week; i++) {
            uint256 unlocked = totalUnlockedData[i];
            if (unlocked > 0) {
                locked -= unlocked;
            }
        }

        return locked;
    }

    function _createLock(address account, uint256 amount, uint16 week, bool autoLock) internal {
        require(week <= MAX_LOCK_WEEKS, "The number of week exceeds MAX_LOCK_WEEKS");
        require(balanceOf(msg.sender) == 0, "Thers is already lock position");

        _checkpoint();
        uint16 currentWeek = _lastUpdateTotalWeek;

        // Update account lock state
        accountData[account] = AccountData({
            locked: amount,
            lastLockWeek: currentWeek,
            lockWeeks: week,
            autoLock: autoLock,
            lockTimestamp: block.timestamp
        });
        uint256 weight = amount * uint256(week);

        // Update account lock history list
        accountLockedData[account].push(
            LockedData({week: currentWeek, locked: amount, weight: weight, autoLockAmount: autoLock ? amount : 0})
        );

        // Update global state
        LockedData storage weekLockedData = totalLockedData[currentWeek];
        weekLockedData.locked += amount;
        weekLockedData.weight += weight;
        if (autoLock) {
            weekLockedData.autoLockAmount += amount;
        } else {
            totalUnlockedData[currentWeek + week] += amount;
        }

        emit LockCreated(account, amount, week, autoLock);
    }

    function _checkpoint() internal {
        uint16 currentWeek = getCurrentWeek();
        if (currentWeek == _lastUpdateTotalWeek) return;

        LockedData memory lastTotalLockedData = totalLockedData[_lastUpdateTotalWeek];
        uint256 locked = lastTotalLockedData.locked;
        uint256 weight = lastTotalLockedData.weight;
        uint256 autoLock = lastTotalLockedData.autoLockAmount;
        uint256 decay = locked - autoLock;

        for (uint16 i = _lastUpdateTotalWeek + 1; i <= currentWeek; i++) {
            weight -= decay;

            uint256 unlocked = totalUnlockedData[i];
            if (unlocked > 0) {
                decay -= unlocked;
                locked -= unlocked;
            }

            totalLockedData[i] = LockedData({week: i, weight: weight, autoLockAmount: autoLock, locked: locked});
        }

        _lastUpdateTotalWeek = currentWeek;
    }

    /**
     * @notice Get veToken balance of account at week
     */
    function _balanceOfAtWeek(address account, uint16 week) internal view returns (uint256) {
        LockedData[] memory lockedData = accountLockedData[account];
        if (lockedData.length == 0) {
            return 0;
        }
        uint256 min = 0;
        uint256 max = lockedData.length - 1;
        uint256 result = type(uint256).max;
        uint8 i = 0;
        for (; i < 16 && min <= max; i++) {
            uint256 mid = (min + max) / 2;
            if (lockedData[mid].week == week) {
                result = mid;
                break;
            } else if (lockedData[mid].week < week) {
                result = mid;
                min = mid + 1;
            } else {
                if (mid == 0) {
                    break;
                }
                max = mid - 1;
            }
        }
        if (i >= 16) {
            revert("Overflow");
        }

        if (result == type(uint256).max) {
            return 0;
        }

        LockedData memory locked = lockedData[result];

        if (locked.week > week) {
            return 0;
        } else if (locked.week == week) {
            return locked.weight;
        } else {
            if (locked.autoLockAmount > 0) {
                return locked.weight;
            }

            uint256 decay = locked.locked * uint256(week - locked.week);
            if (locked.weight < decay) {
                return 0;
            }
            return locked.weight - decay;
        }
    }

    /**
     * @notice Get total supply at week
     */
    function _totalSupplyAtWeek(uint16 week) internal view returns (uint256) {
        if (_lastUpdateTotalWeek >= week) {
            return totalLockedData[week].weight;
        }

        LockedData memory lastTotalLockedData = totalLockedData[_lastUpdateTotalWeek];
        uint256 locked = lastTotalLockedData.locked;
        uint256 weight = lastTotalLockedData.weight;
        uint256 autoLock = lastTotalLockedData.autoLockAmount;
        uint256 decay = locked - autoLock;

        for (uint16 i = _lastUpdateTotalWeek + 1; i <= week; i++) {
            weight -= decay;
            uint256 unlocked = totalUnlockedData[i];
            if (unlocked > 0) {
                decay -= unlocked;
            }
        }

        return weight;
    }
}
