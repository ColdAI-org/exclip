// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";
import {SplitterProxy} from "../src/SplitterProxy.sol";
import {Fixture} from "./utils/Fixture.sol";
import {named, vm} from "./utils/Test.sol";

contract FeeSplitterFactoryTest is Fixture {
    // The factory -------------------------------------------------------------------------------------------------

    function test_constructorSetsTheRates() public view {
        assertEq(factory.platform(), platform, "platform");
        assertEq(factory.platformRate(), PLATFORM_RATE, "platformRate");
        assertEq(factory.maxTotalRate(), MAX_TOTAL_RATE, "maxTotalRate");
        assertEq(factory.RATE_SCALE(), 100_000, "RATE_SCALE");
    }

    function test_theImplementationIsTheFactorysFirstCreation() public view {
        FeeSplitter implementation = FeeSplitter(factory.implementation());
        assertEq(address(implementation), vm.computeCreateAddress(address(factory), 1), "implementation");
        assertEq(implementation.factory(), address(factory), "factory");
        assertEq(implementation.platform(), platform, "platform");
        assertEq(implementation.platformRate(), PLATFORM_RATE, "platformRate");
    }

    function test_initCodeHashIsTheProxysCreationCode() public view {
        assertEq(factory.initCodeHash(), keccak256(SplitterProxy.initCode(factory.implementation())), "initCodeHash");
    }

    function test_constructorRefusesTheZeroAddress() public {
        vm.expectRevert(FeeSplitterFactory.ZeroAddress.selector);
        new FeeSplitterFactory(address(0), PLATFORM_RATE, MAX_TOTAL_RATE);
    }

    function test_constructorRefusesBadRates() public {
        vm.expectRevert(FeeSplitterFactory.BadRates.selector);
        new FeeSplitterFactory(platform, 0, 0);
        vm.expectRevert(FeeSplitterFactory.BadRates.selector);
        new FeeSplitterFactory(platform, PLATFORM_RATE, 100_001);
        vm.expectRevert(FeeSplitterFactory.BadRates.selector);
        new FeeSplitterFactory(platform, MAX_TOTAL_RATE + 1, MAX_TOTAL_RATE);
    }

    function test_thePlatformMayTakeTheWholeCap() public {
        FeeSplitterFactory full = new FeeSplitterFactory(platform, 100_000, 100_000);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitterFactory.RateTooHigh.selector, 1, 0));
        full.predict(operator, 1);
        FeeSplitter platformOnly = FeeSplitter(full.deploy(operator, 0));
        token.mint(address(platformOnly), 1_000);
        assertEq(platformOnly.releasable(address(token), platform), 1_000, "platform");
    }

    // predict and deploy -----------------------------------------------------------------------------------------

    function test_predictIsTheCreate2Address() public view {
        bytes32 salt = keccak256(abi.encode(operator, OPERATOR_RATE));
        assertEq(factory.salt(operator, OPERATOR_RATE), salt, "salt");
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, factory.initCodeHash()));
        assertEq(factory.predict(operator, OPERATOR_RATE), address(uint160(uint256(hash))), "predict");
        assertEq(
            factory.predict(operator, OPERATOR_RATE),
            vm.computeCreate2Address(salt, factory.initCodeHash(), address(factory)),
            "computeCreate2Address"
        );
        assertEq(address(splitter), factory.predict(operator, OPERATOR_RATE), "deployed there");
    }

    function test_eachOperatorAndRateHasItsOwnAddress() public {
        address a = factory.predict(operator, 100);
        address b = factory.predict(operator, 101);
        address c = factory.predict(stranger, 100);
        assertTrue(a != b && a != c && b != c, "three addresses");
        FeeSplitterFactory twin = new FeeSplitterFactory(platform, PLATFORM_RATE, MAX_TOTAL_RATE);
        assertTrue(twin.predict(operator, 100) != a, "another factory, another address");
    }

    function test_deployCreatesTheProxyAndInitializesIt() public {
        address other = named("operator 2");
        address predicted = factory.predict(other, 125);
        assertEq(predicted.code.length, 0, "nothing there yet");

        vm.expectEmit(true, true, false, true, address(factory));
        emit FeeSplitterFactory.SplitterDeployed(predicted, other, 125);
        FeeSplitter deployed = FeeSplitter(factory.deploy(other, 125));

        assertEq(address(deployed), predicted, "address");
        assertEq(deployed.operator(), other, "operator");
        assertEq(deployed.operatorRate(), 125, "operatorRate");
        assertEq(deployed.platform(), platform, "platform");
        assertEq(deployed.platformRate(), PLATFORM_RATE, "platformRate");
        assertEq(deployed.factory(), address(factory), "factory");
    }

    function test_theSplitterIsTheProxyAndNothingElse() public view {
        bytes memory runtime = abi.encodePacked(
            hex"36602d57343d527f",
            keccak256("NativeReceived(uint256)"),
            hex"60203da1005b363d3d373d3d3d363d73",
            factory.implementation(),
            hex"5af43d82803e903d91605957fd5bf3"
        );
        assertEq(runtime.length, SplitterProxy.RUNTIME_SIZE, "runtime size");
        assertEq(address(splitter).code, runtime, "runtime code");
        assertEq(
            SplitterProxy.initCode(factory.implementation()), bytes.concat(hex"3d605b80600a3d3981f3", runtime), "init"
        );
    }

    function test_deployingAgainReturnsTheSplitterAndChangesNothing() public {
        token.mint(address(splitter), 975);
        splitter.release(address(token), platform);
        vm.recordLogs();
        address again = factory.deploy(operator, OPERATOR_RATE);
        assertEq(again, address(splitter), "same splitter");
        assertEq(vm.getRecordedLogs().length, 0, "no event");
        assertEq(splitter.operator(), operator, "operator");
        assertEq(splitter.operatorRate(), OPERATOR_RATE, "operatorRate");
        assertEq(splitter.released(address(token), platform), 875, "released");
        assertEq(splitter.releasable(address(token), operator), 100, "releasable");
    }

    function test_anyoneMayDeploy() public {
        address other = named("operator 2");
        vm.prank(stranger);
        FeeSplitter deployed = FeeSplitter(factory.deploy(other, 50));
        assertEq(deployed.operator(), other, "operator");
        assertEq(deployed.operatorRate(), 50, "operatorRate");
    }

    function test_predictAndDeployRefuseTheZeroAddress() public {
        vm.expectRevert(FeeSplitterFactory.ZeroAddress.selector);
        factory.predict(address(0), OPERATOR_RATE);
        vm.expectRevert(FeeSplitterFactory.ZeroAddress.selector);
        factory.deploy(address(0), OPERATOR_RATE);
    }

    function test_predictAndDeployRefuseThePlatformAsOperator() public {
        vm.expectRevert(FeeSplitterFactory.OperatorIsPlatform.selector);
        factory.predict(platform, OPERATOR_RATE);
        vm.expectRevert(FeeSplitterFactory.OperatorIsPlatform.selector);
        factory.deploy(platform, OPERATOR_RATE);
    }

    function test_predictAndDeployRefuseARateAboveTheCap() public {
        bytes memory tooHigh = abi.encodeWithSelector(FeeSplitterFactory.RateTooHigh.selector, 1_001, 1_000);
        vm.expectRevert(tooHigh);
        factory.predict(operator, 1_001);
        vm.expectRevert(tooHigh);
        factory.deploy(operator, 1_001);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitterFactory.RateTooHigh.selector, type(uint256).max, 1_000));
        factory.deploy(operator, type(uint256).max);
        // A rate that wouldn't fit in the splitter's uint32 is refused too, rather than cut down.
        vm.expectRevert(abi.encodeWithSelector(FeeSplitterFactory.RateTooHigh.selector, 2 ** 32 + 100, 1_000));
        factory.deploy(operator, 2 ** 32 + 100);
        // The cap itself is allowed.
        assertEq(FeeSplitter(factory.deploy(operator, 1_000)).operatorRate(), 1_000, "at the cap");
    }

    function test_predictAndDeployRefuseTwoZeroRates() public {
        FeeSplitterFactory free = new FeeSplitterFactory(platform, 0, MAX_TOTAL_RATE);
        vm.expectRevert(FeeSplitterFactory.ZeroRates.selector);
        free.predict(operator, 0);
        vm.expectRevert(FeeSplitterFactory.ZeroRates.selector);
        free.deploy(operator, 0);
        assertEq(FeeSplitter(free.deploy(operator, 1)).operatorRate(), 1, "one is enough");
    }

    /// With too little gas, CREATE2 fails and returns zero, and deploy reverts with DeployFailed rather than carrying
    /// on. Somewhat more gas lets the creation through but not the initialization, and the whole call reverts.
    function test_deployRevertsWhenTheCreationRunsOutOfGas() public {
        address other = named("operator 2");
        address predicted = factory.predict(other, OPERATOR_RATE);
        bytes memory call = abi.encodeCall(FeeSplitterFactory.deploy, (other, OPERATOR_RATE));
        bytes memory deployFailed = abi.encodeWithSelector(FeeSplitterFactory.DeployFailed.selector);
        uint256 failures;
        bool ok;
        for (uint256 gas = 20_000; gas <= 200_000 && !ok; gas += 500) {
            bytes memory result;
            (ok, result) = address(factory).call{gas: gas}(call);
            if (!ok) {
                if (keccak256(result) == keccak256(deployFailed)) ++failures;
                assertEq(predicted.code.length, 0, "nothing left behind");
            }
        }
        assertTrue(failures != 0, "DeployFailed");
        assertTrue(ok, "deployed with enough gas");
        assertEq(FeeSplitter(predicted).operator(), other, "initialized");
    }
}
