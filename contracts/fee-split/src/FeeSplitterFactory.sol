// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {FeeSplitter} from "./FeeSplitter.sol";
import {SplitterProxy} from "./SplitterProxy.sol";

/// Creates one FeeSplitter per operator and operator rate, at an address anyone can compute in advance.
///
/// The platform's address, its rate and the cap on the total rate are fixed when the factory is deployed. A
/// splitter's address depends only on this factory, the operator and the operator's rate, so it can be computed with
/// predict and used as the fee receiver before the splitter exists: whatever is sent there early is paid out once it
/// does. Anyone may deploy a splitter, and deploying one that already exists just returns it. The factory has no owner
/// and nothing in it can change.
contract FeeSplitterFactory {
    /// Rates are in parts per 100,000 of the amount sold: 875 is 0.875 %, 1,000 is 1 %.
    uint256 public constant RATE_SCALE = 100_000;

    /// The platform's address and its rate, the same in every splitter of this factory.
    address public immutable platform;
    uint256 public immutable platformRate;
    /// The most a splitter's platform rate and operator rate may add up to.
    uint256 public immutable maxTotalRate;
    /// The FeeSplitter every splitter delegates to, created by this factory's constructor.
    address public immutable implementation;
    /// keccak256 of a splitter's creation code, for computing its CREATE2 address off-chain.
    bytes32 public immutable initCodeHash;

    event SplitterDeployed(address indexed splitter, address indexed operator, uint256 operatorRate);

    error ZeroAddress();
    error BadRates();
    error OperatorIsPlatform();
    error RateTooHigh(uint256 operatorRate, uint256 maxOperatorRate);
    error ZeroRates();
    error DeployFailed();

    constructor(address platform_, uint256 platformRate_, uint256 maxTotalRate_) {
        if (platform_ == address(0)) revert ZeroAddress();
        if (maxTotalRate_ == 0 || maxTotalRate_ > RATE_SCALE || platformRate_ > maxTotalRate_) revert BadRates();
        platform = platform_;
        platformRate = platformRate_;
        maxTotalRate = maxTotalRate_;
        address implementation_ = address(new FeeSplitter(platform_, platformRate_));
        // `new` either creates the contract or reverts, so this is never the zero address.
        // slither-disable-next-line missing-zero-check
        implementation = implementation_;
        initCodeHash = keccak256(SplitterProxy.initCode(implementation_));
    }

    /// The address of the splitter for this operator and rate, deployed or not. Reverts for anything deploy would
    /// refuse, so fees are never sent to an address where no splitter can be deployed.
    function predict(address operator, uint256 operatorRate) public view returns (address) {
        _check(operator, operatorRate);
        bytes32 hash =
            keccak256(abi.encodePacked(bytes1(0xff), address(this), salt(operator, operatorRate), initCodeHash));
        return address(uint160(uint256(hash)));
    }

    /// Deploys the splitter for this operator and rate and returns its address, or just returns it if it exists.
    function deploy(address operator, uint256 operatorRate) external returns (address splitter) {
        splitter = predict(operator, operatorRate);
        if (splitter.code.length != 0) return splitter;
        bytes memory code = SplitterProxy.initCode(implementation);
        bytes32 salt_ = salt(operator, operatorRate);
        address created;
        // Solidity's `new` can only create Solidity contracts, and the proxy is bytecode written out in SplitterProxy.
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            created := create2(0, add(code, 0x20), mload(code), salt_)
        }
        if (created != splitter) revert DeployFailed();
        emit SplitterDeployed(splitter, operator, operatorRate);
        // _check capped operatorRate at maxTotalRate, at most RATE_SCALE, so it fits in a uint32.
        // forge-lint: disable-next-line(unsafe-typecast)
        FeeSplitter(splitter).initialize(operator, uint32(operatorRate));
    }

    /// The CREATE2 salt for this operator and rate: keccak256(abi.encode(operator, operatorRate)).
    function salt(address operator, uint256 operatorRate) public pure returns (bytes32) {
        return keccak256(abi.encode(operator, operatorRate));
    }

    function _check(address operator, uint256 operatorRate) private view {
        if (operator == address(0)) revert ZeroAddress();
        if (operator == platform) revert OperatorIsPlatform();
        if (operatorRate > maxTotalRate - platformRate) revert RateTooHigh(operatorRate, maxTotalRate - platformRate);
        if (operatorRate == 0 && platformRate == 0) revert ZeroRates();
    }
}
