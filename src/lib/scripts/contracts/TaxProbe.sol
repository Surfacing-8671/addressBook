// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * Injected via `eth_call` state override at the address of a REAL token
 * holder. Because the code lives at that holder's address, `msg.sender`
 * inside the token's transfer() is the holder and the balance is genuine, so
 * no minting or storage-slot guessing is needed.
 *
 * Returns raw before/after readings; all deltas are computed off-chain in
 * BigInt so a reflection token that *increases* a balance cannot underflow.
 */
contract TaxProbe {
    function probe(address token, address to, uint256 amount)
        external
        returns (
            bool ok,
            uint256 fromBefore,
            uint256 fromAfter,
            uint256 toBefore,
            uint256 toAfter,
            uint256 supplyBefore,
            uint256 supplyAfter
        )
    {
        fromBefore = _balanceOf(token, address(this));
        toBefore = _balanceOf(token, to);
        supplyBefore = _totalSupply(token);

        // Low-level so that non-standard ERC20s returning no data still work.
        (ok, ) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount)
        );

        fromAfter = _balanceOf(token, address(this));
        toAfter = _balanceOf(token, to);
        supplyAfter = _totalSupply(token);
    }

    function _balanceOf(address token, address who)
        private
        view
        returns (uint256 value)
    {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(0x70a08231, who)
        );
        if (success && data.length >= 32) value = abi.decode(data, (uint256));
    }

    function _totalSupply(address token) private view returns (uint256 value) {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(0x18160ddd)
        );
        if (success && data.length >= 32) value = abi.decode(data, (uint256));
    }
}
