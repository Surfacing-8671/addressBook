// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// Positive control ONLY. Never deployed - injected via state override so we
/// can prove the probe actually detects a tax instead of always printing 0.
contract MockTaxToken {
    mapping(address => uint256) public balanceOf; // slot 0
    uint256 public totalSupply;                   // slot 1
    uint256 public mode;                          // slot 2: 0=burn fee, 1=fee to wallet

    address constant FEE_WALLET = 0x00000000000000000000000000000000000Fee01;

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 fee = (amount * 1000) / 10000; // 10%
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        if (mode == 0) {
            totalSupply -= fee;          // burn-on-transfer
        } else {
            balanceOf[FEE_WALLET] += fee; // fee routed to a wallet
        }
        return true;
    }
}
