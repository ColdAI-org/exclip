// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// The Foundry cheatcodes these tests use (https://getfoundry.sh/reference/cheatcodes/overview), declared here so the
/// project has no git-submodule dependency on forge-std.
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address account, uint256 newBalance) external;
    function etch(address target, bytes calldata code) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
    function computeCreateAddress(address deployer, uint256 nonce) external pure returns (address);
    function computeCreate2Address(bytes32 salt, bytes32 initCodeHash, address deployer) external pure returns (address);
    function assume(bool condition) external pure;
}

// Named `vm`, as Foundry's documentation and every Foundry test call it.
// forge-lint: disable-next-line(screaming-snake-case-const)
Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// An address for a name, with no code and no known key.
function named(string memory name) pure returns (address) {
    return address(uint160(uint256(keccak256(bytes(name)))));
}

/// `x` mapped into [lo, hi].
function bound(uint256 x, uint256 lo, uint256 hi) pure returns (uint256) {
    require(lo <= hi, "bound: lo > hi");
    if (lo == 0 && hi == type(uint256).max) return x;
    return lo + x % (hi - lo + 1);
}

abstract contract Test {
    /// The invariant runner reads this, when it is set, to know which contracts to call.
    address[] internal _targetContracts;

    function targetContracts() public view returns (address[] memory) {
        return _targetContracts;
    }

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": ", _str(a), " != ", _str(b)));
    }

    function assertEq(address a, address b, string memory what) internal pure {
        require(a == b, what);
    }

    function assertEq(bytes32 a, bytes32 b, string memory what) internal pure {
        require(a == b, what);
    }

    function assertEq(bytes memory a, bytes memory b, string memory what) internal pure {
        require(keccak256(a) == keccak256(b), what);
    }

    function assertLe(uint256 a, uint256 b, string memory what) internal pure {
        if (a > b) revert(string.concat(what, ": ", _str(a), " > ", _str(b)));
    }

    function assertTrue(bool v, string memory what) internal pure {
        require(v, what);
    }

    function _str(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory symbols = "0123456789";
        bytes memory digits;
        while (v != 0) {
            digits = abi.encodePacked(symbols[v % 10], digits);
            v /= 10;
        }
        return string(digits);
    }
}
