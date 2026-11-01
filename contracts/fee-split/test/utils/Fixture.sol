// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {FeeSplitterFactory} from "../../src/FeeSplitterFactory.sol";
import {MockToken} from "./Mocks.sol";
import {Test, named, vm} from "./Test.sol";

/// A factory with the platform at 0.875 % and a cap of 1 %, the splitter for one operator at 0.1 %, and a token.
abstract contract Fixture is Test {
    uint256 internal constant PLATFORM_RATE = 875;
    uint256 internal constant MAX_TOTAL_RATE = 1_000;
    uint256 internal constant OPERATOR_RATE = 100;
    address internal constant NATIVE = address(0);

    address internal immutable platform = named("platform");
    address internal immutable operator = named("operator");
    address internal immutable stranger = named("stranger");

    FeeSplitterFactory internal factory;
    FeeSplitter internal splitter;
    MockToken internal token;

    function setUp() public virtual {
        factory = new FeeSplitterFactory(platform, PLATFORM_RATE, MAX_TOTAL_RATE);
        splitter = FeeSplitter(factory.deploy(operator, OPERATOR_RATE));
        token = new MockToken();
    }

    /// Sends `amount` of the native coin from this contract to `to`, with all the gas there is.
    function _sendNative(address to, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = to.call{value: amount}("");
        require(ok, "native payment failed");
    }
}
