// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {FeeSplitterFactory} from "../src/FeeSplitterFactory.sol";

interface VmScript {
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Deploys a FeeSplitterFactory. The signer comes from the forge command line (an encrypted keystore via --account,
/// or a hardware wallet via --ledger); this script never reads a key. Everything else comes from the environment:
///
/// - PLATFORM_RECEIVER: the platform's address on Sonic. Required. The zero address is refused.
/// - PLATFORM_RATE: the platform's rate, in parts per 100,000 of the amount sold. Default 875, which is 0.875 %.
/// - MAX_TOTAL_RATE: the most the platform's and an operator's rates may add up to. Default 1,000, which is 1 %.
/// - SAMPLE_OPERATOR, and SAMPLE_OPERATOR_RATE (default 100): optional, an operator whose splitter address to print.
///
/// The return values are what forge prints. See README.md.
contract Deploy {
    // Named `vm`, as Foundry's documentation and every Foundry script call it.
    // forge-lint: disable-next-line(screaming-snake-case-const)
    VmScript internal constant vm = VmScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run()
        external
        returns (
            FeeSplitterFactory factory,
            address platform,
            uint256 platformRate,
            uint256 maxTotalRate,
            address implementation,
            bytes32 initCodeHash,
            address sampleSplitter
        )
    {
        platform = vm.envOr("PLATFORM_RECEIVER", address(0));
        require(platform != address(0), "PLATFORM_RECEIVER is not set, or is the zero address");
        platformRate = vm.envOr("PLATFORM_RATE", uint256(875));
        maxTotalRate = vm.envOr("MAX_TOTAL_RATE", uint256(1_000));
        address sampleOperator = vm.envOr("SAMPLE_OPERATOR", address(0));
        uint256 sampleOperatorRate = vm.envOr("SAMPLE_OPERATOR_RATE", uint256(100));

        vm.startBroadcast();
        factory = new FeeSplitterFactory(platform, platformRate, maxTotalRate);
        vm.stopBroadcast();

        implementation = factory.implementation();
        initCodeHash = factory.initCodeHash();
        if (sampleOperator != address(0)) sampleSplitter = factory.predict(sampleOperator, sampleOperatorRate);
    }
}
