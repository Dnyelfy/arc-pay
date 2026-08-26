// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * TreasuryAgent — Autonomous multi-currency treasury for Arc Testnet
 * Pyth EUR/USD + confidence-aware rebalancing. v1.1 (stack-depth fix)
 *
 * Pyth (Arc Testnet): 0x2880aB155794e7179c9eE2e38200202908C17B43
 * USDC:               0x3600000000000000000000000000000000000000
 * EURC:               0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
 * EUR/USD feed id:    0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b
 */

interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract TreasuryAgent {
    address public owner;
    IPyth public immutable pyth;
    IERC20 public immutable usdc;
    IERC20 public immutable eurc;
    bytes32 public immutable eurUsdFeedId;

    uint16 public targetUsdcBps = 7000;
    uint16 public driftBps = 300;
    uint16 public maxConfBps = 50;
    uint16 public keeperBonusBps = 10;
    uint256 public maxPriceAge = 120;
    bool public paused;

    event Deposited(address indexed from, address token, uint256 amount);
    event Withdrawn(address token, uint256 amount);
    event ParamsUpdated(uint16 targetUsdcBps, uint16 driftBps, uint16 maxConfBps, uint16 keeperBonusBps);
    event RebalanceDeferred(uint256 confBps, int64 price, string reason);
    event AlreadyBalanced(uint256 currentUsdcBps, int64 price);
    event Rebalanced(
        address indexed keeper,
        bool soldUsdc,
        uint256 amountOut,
        uint256 amountIn,
        int64 price,
        uint256 confBps
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _pyth, address _usdc, address _eurc, bytes32 _eurUsdFeedId) {
        owner = msg.sender;
        pyth = IPyth(_pyth);
        usdc = IERC20(_usdc);
        eurc = IERC20(_eurc);
        eurUsdFeedId = _eurUsdFeedId;
    }

    // ---------------- Owner ----------------

    function deposit(address token, uint256 amount) external {
        require(token == address(usdc) || token == address(eurc), "bad token");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(owner, amount), "transfer failed");
        emit Withdrawn(token, amount);
    }

    function setParams(
        uint16 _targetUsdcBps,
        uint16 _driftBps,
        uint16 _maxConfBps,
        uint16 _keeperBonusBps,
        uint256 _maxPriceAge
    ) external onlyOwner {
        require(_targetUsdcBps <= 10000, "target > 100%");
        require(_driftBps <= 5000 && _maxConfBps <= 1000 && _keeperBonusBps <= 100, "param out of range");
        targetUsdcBps = _targetUsdcBps;
        driftBps = _driftBps;
        maxConfBps = _maxConfBps;
        keeperBonusBps = _keeperBonusBps;
        maxPriceAge = _maxPriceAge;
        emit ParamsUpdated(_targetUsdcBps, _driftBps, _maxConfBps, _keeperBonusBps);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero addr");
        owner = newOwner;
    }

    // ---------------- Agent core ----------------

    function rebalance(bytes[] calldata updateData) external payable {
        require(!paused, "paused");

        uint256 fee = pyth.getUpdateFee(updateData);
        require(msg.value >= fee, "insufficient pyth fee");
        pyth.updatePriceFeeds{value: fee}(updateData);
        if (msg.value > fee) {
            (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
            require(ok, "refund failed");
        }

        IPyth.Price memory p = pyth.getPriceNoOlderThan(eurUsdFeedId, maxPriceAge);
        require(p.price > 0, "invalid price");
        require(p.expo <= 0 && p.expo >= -18, "unexpected expo");

        uint256 price = uint256(uint64(p.price));
        uint256 confBps = (uint256(p.conf) * 10000) / price;

        // Confidence guard — the agent's risk brain.
        if (confBps > maxConfBps) {
            emit RebalanceDeferred(confBps, p.price, "confidence too wide, market stressed");
            return;
        }

        _execute(price, 10 ** uint256(uint32(-p.expo)), p.price, confBps);
    }

    function _execute(uint256 price, uint256 scale, int64 rawPrice, uint256 confBps) internal {
        uint256 usdcBal = usdc.balanceOf(address(this));
        uint256 eurcValue = (eurc.balanceOf(address(this)) * price) / scale;
        uint256 total = usdcBal + eurcValue;

        if (total == 0) {
            emit RebalanceDeferred(confBps, rawPrice, "empty treasury");
            return;
        }

        uint256 currentUsdcBps = (usdcBal * 10000) / total;
        uint256 drift = currentUsdcBps > targetUsdcBps
            ? currentUsdcBps - targetUsdcBps
            : targetUsdcBps - currentUsdcBps;

        if (drift <= driftBps) {
            emit AlreadyBalanced(currentUsdcBps, rawPrice);
            return;
        }

        uint256 tradeValue = (drift * total) / 10000; // in USDC terms
        if (currentUsdcBps > targetUsdcBps) {
            _sellUsdc(tradeValue, price, scale, rawPrice, confBps);
        } else {
            _sellEurc(tradeValue, price, scale, rawPrice, confBps);
        }
    }

    /// Treasury over-weight USDC: keeper supplies EURC, receives USDC + bonus.
    function _sellUsdc(uint256 excessUsdc, uint256 price, uint256 scale, int64 rawPrice, uint256 confBps) internal {
        uint256 eurcIn = (excessUsdc * scale) / price;
        uint256 usdcOut = (excessUsdc * (10000 + keeperBonusBps)) / 10000;
        uint256 bal = usdc.balanceOf(address(this));
        if (usdcOut > bal) usdcOut = bal;

        require(eurc.transferFrom(msg.sender, address(this), eurcIn), "EURC pull failed");
        require(usdc.transfer(msg.sender, usdcOut), "USDC send failed");

        emit Rebalanced(msg.sender, true, usdcOut, eurcIn, rawPrice, confBps);
    }

    /// Treasury over-weight EURC: keeper supplies USDC, receives EURC + bonus.
    function _sellEurc(uint256 deficitUsdc, uint256 price, uint256 scale, int64 rawPrice, uint256 confBps) internal {
        uint256 eurcOut = ((deficitUsdc * (10000 + keeperBonusBps)) / 10000) * scale / price;
        uint256 bal = eurc.balanceOf(address(this));
        if (eurcOut > bal) eurcOut = bal;

        require(usdc.transferFrom(msg.sender, address(this), deficitUsdc), "USDC pull failed");
        require(eurc.transfer(msg.sender, eurcOut), "EURC send failed");

        emit Rebalanced(msg.sender, false, eurcOut, deficitUsdc, rawPrice, confBps);
    }

    // ---------------- Views ----------------

    function getStatus()
        external
        view
        returns (
            uint256 usdcBal,
            uint256 eurcBal,
            uint16 _targetUsdcBps,
            uint16 _driftBps,
            uint16 _maxConfBps,
            uint16 _keeperBonusBps,
            bool _paused
        )
    {
        return (
            usdc.balanceOf(address(this)),
            eurc.balanceOf(address(this)),
            targetUsdcBps,
            driftBps,
            maxConfBps,
            keeperBonusBps,
            paused
        );
    }

    receive() external payable {}
}
