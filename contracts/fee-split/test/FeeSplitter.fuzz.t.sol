// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";
import {MockToken} from "./utils/Mocks.sol";
import {Test, bound, named, vm} from "./utils/Test.sol";

/// floor(a × b ÷ c) for any a and b ≤ c < 2^64, worked out on the two 128-bit halves of a. A reference for the
/// splitter's own formula that shares none of its steps.
function mulDiv(uint256 a, uint256 b, uint256 c) pure returns (uint256) {
    uint256 hi = a >> 128;
    uint256 lo = a & type(uint128).max;
    uint256 q = hi * b / c;
    uint256 r = hi * b % c;
    return (q << 128) + ((r << 128) + lo * b) / c;
}

contract FeeSplitterFuzzTest is Test {
    address internal constant NATIVE = address(0);
    address internal immutable platform = named("platform");
    address internal immutable operator = named("operator");
    MockToken internal token;

    function setUp() public {
        token = new MockToken();
    }

    /// For any rates and any amount up to the largest uint256, each payee is owed its share rounded down, and at most
    /// one unit is left.
    function testFuzz_sharesOfAnyAmount(uint256 platformRate, uint256 operatorRate, uint256 amount, address payee)
        public
    {
        vm.assume(payee != address(0) && payee != platform);
        platformRate = bound(platformRate, 0, 100_000);
        operatorRate = bound(operatorRate, platformRate == 0 ? 1 : 0, 100_000 - platformRate);
        FeeSplitter splitter = _splitter(platformRate, 100_000, payee, operatorRate);
        token.mint(address(splitter), amount);

        uint256 totalRate = platformRate + operatorRate;
        uint256 platformShare = mulDiv(amount, platformRate, totalRate);
        uint256 operatorShare = mulDiv(amount, operatorRate, totalRate);
        assertEq(splitter.releasable(address(token), platform), platformShare, "platform's share");
        assertEq(splitter.releasable(address(token), payee), operatorShare, "operator's share");
        assertLe(amount - platformShare - operatorShare, 1, "left over");

        if (platformShare != 0) splitter.release(address(token), platform);
        if (operatorShare != 0) splitter.release(address(token), payee);
        assertEq(splitter.released(address(token), platform), platformShare, "platform paid");
        assertEq(splitter.released(address(token), payee), operatorShare, "operator paid");
        assertEq(token.balanceOf(address(splitter)), amount - platformShare - operatorShare, "left in the splitter");
        assertEq(splitter.received(address(token)), amount, "received");
    }

    /// Payments and releases in any order, at any operator rate the cap allows: after every step, what each payee
    /// has been paid plus what it can release is its exact share of all received, and at most one unit is left over.
    function testFuzz_paymentsAndReleasesInAnyOrder(uint256 seed, uint256 operatorRate) public {
        operatorRate = bound(operatorRate, 0, 1_000);
        FeeSplitter splitter = _splitter(875, 1_875, operator, operatorRate);
        uint256 received;
        for (uint256 i; i < 24; ++i) {
            uint256 step = uint256(keccak256(abi.encode(seed, i)));
            if (step % 3 == 0) {
                uint256 amount = bound(step >> 8, 0, 1e30);
                token.mint(address(splitter), amount);
                received += amount;
            } else {
                address payee = step % 3 == 1 ? platform : operator;
                if (splitter.releasable(address(token), payee) != 0) splitter.release(address(token), payee);
            }
            _checkShares(splitter, received, 875, operatorRate);
        }
    }

    function testFuzz_theCoinIsSharedLikeAnyToken(uint256 amount, uint256 operatorRate) public {
        amount = bound(amount, 0, 1e30);
        operatorRate = bound(operatorRate, 0, 1_000);
        FeeSplitter splitter = _splitter(875, 1_875, operator, operatorRate);
        vm.deal(address(this), amount);
        (bool ok,) = address(splitter).call{value: amount}("");
        assertTrue(ok, "received");

        uint256 platformShare = mulDiv(amount, 875, 875 + operatorRate);
        uint256 operatorShare = mulDiv(amount, operatorRate, 875 + operatorRate);
        if (platformShare != 0) splitter.release(NATIVE, platform);
        if (operatorShare != 0) splitter.release(NATIVE, operator);
        assertEq(platform.balance, platformShare, "platform");
        assertEq(operator.balance, operatorShare, "operator");
        assertLe(address(splitter).balance, 1, "left over");
    }

    function testFuzz_predictIsWhereDeployCreates(address payee, uint256 operatorRate, address caller) public {
        vm.assume(payee != address(0) && payee != platform);
        operatorRate = bound(operatorRate, 0, 1_000);
        FeeSplitterFactory factory = new FeeSplitterFactory(platform, 875, 1_875);
        address predicted = factory.predict(payee, operatorRate);
        assertEq(
            predicted,
            vm.computeCreate2Address(
                keccak256(abi.encode(payee, operatorRate)), factory.initCodeHash(), address(factory)
            ),
            "CREATE2 address"
        );

        vm.prank(caller);
        assertEq(factory.deploy(payee, operatorRate), predicted, "deployed there");
        assertEq(FeeSplitter(predicted).operator(), payee, "operator");
        assertEq(FeeSplitter(predicted).operatorRate(), operatorRate, "operatorRate");
        assertEq(factory.deploy(payee, operatorRate), predicted, "deployed again");
    }

    function testFuzz_ratesAboveTheCapAreRefused(uint256 operatorRate) public {
        operatorRate = bound(operatorRate, 1_001, type(uint256).max);
        FeeSplitterFactory factory = new FeeSplitterFactory(platform, 875, 1_875);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitterFactory.RateTooHigh.selector, operatorRate, 1_000));
        factory.predict(operator, operatorRate);
    }

    function testFuzz_theFactoryChecksItsRates(uint256 platformRate, uint256 maxTotalRate) public {
        platformRate = bound(platformRate, 0, 200_000);
        maxTotalRate = bound(maxTotalRate, 0, 200_000);
        if (maxTotalRate == 0 || maxTotalRate > 100_000 || platformRate > maxTotalRate) {
            vm.expectRevert(FeeSplitterFactory.BadRates.selector);
            new FeeSplitterFactory(platform, platformRate, maxTotalRate);
        } else {
            FeeSplitterFactory factory = new FeeSplitterFactory(platform, platformRate, maxTotalRate);
            assertEq(factory.platformRate(), platformRate, "platformRate");
            assertEq(factory.maxTotalRate(), maxTotalRate, "maxTotalRate");
        }
    }

    function _splitter(uint256 platformRate, uint256 maxTotalRate, address payee, uint256 operatorRate)
        private
        returns (FeeSplitter)
    {
        FeeSplitterFactory factory = new FeeSplitterFactory(platform, platformRate, maxTotalRate);
        return FeeSplitter(factory.deploy(payee, operatorRate));
    }

    function _checkShares(FeeSplitter splitter, uint256 received, uint256 platformRate, uint256 operatorRate)
        private
        view
    {
        uint256 totalRate = platformRate + operatorRate;
        uint256 platformDue = splitter.releasable(address(token), platform);
        uint256 operatorDue = splitter.releasable(address(token), operator);
        assertEq(
            splitter.released(address(token), platform) + platformDue,
            mulDiv(received, platformRate, totalRate),
            "platform's share"
        );
        assertEq(
            splitter.released(address(token), operator) + operatorDue,
            mulDiv(received, operatorRate, totalRate),
            "operator's share"
        );
        assertLe(token.balanceOf(address(splitter)) - platformDue - operatorDue, 1, "left over");
    }
}
