// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";
import {Balances, FeeOnTransferToken, MockToken, NoReturnToken} from "./utils/Mocks.sol";
import {Test, bound, named, vm} from "./utils/Test.sol";

/// What the invariant runner calls: payments to splitters (deployed or not), deployments and releases, keeping its own
/// record of what reached each splitter and what each payee was paid.
contract Handler {
    address public constant NATIVE = address(0);
    uint256 public constant PLATFORM_RATE = 875;

    FeeSplitterFactory public immutable factory;
    address public immutable platform;

    // Splitter i is the one for operators[i] at rates[i]. None is deployed at first.
    address[] public operators;
    uint256[] public rates;
    address[] public splitters;
    // The native coin, a plain token, one that returns nothing, and one that keeps 1 % of each transfer.
    address[] public tokens;

    mapping(address splitter => mapping(address token => uint256 amount)) public ghostReceived;
    mapping(address splitter => mapping(address token => mapping(address payee => uint256 amount))) public
        ghostReleased;

    constructor(address platform_) {
        platform = platform_;
        factory = new FeeSplitterFactory(platform_, PLATFORM_RATE, 1_875);
        _add(named("operator 1"), 100);
        _add(named("operator 1"), 1_000);
        _add(named("operator 2"), 0);
        _add(named("operator 3"), 1);
        tokens.push(NATIVE);
        tokens.push(address(new MockToken()));
        tokens.push(address(new NoReturnToken()));
        tokens.push(address(new FeeOnTransferToken()));
    }

    function pay(uint256 splitterSeed, uint256 tokenSeed, uint256 amount, bool withStipend) external {
        address splitter = splitters[splitterSeed % splitters.length];
        address token = tokens[tokenSeed % tokens.length];
        amount = bound(amount, 0, 1e30);
        uint256 before = balanceOf(token, splitter);
        if (token == NATIVE) {
            vm.deal(address(this), amount);
            if (withStipend) {
                payable(splitter).transfer(amount);
            } else {
                (bool ok,) = splitter.call{value: amount}("");
                require(ok, "coin refused");
            }
        } else {
            Balances(token).mint(address(this), amount);
            (bool ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", splitter, amount));
            require(ok, "token refused");
        }
        ghostReceived[splitter][token] += balanceOf(token, splitter) - before;
    }

    function deploy(uint256 splitterSeed) external {
        uint256 i = splitterSeed % splitters.length;
        require(factory.deploy(operators[i], rates[i]) == splitters[i], "deployed elsewhere");
    }

    function release(uint256 splitterSeed, uint256 tokenSeed, bool toOperator) external {
        uint256 i = splitterSeed % splitters.length;
        FeeSplitter splitter = FeeSplitter(splitters[i]);
        if (address(splitter).code.length == 0) return;
        address token = tokens[tokenSeed % tokens.length];
        address payee = toOperator ? operators[i] : platform;
        uint256 due = splitter.releasable(token, payee);
        if (due == 0) return;
        require(splitter.release(token, payee) == due, "paid other than releasable");
        ghostReleased[address(splitter)][token][payee] += due;
    }

    function counts() external view returns (uint256 splitterCount, uint256 tokenCount) {
        return (splitters.length, tokens.length);
    }

    function balanceOf(address token, address account) public view returns (uint256) {
        return token == NATIVE ? account.balance : Balances(token).balanceOf(account);
    }

    function _add(address operator, uint256 rate) private {
        operators.push(operator);
        rates.push(rate);
        splitters.push(factory.predict(operator, rate));
    }
}

contract FeeSplitterInvariantTest is Test {
    address internal immutable platform = named("platform");
    Handler internal handler;

    function setUp() public {
        handler = new Handler(platform);
        _targetContracts.push(address(handler));
    }

    /// No splitter pays out more of a token than it has received, and its record of payments adds up.
    function invariant_releasedNeverExceedsReceived() public view {
        (uint256 splitterCount, uint256 tokenCount) = handler.counts();
        for (uint256 i; i < splitterCount; ++i) {
            FeeSplitter splitter = FeeSplitter(handler.splitters(i));
            if (address(splitter).code.length == 0) continue;
            address operator = handler.operators(i);
            for (uint256 j; j < tokenCount; ++j) {
                address token = handler.tokens(j);
                uint256 platformPaid = splitter.released(token, platform);
                uint256 operatorPaid = splitter.released(token, operator);
                assertEq(platformPaid + operatorPaid, splitter.totalReleased(token), "payments add up");
                assertLe(splitter.totalReleased(token), handler.ghostReceived(address(splitter), token), "released");
                assertEq(platformPaid, handler.ghostReleased(address(splitter), token, platform), "platform paid");
                assertEq(operatorPaid, handler.ghostReleased(address(splitter), token, operator), "operator paid");
            }
        }
    }

    /// What a splitter holds plus what it has paid out is what reached it, deployed or not.
    function invariant_heldPlusReleasedIsReceived() public view {
        (uint256 splitterCount, uint256 tokenCount) = handler.counts();
        for (uint256 i; i < splitterCount; ++i) {
            FeeSplitter splitter = FeeSplitter(handler.splitters(i));
            bool deployed = address(splitter).code.length != 0;
            for (uint256 j; j < tokenCount; ++j) {
                address token = handler.tokens(j);
                uint256 received = handler.ghostReceived(address(splitter), token);
                uint256 released = deployed ? splitter.totalReleased(token) : 0;
                assertEq(handler.balanceOf(token, address(splitter)) + released, received, "held plus released");
                if (deployed) assertEq(splitter.received(token), received, "received");
            }
        }
    }

    /// Each payee's paid plus releasable is its exact share of all received, rounded down, and at most one unit of
    /// each token is left that neither can release.
    function invariant_eachPayeeIsOwedExactlyItsShare() public view {
        (uint256 splitterCount, uint256 tokenCount) = handler.counts();
        for (uint256 i; i < splitterCount; ++i) {
            FeeSplitter splitter = FeeSplitter(handler.splitters(i));
            if (address(splitter).code.length == 0) continue;
            for (uint256 j; j < tokenCount; ++j) {
                _checkShares(splitter, handler.operators(i), handler.rates(i), handler.tokens(j));
            }
        }
    }

    /// At the end of each run, deploy every splitter and pay everything out: each payee has then been paid exactly its
    /// share of all its splitter received, and at most one unit is left in each.
    function afterInvariant() public {
        (uint256 splitterCount, uint256 tokenCount) = handler.counts();
        for (uint256 i; i < splitterCount; ++i) {
            handler.deploy(i);
            FeeSplitter splitter = FeeSplitter(handler.splitters(i));
            for (uint256 j; j < tokenCount; ++j) {
                handler.release(i, j, false);
                handler.release(i, j, true);
                address token = handler.tokens(j);
                uint256 received = handler.ghostReceived(address(splitter), token);
                uint256 totalRate = handler.PLATFORM_RATE() + handler.rates(i);
                assertEq(
                    splitter.released(token, platform),
                    received * handler.PLATFORM_RATE() / totalRate,
                    "platform's share paid"
                );
                assertEq(
                    splitter.released(token, handler.operators(i)),
                    received * handler.rates(i) / totalRate,
                    "operator's share paid"
                );
                assertLe(handler.balanceOf(token, address(splitter)), 1, "left over");
            }
        }
    }

    function _checkShares(FeeSplitter splitter, address operator, uint256 rate, address token) private view {
        uint256 received = handler.ghostReceived(address(splitter), token);
        uint256 totalRate = handler.PLATFORM_RATE() + rate;
        uint256 platformDue = splitter.releasable(token, platform);
        uint256 operatorDue = splitter.releasable(token, operator);
        assertEq(
            splitter.released(token, platform) + platformDue,
            received * handler.PLATFORM_RATE() / totalRate,
            "platform's share"
        );
        assertEq(splitter.released(token, operator) + operatorDue, received * rate / totalRate, "operator's share");
        assertLe(handler.balanceOf(token, address(splitter)) - platformDue - operatorDue, 1, "left over");
    }
}
