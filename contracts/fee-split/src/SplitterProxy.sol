// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// The proxy every splitter is: an EIP-1167 minimal proxy with one addition.
///
/// A call with no calldata, which is how the native coin is usually paid, never reaches the implementation: the proxy
/// logs NativeReceived(msg.value) itself and stops, in about 1,050 gas. A plain EIP-1167 proxy would delegate it, and
/// a cold DELEGATECALL alone costs 2,600 gas (EIP-2929), more than the 2,300 that Solidity's transfer and send
/// forward. A splitter can therefore take native S however a payer sends it. Every call with calldata is delegated
/// exactly as in EIP-1167.
library SplitterProxy {
    /// FeeSplitter.NativeReceived(uint256)'s topic.
    bytes32 internal constant NATIVE_RECEIVED = keccak256("NativeReceived(uint256)");

    /// Length of the runtime code the creation code returns.
    uint256 internal constant RUNTIME_SIZE = 91;

    /// The creation code of a splitter that delegates to `implementation`.
    ///
    ///   creation  3d 605b 80 600a 3d 39 81 f3       copy the 91-byte runtime from offset 10 to memory, return it
    ///   runtime   36 602d 57                        any calldata: jump to 0x2d
    ///             34 3d 52                          mstore(0, callvalue)
    ///             7f <topic> 6020 3d a1 00          log1(0, 32, topic), stop
    ///   0x2d      5b                                EIP-1167's runtime from here on, with its jump target
    ///             363d3d373d3d3d363d73 <impl>       moved from 0x2b to 0x59 (0x2e bytes later)
    ///             5af43d82803e903d91605957fd5bf3
    function initCode(address implementation) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"3d605b80600a3d3981f3",
            hex"36602d57343d527f",
            NATIVE_RECEIVED,
            hex"60203da1005b363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91605957fd5bf3"
        );
    }
}
