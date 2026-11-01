// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";
import {Fixture} from "./utils/Fixture.sol";
import {
    FalseToken,
    FeeOnTransferToken,
    NoReturnToken,
    OddReturnToken,
    Receiver,
    ReenteringPayee,
    ReentrantToken,
    RevertingPayee,
    RevertingToken,
    StipendPayer,
    VanishingToken
} from "./utils/Mocks.sol";
import {Test, named, vm} from "./utils/Test.sol";

contract FeeSplitterTest is Fixture {
    // Shares ------------------------------------------------------------------------------------------------------

    /// The example in docs/fee-split.md: a swap sells 1,000 USDC (6 decimals). The platform's 0.875 % and the
    /// operator's 0.1 % make a fee of 0.975 %, 9.75 USDC, which SODAX pays to the splitter.
    function test_theWorkedExample() public {
        uint256 sold = 1_000e6;
        uint256 fee = sold * (PLATFORM_RATE + OPERATOR_RATE) / factory.RATE_SCALE();
        assertEq(fee, 9_750_000, "fee");
        token.mint(address(splitter), fee);

        assertEq(splitter.releasable(address(token), platform), 8_750_000, "platform's share");
        assertEq(splitter.releasable(address(token), operator), 1_000_000, "operator's share");
        splitter.release(address(token), platform);
        splitter.release(address(token), operator);
        assertEq(token.balanceOf(platform), 8_750_000, "platform paid 8.75 USDC");
        assertEq(token.balanceOf(operator), 1_000_000, "operator paid 1 USDC");
        assertEq(token.balanceOf(address(splitter)), 0, "nothing left");
    }

    function test_releaseEmitsAndRecordsThePayment() public {
        token.mint(address(splitter), 975);
        vm.expectEmit(true, true, false, true, address(splitter));
        emit FeeSplitter.Released(address(token), platform, 875);
        assertEq(splitter.release(address(token), platform), 875, "amount");

        assertEq(token.balanceOf(platform), 875, "paid");
        assertEq(splitter.released(address(token), platform), 875, "released");
        assertEq(splitter.released(address(token), operator), 0, "operator's released");
        assertEq(splitter.totalReleased(address(token)), 875, "totalReleased");
        assertEq(splitter.received(address(token)), 975, "received");
        assertEq(splitter.releasable(address(token), platform), 0, "platform's releasable");
        assertEq(splitter.releasable(address(token), operator), 100, "operator's releasable");
    }

    function test_aLaterReleasePaysOnlyWhatArrivedSince() public {
        token.mint(address(splitter), 975);
        splitter.release(address(token), platform);
        token.mint(address(splitter), 1_950);
        assertEq(splitter.received(address(token)), 2_925, "received");
        assertEq(splitter.releasable(address(token), platform), 1_750, "platform's new share");
        assertEq(splitter.releasable(address(token), operator), 300, "operator's whole share");
        splitter.release(address(token), operator);
        splitter.release(address(token), platform);
        assertEq(token.balanceOf(platform), 2_625, "platform");
        assertEq(token.balanceOf(operator), 300, "operator");
    }

    function test_eachTokenIsAccountedForApart() public {
        NoReturnToken other = new NoReturnToken();
        token.mint(address(splitter), 975);
        other.mint(address(splitter), 1_950);
        splitter.release(address(token), platform);
        assertEq(splitter.releasable(address(other), platform), 1_750, "other token untouched");
        assertEq(splitter.totalReleased(address(other)), 0, "other token's totalReleased");
    }

    /// Rounding down leaves at most one unit, which counts towards later shares.
    function test_roundingLeavesAtMostOneUnit() public {
        token.mint(address(splitter), 1);
        assertEq(splitter.releasable(address(token), platform), 0, "platform, 1 unit");
        assertEq(splitter.releasable(address(token), operator), 0, "operator, 1 unit");

        // 2 × 875 / 975 = 1.79, rounded down to 1; 2 × 100 / 975 = 0.21, rounded down to 0.
        token.mint(address(splitter), 1);
        assertEq(splitter.releasable(address(token), platform), 1, "platform, 2 units");
        assertEq(splitter.releasable(address(token), operator), 0, "operator, 2 units");
        splitter.release(address(token), platform);
        assertEq(token.balanceOf(address(splitter)), 1, "one unit left");

        // 977 received: the platform is owed 876 (876.79 rounded down) and has had 1; the operator is owed 100.
        token.mint(address(splitter), 975);
        assertEq(splitter.releasable(address(token), platform), 875, "platform");
        assertEq(splitter.releasable(address(token), operator), 100, "operator");
        splitter.release(address(token), platform);
        splitter.release(address(token), operator);
        assertEq(token.balanceOf(address(splitter)), 1, "still one unit left");
    }

    function test_anOperatorRateOfZeroGivesThePlatformEverything() public {
        FeeSplitter platformOnly = FeeSplitter(factory.deploy(operator, 0));
        token.mint(address(platformOnly), 1_000);
        assertEq(platformOnly.releasable(address(token), operator), 0, "operator");
        vm.expectRevert(FeeSplitter.NothingDue.selector);
        platformOnly.release(address(token), operator);
        platformOnly.release(address(token), platform);
        assertEq(token.balanceOf(platform), 1_000, "platform");
    }

    function test_aPlatformRateOfZeroGivesTheOperatorEverything() public {
        FeeSplitterFactory free = new FeeSplitterFactory(platform, 0, MAX_TOTAL_RATE);
        FeeSplitter operatorOnly = FeeSplitter(free.deploy(operator, OPERATOR_RATE));
        token.mint(address(operatorOnly), 1_000);
        assertEq(operatorOnly.releasable(address(token), platform), 0, "platform");
        vm.expectRevert(FeeSplitter.NothingDue.selector);
        operatorOnly.release(address(token), platform);
        operatorOnly.release(address(token), operator);
        assertEq(token.balanceOf(operator), 1_000, "operator");
    }

    /// If a token takes some of the splitter's balance away, a payee is never paid more than the splitter holds.
    function test_aShrinkingBalanceIsNeverOverpaid() public {
        token.mint(address(splitter), 1_000);
        splitter.release(address(token), platform); // 897: 1,000 × 875 / 975, rounded down
        token.burn(address(splitter), 100); // 103 left, then 3

        // 900 received now: the operator is owed 92, but only 3 are there.
        assertEq(splitter.releasable(address(token), operator), 3, "capped at the balance");
        splitter.release(address(token), operator);
        assertEq(token.balanceOf(operator), 3, "operator");
        assertEq(token.balanceOf(address(splitter)), 0, "empty");
        assertEq(splitter.releasable(address(token), operator), 0, "nothing more");
        assertEq(splitter.releasable(address(token), platform), 0, "the platform already had more than its share");
    }

    // Who may be paid, and when -------------------------------------------------------------------------------------

    function test_anyoneMayReleaseButOnlyThePayeeIsPaid() public {
        token.mint(address(splitter), 975);
        vm.prank(stranger);
        splitter.release(address(token), operator);
        assertEq(token.balanceOf(operator), 100, "operator");
        assertEq(token.balanceOf(stranger), 0, "stranger");
    }

    function test_onlyThePlatformAndTheOperatorArePayees() public {
        token.mint(address(splitter), 975);
        bytes memory notPayee = abi.encodeWithSelector(FeeSplitter.NotPayee.selector, stranger);
        vm.expectRevert(notPayee);
        splitter.release(address(token), stranger);
        vm.expectRevert(notPayee);
        splitter.releasable(address(token), stranger);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NotPayee.selector, address(0)));
        splitter.release(address(token), address(0));
    }

    function test_releaseRevertsWhenNothingIsDue() public {
        vm.expectRevert(FeeSplitter.NothingDue.selector);
        splitter.release(address(token), platform);
        token.mint(address(splitter), 975);
        splitter.release(address(token), platform);
        vm.expectRevert(FeeSplitter.NothingDue.selector);
        splitter.release(address(token), platform);
    }

    function test_feesSentBeforeDeploymentArePaidOut() public {
        address other = named("operator 2");
        address predicted = factory.predict(other, 125);
        token.mint(predicted, 1_000);
        _sendNative(predicted, 1 ether);

        FeeSplitter late = FeeSplitter(factory.deploy(other, 125));
        assertEq(address(late), predicted, "address");
        assertEq(late.received(address(token)), 1_000, "token received");
        assertEq(late.received(NATIVE), 1 ether, "native received");
        late.release(address(token), platform);
        late.release(address(token), other);
        late.release(NATIVE, platform);
        late.release(NATIVE, other);
        assertEq(token.balanceOf(platform), 875, "platform's token");
        assertEq(token.balanceOf(other), 125, "operator's token");
        assertEq(platform.balance, 0.875 ether, "platform's coin");
        assertEq(other.balance, 0.125 ether, "operator's coin");
    }

    // Initialization ----------------------------------------------------------------------------------------------

    function test_theSplitterKnowsItsPayees() public view {
        assertEq(splitter.factory(), address(factory), "factory");
        assertEq(splitter.platform(), platform, "platform");
        assertEq(splitter.platformRate(), PLATFORM_RATE, "platformRate");
        assertEq(splitter.operator(), operator, "operator");
        assertEq(splitter.operatorRate(), OPERATOR_RATE, "operatorRate");
        assertEq(splitter.NATIVE(), address(0), "NATIVE");
    }

    function test_onlyTheFactoryInitializesAndOnlyOnce() public {
        vm.expectRevert(FeeSplitter.NotFactory.selector);
        splitter.initialize(stranger, 1_000);
        vm.prank(address(factory));
        vm.expectRevert(FeeSplitter.AlreadyInitialized.selector);
        splitter.initialize(stranger, 1_000);
        assertEq(splitter.operator(), operator, "operator unchanged");

        FeeSplitter implementation = FeeSplitter(factory.implementation());
        vm.expectRevert(FeeSplitter.NotFactory.selector);
        implementation.initialize(stranger, 1_000);
    }

    function test_theImplementationHoldsNothing() public {
        FeeSplitter implementation = FeeSplitter(factory.implementation());
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(implementation).call{value: 1 ether}("");
        assertTrue(!ok, "takes no coin");
        token.mint(address(implementation), 975);
        vm.expectRevert(FeeSplitter.NotInitialized.selector);
        implementation.release(address(token), platform);
        vm.expectRevert(FeeSplitter.NotInitialized.selector);
        implementation.releasable(address(token), platform);
        vm.expectRevert(FeeSplitter.NotInitialized.selector);
        implementation.received(address(token));
        assertEq(implementation.operator(), address(0), "no operator");
    }

    // The native coin ---------------------------------------------------------------------------------------------

    function test_theCoinArrivesWithAnEvent() public {
        vm.deal(address(this), 1 ether);
        vm.expectEmit(false, false, false, true, address(splitter));
        emit FeeSplitter.NativeReceived(1 ether);
        (bool ok,) = address(splitter).call{value: 1 ether}("");
        assertTrue(ok, "received");
        assertEq(splitter.received(NATIVE), 1 ether, "received");
    }

    /// Solidity's transfer and send pass on only 2,300 gas. The proxy takes the coin itself, within that.
    function test_theCoinArrivesWithinTheStipend() public {
        StipendPayer payer = new StipendPayer();
        vm.deal(address(this), 2 ether);
        vm.expectEmit(false, false, false, true, address(splitter));
        emit FeeSplitter.NativeReceived(1 ether);
        payer.payWithTransfer{value: 1 ether}(payable(address(splitter)));
        assertTrue(payer.payWithSend{value: 1 ether}(payable(address(splitter))), "send");
        assertEq(splitter.received(NATIVE), 2 ether, "received");
    }

    function test_coinThatArrivesWithoutACallIsSharedToo() public {
        vm.deal(address(splitter), 975);
        assertEq(splitter.releasable(NATIVE, platform), 875, "platform");
        assertEq(splitter.releasable(NATIVE, operator), 100, "operator");
    }

    function test_releasePaysTheCoin() public {
        _sendNative(address(splitter), 9.75 ether);
        vm.expectEmit(true, true, false, true, address(splitter));
        emit FeeSplitter.Released(NATIVE, platform, 8.75 ether);
        splitter.release(NATIVE, platform);
        splitter.release(NATIVE, operator);
        assertEq(platform.balance, 8.75 ether, "platform");
        assertEq(operator.balance, 1 ether, "operator");
        assertEq(address(splitter).balance, 0, "nothing left");
    }

    function test_theCoinWithCalldataIsRefused() public {
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(splitter).call{value: 1 ether}(hex"01");
        assertTrue(!ok, "unknown calldata");
        (ok,) = address(splitter).call{value: 1 ether}(abi.encodeCall(FeeSplitter.release, (NATIVE, platform)));
        assertTrue(!ok, "release isn't payable");
        assertEq(address(splitter).balance, 0, "nothing taken");
    }

    // Payees and tokens that misbehave --------------------------------------------------------------------------

    function test_aPayeeThatRefusesTheCoinHoldsUpOnlyItsOwnShare() public {
        RevertingPayee payee = new RevertingPayee();
        FeeSplitter s = FeeSplitter(factory.deploy(address(payee), OPERATOR_RATE));
        _sendNative(address(s), 975);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.TransferFailed.selector, NATIVE, address(payee), 100));
        s.release(NATIVE, address(payee));
        s.release(NATIVE, platform);
        assertEq(platform.balance, 875, "platform paid");
        assertEq(address(s).balance, 100, "the operator's share waits");
        assertEq(s.released(NATIVE, address(payee)), 0, "nothing recorded");
    }

    function test_aPayeeCannotReenterWhileItIsPaid() public {
        ReenteringPayee payee = new ReenteringPayee();
        FeeSplitter s = FeeSplitter(factory.deploy(address(payee), OPERATOR_RATE));
        bytes memory reentered = abi.encodeWithSelector(FeeSplitter.Reentered.selector);
        _sendNative(address(s), 975);

        // It calls release for itself again, and swallows the failure: it is paid once.
        payee.arm(address(s), abi.encodeCall(FeeSplitter.release, (NATIVE, address(payee))), false);
        s.release(NATIVE, address(payee));
        assertTrue(!payee.callbackSucceeded(), "release refused");
        assertEq(payee.callbackResult(), reentered, "Reentered");
        assertEq(address(payee).balance, 100, "paid once");

        // It tries to have the platform paid instead.
        _sendNative(address(s), 975);
        payee.arm(address(s), abi.encodeCall(FeeSplitter.release, (NATIVE, platform)), false);
        s.release(NATIVE, address(payee));
        assertEq(payee.callbackResult(), reentered, "Reentered");
        assertEq(platform.balance, 0, "platform not paid in the callback");

        // A read is refused too: received would count the payment in flight twice.
        _sendNative(address(s), 975);
        payee.arm(address(s), abi.encodeCall(FeeSplitter.received, (NATIVE)), false);
        s.release(NATIVE, address(payee));
        assertEq(payee.callbackResult(), reentered, "Reentered");
        assertEq(s.released(NATIVE, address(payee)), 300, "three payments in all");
    }

    function test_aPayeeThatRevertsOnReentryFailsItsOwnRelease() public {
        ReenteringPayee payee = new ReenteringPayee();
        FeeSplitter s = FeeSplitter(factory.deploy(address(payee), OPERATOR_RATE));
        _sendNative(address(s), 975);
        payee.arm(address(s), abi.encodeCall(FeeSplitter.releasable, (NATIVE, address(payee))), true);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.TransferFailed.selector, NATIVE, address(payee), 100));
        s.release(NATIVE, address(payee));
        s.release(NATIVE, platform);
        assertEq(platform.balance, 875, "platform paid");
    }

    function test_aTokenCannotReenterWhileItPays() public {
        ReentrantToken reentrant = new ReentrantToken();
        bytes memory reentered = abi.encodeWithSelector(FeeSplitter.Reentered.selector);
        reentrant.mint(address(splitter), 975);

        reentrant.arm(address(splitter), abi.encodeCall(FeeSplitter.release, (address(reentrant), operator)));
        splitter.release(address(reentrant), platform);
        assertTrue(!reentrant.callbackSucceeded(), "release refused");
        assertEq(reentrant.callbackResult(), reentered, "Reentered");
        assertEq(reentrant.balanceOf(platform), 875, "platform paid");
        assertEq(reentrant.balanceOf(operator), 0, "operator not paid in the callback");

        reentrant.arm(address(splitter), abi.encodeCall(FeeSplitter.releasable, (address(reentrant), operator)));
        splitter.release(address(reentrant), operator);
        assertEq(reentrant.callbackResult(), reentered, "Reentered");
        assertEq(reentrant.balanceOf(operator), 100, "operator paid");
    }

    function test_aTokenThatReturnsNothingIsAccepted() public {
        NoReturnToken quiet = new NoReturnToken();
        quiet.mint(address(splitter), 975);
        splitter.release(address(quiet), platform);
        assertEq(quiet.balanceOf(platform), 875, "paid");
    }

    function test_aTokenThatReturnsFalseFails() public {
        FalseToken liar = new FalseToken();
        liar.mint(address(splitter), 975);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.TransferFailed.selector, address(liar), platform, 875));
        splitter.release(address(liar), platform);
    }

    function test_aTokenThatRevertsFails() public {
        RevertingToken stuck = new RevertingToken();
        stuck.mint(address(splitter), 975);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.TransferFailed.selector, address(stuck), platform, 875));
        splitter.release(address(stuck), platform);
    }

    function test_whatATokenReturnsDecides() public {
        _releaseOdd(abi.encode(uint256(1)), true);
        _releaseOdd(abi.encode(uint256(1), uint256(7)), true);
        _releaseOdd(abi.encode(uint256(0)), false);
        _releaseOdd(abi.encode(uint256(2)), false);
        _releaseOdd(hex"01", false);
        _releaseOdd(new bytes(31), false);
    }

    /// An empty answer counts as success only from an address that still has code.
    function test_aTokenThatLosesItsCodeFails() public {
        VanishingToken vanishing = new VanishingToken();
        vanishing.mint(address(splitter), 975);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.TransferFailed.selector, address(vanishing), platform, 875));
        splitter.release(address(vanishing), platform);
    }

    /// A token that keeps a cut of each transfer: the splitter shares what arrives, and the payee gets what the
    /// token lets through.
    function test_aFeeOnTransferTokenIsSharedAsItArrives() public {
        FeeOnTransferToken taxed = new FeeOnTransferToken();
        taxed.mint(address(this), 1_000);
        assertTrue(taxed.transfer(address(splitter), 1_000), "transfer");
        assertEq(splitter.received(address(taxed)), 990, "received");
        // 990 × 875 / 975 = 888.46 and 990 × 100 / 975 = 101.54, both rounded down.
        assertEq(splitter.release(address(taxed), platform), 888, "platform released");
        assertEq(splitter.release(address(taxed), operator), 101, "operator released");
        assertEq(taxed.balanceOf(platform), 880, "platform got 99 %");
        assertEq(taxed.balanceOf(operator), 100, "operator got 99 %");
        assertEq(taxed.balanceOf(address(splitter)), 1, "one unit left");
    }

    function _releaseOdd(bytes memory answer, bool accepted) private {
        OddReturnToken odd = new OddReturnToken(answer);
        odd.mint(address(splitter), 975);
        if (!accepted) {
            vm.expectRevert(abi.encodeWithSelector(FeeSplitter.TransferFailed.selector, address(odd), platform, 875));
        }
        splitter.release(address(odd), platform);
        assertEq(odd.balanceOf(platform), accepted ? 875 : 0, "paid");
    }
}

/// Why SplitterProxy isn't a plain EIP-1167 proxy.
contract PlainProxyTest is Test {
    address internal plain;
    StipendPayer internal payer;

    function setUp() public {
        address implementation = address(new Receiver());
        bytes memory code = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
        address created;
        assembly ("memory-safe") {
            created := create(0, add(code, 0x20), mload(code))
        }
        plain = created;
        payer = new StipendPayer();
    }

    /// A plain proxy's first DELEGATECALL in a transaction costs 2,600 gas, more than the 2,300 that transfer and send
    /// pass on, so it can't take the coin that way although its implementation would.
    function test_aPlainMinimalProxyRefusesAStipend() public {
        vm.deal(address(this), 2 ether);
        assertTrue(!payer.payWithSend{value: 1 ether}(payable(plain)), "refused within the stipend");
        (bool ok,) = plain.call{value: 1 ether}("");
        assertTrue(ok, "taken with more gas");
    }
}
