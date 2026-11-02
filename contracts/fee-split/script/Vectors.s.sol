// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";
import {SplitterProxy} from "../src/SplitterProxy.sol";

interface VmVectors {
    function startBroadcast() external;
    function stopBroadcast() external;
    function toString(address value) external pure returns (string memory);
    function toString(bytes calldata value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
    function createDir(string calldata path, bool recursive) external;
    function writeFile(string calldata path, string calldata data) external;
}

/// Writes test/vectors/splitters.json: what real factories work out and create, for the TypeScript that works a
/// splitter's address out off-chain (packages/config/src/fee-split.ts) to be tested against. For each factory, its
/// implementation and its splitters' creation code; for each operator and rate, the address predict returns, where
/// deploy then creates the splitter; and what predict refuses, by the factory's error names.
///
/// Run it on a fresh anvil with `pnpm run vectors`, like the dry run: it has no --broadcast and sends nothing. The
/// first factory is the README's dry run, so its address and its splitter for 0x2222…2222 at 100 are the README's. All
/// the addresses are placeholders.
contract Vectors {
    // Named `vm`, as Foundry's documentation and every Foundry script call it.
    // forge-lint: disable-next-line(screaming-snake-case-const)
    VmVectors internal constant vm = VmVectors(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant DIR = "test/vectors";
    string internal constant PATH = "test/vectors/splitters.json";

    /// The README's dry-run factory: the first contract forge's default sender creates on a fresh chain.
    address internal constant README_FACTORY = 0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519;

    address internal constant PLATFORM = 0x1111111111111111111111111111111111111111;
    address internal constant OTHER_PLATFORM = 0x5555555555555555555555555555555555555555;
    address internal constant OPERATOR = 0x2222222222222222222222222222222222222222;
    address internal constant OPERATOR_2 = 0x3333333333333333333333333333333333333333;
    address internal constant OPERATOR_3 = 0x4444444444444444444444444444444444444444;

    struct Case {
        uint256 factory;
        address operator;
        uint256 operatorRate;
    }

    function run() external {
        vm.startBroadcast();
        FeeSplitterFactory[4] memory factories = [
            // The README's dry run: the platform at 0.875 %, a cap of 1.875 %.
            new FeeSplitterFactory(PLATFORM, 875, 1_875),
            // The same rates for another platform: another factory, other addresses.
            new FeeSplitterFactory(OTHER_PLATFORM, 875, 1_875),
            // No platform fee, so an operator's rate of 0 is refused.
            new FeeSplitterFactory(PLATFORM, 0, 1_875),
            // The platform takes the whole cap, so only an operator's rate of 0 is allowed.
            new FeeSplitterFactory(OTHER_PLATFORM, 100_000, 100_000)
        ];
        require(address(factories[0]) == README_FACTORY, "run this on a fresh anvil, from forge's default sender");

        Case[11] memory splitters = [
            _case(0, OPERATOR, 100), // the README's sample splitter
            _case(0, OPERATOR, 0),
            _case(0, OPERATOR, 1),
            _case(0, OPERATOR, 1_000),
            _case(0, OPERATOR_2, 100),
            _case(0, OPERATOR_2, 875),
            _case(1, OPERATOR, 100),
            _case(1, PLATFORM, 1_000), // the first factory's platform is an operator like any other here
            _case(2, OPERATOR, 1),
            _case(2, OPERATOR_3, 1_875),
            _case(3, OPERATOR, 0)
        ];
        string[11] memory splitterLines;
        for (uint256 i = 0; i < splitters.length; ++i) {
            Case memory c = splitters[i];
            FeeSplitterFactory factory = factories[c.factory];
            address predicted = factory.predict(c.operator, c.operatorRate);
            address deployed = factory.deploy(c.operator, c.operatorRate);
            require(deployed == predicted, "deploy did not create the splitter where predict said");
            require(deployed.code.length == SplitterProxy.RUNTIME_SIZE, "the splitter's code is not the proxy");
            splitterLines[i] = _splitterJson(factory, c, deployed);
        }
        vm.stopBroadcast();

        // In the order the factory checks them: an operator that is both zero and too high is refused as zero.
        Case[9] memory refusals = [
            _case(0, address(0), 100),
            _case(0, PLATFORM, 100),
            _case(0, OPERATOR, 1_001),
            _case(0, OPERATOR, 2 ** 32 + 100),
            _case(2, OPERATOR, 0),
            _case(2, PLATFORM, 0),
            _case(3, OPERATOR, 1),
            _case(3, address(0), 0),
            _case(3, OTHER_PLATFORM, 0)
        ];
        string[9] memory refusalLines;
        for (uint256 i = 0; i < refusals.length; ++i) {
            Case memory c = refusals[i];
            refusalLines[i] = _refusalJson(factories[c.factory], c);
        }

        string memory json =
            '{\n  "$comment": "Written by script/Vectors.s.sol (pnpm run vectors, on a fresh anvil). Do not edit.",\n';
        json = string.concat(json, '  "factories": [\n');
        for (uint256 i = 0; i < factories.length; ++i) {
            json = string.concat(json, _factoryJson(factories[i]), i + 1 < factories.length ? ",\n" : "\n");
        }
        json = string.concat(json, '  ],\n  "splitters": [\n');
        for (uint256 i = 0; i < splitterLines.length; ++i) {
            json = string.concat(json, splitterLines[i], i + 1 < splitterLines.length ? ",\n" : "\n");
        }
        json = string.concat(json, '  ],\n  "refusals": [\n');
        for (uint256 i = 0; i < refusalLines.length; ++i) {
            json = string.concat(json, refusalLines[i], i + 1 < refusalLines.length ? ",\n" : "\n");
        }
        vm.createDir(DIR, true);
        // Writes one file, under the one directory foundry.toml's fs_permissions allows.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.writeFile(PATH, string.concat(json, "  ]\n}\n"));
    }

    function _case(uint256 factory, address operator, uint256 operatorRate) internal pure returns (Case memory) {
        return Case({factory: factory, operator: operator, operatorRate: operatorRate});
    }

    function _factoryJson(FeeSplitterFactory factory) internal view returns (string memory) {
        string memory head = string.concat(
            '    {"address": "',
            vm.toString(address(factory)),
            '", "platform": "',
            vm.toString(factory.platform()),
            '", "platformRate": ',
            vm.toString(factory.platformRate()),
            ', "maxTotalRate": ',
            vm.toString(factory.maxTotalRate())
        );
        return string.concat(
            head,
            ', "implementation": "',
            vm.toString(factory.implementation()),
            '", "initCode": "',
            vm.toString(SplitterProxy.initCode(factory.implementation())),
            '", "initCodeHash": "',
            vm.toString(factory.initCodeHash()),
            '"}'
        );
    }

    function _splitterJson(FeeSplitterFactory factory, Case memory c, address splitter)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            _caseJson(factory, c),
            ', "salt": "',
            vm.toString(factory.salt(c.operator, c.operatorRate)),
            '", "splitter": "',
            vm.toString(splitter),
            '"}'
        );
    }

    function _refusalJson(FeeSplitterFactory factory, Case memory c) internal view returns (string memory) {
        string memory error;
        try factory.predict(c.operator, c.operatorRate) returns (address) {
            revert("predict accepted a case listed as refused");
        } catch (bytes memory reason) {
            // A custom error's data starts with its 4-byte selector, and anything else matches no name below.
            // forge-lint: disable-next-line(unsafe-typecast)
            error = _errorName(bytes4(reason));
        }
        return string.concat(_caseJson(factory, c), ', "error": "', error, '"}');
    }

    function _caseJson(FeeSplitterFactory factory, Case memory c) internal pure returns (string memory) {
        return string.concat(
            '    {"factory": "',
            vm.toString(address(factory)),
            '", "operator": "',
            vm.toString(c.operator),
            '", "operatorRate": ',
            vm.toString(c.operatorRate)
        );
    }

    function _errorName(bytes4 selector) internal pure returns (string memory) {
        if (selector == FeeSplitterFactory.ZeroAddress.selector) return "ZeroAddress";
        if (selector == FeeSplitterFactory.OperatorIsPlatform.selector) return "OperatorIsPlatform";
        if (selector == FeeSplitterFactory.RateTooHigh.selector) return "RateTooHigh";
        if (selector == FeeSplitterFactory.ZeroRates.selector) return "ZeroRates";
        revert("predict refused with an error this script doesn't know");
    }
}
