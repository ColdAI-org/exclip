// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// The two ERC-20 functions a splitter calls.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Splits a SODAX partner fee between two fixed payees: the platform and one operator.
///
/// SODAX pays a partner fee on Sonic as a plain balance of the receiver, in the token sold or in native S. A splitter
/// is that receiver. Each one is a proxy (SplitterProxy) that FeeSplitterFactory creates with CREATE2 and initializes
/// in the same transaction. The platform and its rate are immutables of this implementation, shared by every
/// splitter of one factory. The operator and its rate are written once, by the factory, and never change.
///
/// For each token, what a splitter has received is what it holds plus what it has paid out. A payee is owed that
/// total times its rate, divided by the sum of both rates and rounded down, less what it has been paid. Rounding down
/// leaves at most one smallest unit of each token that neither payee can take.
///
/// Anyone may call release, and the money goes only to the payee named. This contract has no owner, admin, upgrade,
/// pause, delegatecall or selfdestruct.
contract FeeSplitter {
    /// The token address that stands for the chain's native coin (S on Sonic), as SODAX writes it.
    address public constant NATIVE = address(0);

    uint8 private constant UNSET = 0;
    uint8 private constant IDLE = 1;
    uint8 private constant PAYING = 2;

    /// The factory that created this implementation. Only it can initialize a splitter.
    address public immutable factory;
    /// The platform's address and its rate, in parts per 100,000 of the amount sold.
    address public immutable platform;
    uint256 public immutable platformRate;

    // One storage slot: the operator, its rate in parts per 100,000, and the state (UNSET until initialize, IDLE, or
    // PAYING while a payment is out).
    address private _operator;
    uint32 private _operatorRate;
    uint8 private _state;

    mapping(address token => uint256 amount) private _totalReleased;
    mapping(address token => mapping(address payee => uint256 amount)) private _released;

    /// A payment: `amount` of `token` (NATIVE for native S) sent to `payee`.
    event Released(address indexed token, address indexed payee, uint256 amount);
    /// Native coin received with empty calldata. The proxy emits it itself, without calling this contract.
    event NativeReceived(uint256 amount);

    error NotFactory();
    error AlreadyInitialized();
    error NotInitialized();
    error Reentered();
    error NotPayee(address account);
    error NothingDue();
    error TransferFailed(address token, address payee, uint256 amount);

    constructor(address platform_, uint256 platformRate_) {
        factory = msg.sender;
        // FeeSplitterFactory, the only creator that counts, refuses the zero address before it gets here.
        // slither-disable-next-line missing-zero-check
        platform = platform_;
        platformRate = platformRate_;
    }

    /// Sets the operator and its rate. The factory calls it once, in the transaction that creates the splitter.
    function initialize(address operator_, uint32 operatorRate_) external {
        if (msg.sender != factory) revert NotFactory();
        if (_state != UNSET) revert AlreadyInitialized();
        // The factory has refused the zero address, and its SplitterDeployed event records both values.
        // slither-disable-next-line missing-zero-check
        _operator = operator_;
        // slither-disable-next-line events-maths
        _operatorRate = operatorRate_;
        _state = IDLE;
    }

    /// Pays `payee` all it is owed in `token` (NATIVE for native S) and returns the amount. Anyone may call it; the
    /// payment always goes to `payee`, which must be the platform or the operator. Reverts if nothing is owed.
    function release(address token, address payee) external returns (uint256 amount) {
        amount = releasable(token, payee);
        // Sending the splitter more can only make amount larger, which pays the payee what it is owed.
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert NothingDue();
        _state = PAYING;
        _released[token][payee] += amount;
        _totalReleased[token] += amount;
        emit Released(token, payee, amount);
        _send(token, payee, amount);
        // The lock. The accounting is written before _send, and while _state is PAYING everything that pays or reads
        // a balance reverts, so nothing that runs during _send can see or use a half-finished payment.
        // slither-disable-next-line reentrancy-eth,write-after-write
        _state = IDLE;
    }

    /// What release(token, payee) would pay now. Reverts for an address that isn't a payee.
    function releasable(address token, address payee) public view returns (uint256) {
        (uint256 rate, uint256 totalRate) = _rates(payee);
        uint256 balance = _balanceOf(token);
        uint256 total = balance + _totalReleased[token];
        // total × rate ÷ totalRate, rounded down, without overflowing for any total. Dividing first loses nothing:
        // the remainder is carried into the second term.
        // slither-disable-start divide-before-multiply
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 owed = (total / totalRate) * rate + ((total % totalRate) * rate) / totalRate;
        // slither-disable-end divide-before-multiply
        uint256 paid = _released[token][payee];
        if (owed <= paid) return 0;
        // Never more than the splitter holds, even for a token whose balances can shrink on their own.
        return owed - paid < balance ? owed - paid : balance;
    }

    /// All the splitter has received in `token`: what it holds plus what it has paid out.
    function received(address token) external view returns (uint256) {
        _ready();
        return _balanceOf(token) + _totalReleased[token];
    }

    /// What `payee` has been paid in `token`.
    function released(address token, address payee) external view returns (uint256) {
        return _released[token][payee];
    }

    /// What both payees together have been paid in `token`.
    function totalReleased(address token) external view returns (uint256) {
        return _totalReleased[token];
    }

    function operator() external view returns (address) {
        return _operator;
    }

    /// The operator's rate, in parts per 100,000 of the amount sold.
    function operatorRate() external view returns (uint256) {
        return _operatorRate;
    }

    /// The payee's rate and the sum of both rates. Reverts for anyone else, before initialize, and while a payment is
    /// out, so nothing can read a balance halfway through a transfer.
    function _rates(address payee) private view returns (uint256 rate, uint256 totalRate) {
        _ready();
        uint256 operatorRate_ = _operatorRate;
        if (payee == platform) rate = platformRate;
        else if (payee == _operator) rate = operatorRate_;
        else revert NotPayee(payee);
        totalRate = platformRate + operatorRate_;
    }

    function _ready() private view {
        uint8 state = _state;
        if (state == UNSET) revert NotInitialized();
        if (state == PAYING) revert Reentered();
    }

    function _balanceOf(address token) private view returns (uint256) {
        return token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _send(address token, address payee, uint256 amount) private {
        bool ok;
        if (token == NATIVE) {
            // payee is the platform or the operator: _rates refused anyone else. A low-level call, so that a payee
            // that is a contract gets all the gas it needs.
            // slither-disable-next-line arbitrary-send-eth,low-level-calls
            (ok,) = payee.call{value: amount}("");
        } else {
            bytes memory data;
            (ok, data) = token.call(abi.encodeCall(IERC20.transfer, (payee, amount)));
            // A token may return true, or nothing at all if it is a contract. Anything else is a failure.
            // slither-disable-next-line incorrect-equality
            ok = ok
                && (data.length == 0 ? token.code.length != 0 : data.length >= 32 && abi.decode(data, (uint256)) == 1);
        }
        if (!ok) revert TransferFailed(token, payee, amount);
    }
}
