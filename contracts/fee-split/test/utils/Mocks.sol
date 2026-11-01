// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {vm} from "./Test.sol";

/// Balances for the test tokens. mint and burn are open to anyone: burn stands in for a token whose balances can
/// shrink without a transfer.
abstract contract Balances {
    mapping(address account => uint256 amount) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// A plain ERC-20 transfer that returns true.
contract MockToken is Balances {
    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }
}

/// Returns nothing from transfer, like USDT on Ethereum.
contract NoReturnToken is Balances {
    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }
}

/// Moves nothing and returns false.
contract FalseToken is Balances {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// Reverts on every transfer.
contract RevertingToken is Balances {
    function transfer(address, uint256) external pure returns (bool) {
        revert("transfer refused");
    }
}

/// Moves the tokens, then returns whatever bytes it was set up with.
contract OddReturnToken is Balances {
    bytes internal _answer;

    constructor(bytes memory answer) {
        _answer = answer;
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
        bytes memory answer = _answer;
        assembly ("memory-safe") {
            return(add(answer, 0x20), mload(answer))
        }
    }
}

/// Removes its own code during transfer and returns nothing, standing in for a token address with no code.
contract VanishingToken is Balances {
    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
        vm.etch(address(this), "");
    }
}

/// Burns 1 % of every transfer: the sender pays the amount, the recipient gets 99 %.
contract FeeOnTransferToken is Balances {
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - amount / 100;
        return true;
    }
}

/// Calls back into a target before it moves any balance, and remembers how that went.
contract ReentrantToken is Balances {
    address public target;
    bytes public callback;
    bool public callbackSucceeded;
    bytes public callbackResult;

    function arm(address target_, bytes calldata callback_) external {
        target = target_;
        callback = callback_;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (target != address(0)) (callbackSucceeded, callbackResult) = target.call(callback);
        _move(msg.sender, to, amount);
        return true;
    }
}

/// A payee whose receive always reverts.
contract RevertingPayee {
    receive() external payable {
        revert("no thanks");
    }
}

/// A payee that calls back into a target when it is paid. With `bubble` set, a failed callback makes it revert too.
contract ReenteringPayee {
    address public target;
    bytes public callback;
    bool public bubble;
    bool public callbackSucceeded;
    bytes public callbackResult;

    function arm(address target_, bytes calldata callback_, bool bubble_) external {
        target = target_;
        callback = callback_;
        bubble = bubble_;
    }

    receive() external payable {
        if (target == address(0)) return;
        (bool ok, bytes memory result) = target.call(callback);
        (callbackSucceeded, callbackResult) = (ok, result);
        if (!ok && bubble) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}

/// Takes the native coin and does nothing else.
contract Receiver {
    receive() external payable {}
}

/// Pays the native coin the way Solidity's transfer and send do, with a 2,300 gas stipend.
contract StipendPayer {
    function payWithTransfer(address payable to) external payable {
        to.transfer(msg.value);
    }

    function payWithSend(address payable to) external payable returns (bool) {
        return to.send(msg.value);
    }
}
