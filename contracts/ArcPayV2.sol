// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ArcPay V2 — payments with Miden-style recallable transfers
/// @author Dnyelfy
contract ArcPayV2 {
    event PaymentSent(address indexed from, address indexed to, uint256 amount, string note);
    event RecallableCreated(uint256 indexed id, address indexed from, address indexed to, uint256 amount, uint256 recallAfter, string note);
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);
    event Recalled(uint256 indexed id, address indexed from, uint256 amount);

    struct RPay {
        address from;
        address to;
        uint256 amount;
        uint256 recallAfter; // bu zamandan sonra gonderen geri alabilir
        uint8 status;        // 0 = bekliyor, 1 = alindi, 2 = geri alindi
    }

    RPay[] public rpays;
    mapping(address => uint256[]) private _sent;
    mapping(address => uint256[]) private _received;

    /// Aninda odeme (v1 ile ayni)
    function pay(address payable to, string calldata note) external payable {
        require(msg.value > 0, "zero amount");
        (bool ok, ) = to.call{value: msg.value}("");
        require(ok, "transfer failed");
        emit PaymentSent(msg.sender, to, msg.value, note);
    }

    /// Esit bolunmus odeme (v1 ile ayni)
    function splitPay(address payable[] calldata to, string calldata note) external payable {
        require(to.length > 0 && to.length <= 20, "1-20 recipients");
        uint256 share = msg.value / to.length;
        require(share > 0, "zero share");
        for (uint256 i = 0; i < to.length; i++) {
            (bool ok, ) = to[i].call{value: share}("");
            require(ok, "transfer failed");
            emit PaymentSent(msg.sender, to[i], share, note);
        }
        uint256 dust = msg.value - share * to.length;
        if (dust > 0) {
            (bool ok2, ) = payable(msg.sender).call{value: dust}("");
            ok2;
        }
    }

    /// Geri alinabilir odeme: alici hemen cekebilir,
    /// cekmezse recallSeconds sonra gonderen geri alabilir
    function payRecallable(address to, uint256 recallSeconds, string calldata note) external payable returns (uint256 id) {
        require(msg.value > 0, "zero amount");
        require(to != address(0), "bad recipient");
        require(recallSeconds >= 60 && recallSeconds <= 30 days, "60s - 30d window");
        id = rpays.length;
        rpays.push(RPay(msg.sender, to, msg.value, block.timestamp + recallSeconds, 0));
        _sent[msg.sender].push(id);
        _received[to].push(id);
        emit RecallableCreated(id, msg.sender, to, msg.value, block.timestamp + recallSeconds, note);
    }

    /// Alici parayi ceker (sure dolmadan da dolduktan sonra da, geri alinmadiysa)
    function claim(uint256 id) external {
        RPay storage p = rpays[id];
        require(p.status == 0, "not claimable");
        require(msg.sender == p.to, "not recipient");
        p.status = 1;
        (bool ok, ) = payable(p.to).call{value: p.amount}("");
        require(ok, "transfer failed");
        emit Claimed(id, p.to, p.amount);
    }

    /// Gonderen suresi dolan, alinmamis odemeyi geri ceker
    function recall(uint256 id) external {
        RPay storage p = rpays[id];
        require(p.status == 0, "not recallable");
        require(msg.sender == p.from, "not sender");
        require(block.timestamp >= p.recallAfter, "window not open yet");
        p.status = 2;
        (bool ok, ) = payable(p.from).call{value: p.amount}("");
        require(ok, "transfer failed");
        emit Recalled(id, p.from, p.amount);
    }

    function sentBy(address a) external view returns (uint256[] memory) { return _sent[a]; }
    function receivedBy(address a) external view returns (uint256[] memory) { return _received[a]; }
    function total() external view returns (uint256) { return rpays.length; }
}
