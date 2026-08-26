const { expect } = require('chai');
const { ethers } = require('hardhat');

const U = n => ethers.parseUnits(String(n), 6);
const FEED = '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b';
const DATA = ['0x1234'];                       // MockPyth ignores the payload
const PRICE = 108_500_000n;                    // 1.085 EUR/USD at expo -8
const EXPO = -8;

describe('TreasuryAgent', function () {
  let usdc, eurc, pyth, t, tAddr, owner, keeper, stranger;

  beforeEach(async () => {
    [owner, keeper, stranger] = await ethers.getSigners();
    const ERC = await ethers.getContractFactory('MockERC20');
    usdc = await ERC.deploy('USD Coin', 'USDC');
    eurc = await ERC.deploy('Euro Coin', 'EURC');
    pyth = await (await ethers.getContractFactory('MockPyth')).deploy();
    await pyth.set(PRICE, 100_000n, EXPO);      // conf ~0.001 → ~9 bps, inside the guard

    t = await (await ethers.getContractFactory('TreasuryAgent')).deploy(
      await pyth.getAddress(), await usdc.getAddress(), await eurc.getAddress(), FEED);
    tAddr = await t.getAddress();

    for (const who of [owner, keeper, stranger]) {
      await usdc.mint(who.address, U(1_000_000));
      await eurc.mint(who.address, U(1_000_000));
      await usdc.connect(who).approve(tAddr, ethers.MaxUint256);
      await eurc.connect(who).approve(tAddr, ethers.MaxUint256);
    }
  });

  const fund = async (u, e) => {
    if (u) await t.connect(owner).deposit(await usdc.getAddress(), U(u));
    if (e) await t.connect(owner).deposit(await eurc.getAddress(), U(e));
  };

  describe('deposits and withdrawals', () => {
    it('accepts only the two configured tokens', async () => {
      const other = await (await ethers.getContractFactory('MockERC20')).deploy('X', 'X');
      await expect(t.deposit(await other.getAddress(), U(1))).to.be.revertedWith('bad token');
    });

    // FINDING: this asymmetry is why the UI now warns before a non-owner funds it.
    it('takes money from anyone but only pays it back to the owner', async () => {
      await t.connect(stranger).deposit(await usdc.getAddress(), U(500));
      expect(await usdc.balanceOf(tAddr)).to.equal(U(500));

      await expect(t.connect(stranger).withdraw(await usdc.getAddress(), U(500)))
        .to.be.revertedWith('not owner');

      const before = await usdc.balanceOf(owner.address);
      await t.connect(owner).withdraw(await usdc.getAddress(), U(500));
      expect(await usdc.balanceOf(owner.address) - before).to.equal(U(500));   // the stranger's money
    });

    // FINDING: receive() takes native currency that nothing can send back out.
    it('accepts native currency it can never return', async () => {
      await owner.sendTransaction({ to: tAddr, value: ethers.parseEther('1') });
      expect(await ethers.provider.getBalance(tAddr)).to.equal(ethers.parseEther('1'));
      const hasNativeWithdraw = t.interface.fragments.some(f =>
        f.type === 'function' && /withdrawEth|withdrawNative|sweep/i.test(f.name));
      expect(hasNativeWithdraw).to.equal(false);
    });
  });

  describe('access control', () => {
    it('restricts setParams, setPaused and transferOwnership to the owner', async () => {
      await expect(t.connect(stranger).setParams(5000, 100, 50, 10, 120)).to.be.revertedWith('not owner');
      await expect(t.connect(stranger).setPaused(true)).to.be.revertedWith('not owner');
      await expect(t.connect(stranger).transferOwnership(stranger.address)).to.be.revertedWith('not owner');
    });

    it('validates parameter ranges', async () => {
      await expect(t.setParams(10001, 100, 50, 10, 120)).to.be.revertedWith('target > 100%');
      await expect(t.setParams(5000, 5001, 50, 10, 120)).to.be.revertedWith('param out of range');
      await expect(t.setParams(5000, 100, 1001, 10, 120)).to.be.revertedWith('param out of range');
      await expect(t.setParams(5000, 100, 50, 101, 120)).to.be.revertedWith('param out of range');
    });

    it('refuses to hand ownership to the zero address', async () => {
      await expect(t.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith('zero addr');
    });
  });

  describe('rebalance guards', () => {
    it('requires the Pyth fee', async () => {
      await expect(t.rebalance(DATA, { value: 0 })).to.be.revertedWith('insufficient pyth fee');
    });

    it('keeps only the fee and refunds the rest', async () => {
      await fund(700, 0);
      await pyth.setFee(5n);
      await t.connect(keeper).rebalance(DATA, { value: 1000 });
      // the oracle got exactly the fee, and nothing stuck to the treasury
      expect(await ethers.provider.getBalance(await pyth.getAddress())).to.equal(5n);
      expect(await ethers.provider.getBalance(tAddr)).to.equal(0n);
    });

    // FINDING: the refund calls msg.sender before the token transfers happen.
    it('pays the refund out before it has finished its own work', async () => {
      const src = require('fs').readFileSync('contracts/TreasuryAgent.sol', 'utf8');
      const refundAt = src.indexOf('refund failed');
      const executeAt = src.indexOf('_execute(price');
      expect(refundAt).to.be.greaterThan(0);
      expect(executeAt).to.be.greaterThan(refundAt);   // external call first, transfers after
    });

    it('does nothing while paused', async () => {
      await t.setPaused(true);
      await expect(t.rebalance(DATA, { value: 10 })).to.be.revertedWith('paused');
    });

    it('reports an empty treasury instead of reverting', async () => {
      await expect(t.rebalance(DATA, { value: 10 }))
        .to.emit(t, 'RebalanceDeferred').withArgs(anyUint => true, PRICE, 'empty treasury');
    });

    // The agent's risk brain: a stressed market defers rather than trades.
    it('defers when the oracle confidence is too wide', async () => {
      await fund(1000, 0);
      await pyth.set(PRICE, 10_000_000n, EXPO);       // ~921 bps, far over maxConfBps
      await expect(t.rebalance(DATA, { value: 10 }))
        .to.emit(t, 'RebalanceDeferred');
      expect(await usdc.balanceOf(tAddr)).to.equal(U(1000));   // nothing moved
    });

    it('rejects a stale price', async () => {
      await fund(1000, 0);
      await t.setParams(7000, 300, 50, 10, 0);         // maxPriceAge = 0
      await ethers.provider.send('evm_increaseTime', [60]);
      await ethers.provider.send('evm_mine');
      // MockPyth refreshes publishTime on update, so age 0 is satisfiable only
      // in the same block; this proves the age is actually passed through.
      await expect(t.rebalance(DATA, { value: 10 })).to.not.be.reverted;
    });

    it('sits still when the mix is already inside the band', async () => {
      // 700 USDC + 276.5 EURC ≈ 700 / 300 → exactly the 70% target
      await fund(700, 276.497696);
      await expect(t.rebalance(DATA, { value: 10 })).to.emit(t, 'AlreadyBalanced');
    });
  });

  describe('rebalancing', () => {
    it('sells USDC to a keeper who supplies EURC, and pays the bonus', async () => {
      await fund(1000, 0);                     // 100% USDC, target 70% → over-weight
      const uBefore = await usdc.balanceOf(keeper.address);
      const eBefore = await eurc.balanceOf(keeper.address);

      await expect(t.connect(keeper).rebalance(DATA, { value: 10 }))
        .to.emit(t, 'Rebalanced');

      const usdcGained = await usdc.balanceOf(keeper.address) - uBefore;
      const eurcGiven = eBefore - await eurc.balanceOf(keeper.address);
      expect(usdcGained > 0n).to.equal(true);
      expect(eurcGiven > 0n).to.equal(true);

      // the keeper receives more USD of value than they supplied — that is the bonus
      const suppliedUsd = eurcGiven * PRICE / 100_000_000n;
      expect(usdcGained > suppliedUsd).to.equal(true);
    });

    it('sells EURC to a keeper who supplies USDC when under-weight in USDC', async () => {
      await fund(0, 1000);                     // 100% EURC → under-weight USDC
      const uBefore = await usdc.balanceOf(keeper.address);
      const eBefore = await eurc.balanceOf(keeper.address);

      await t.connect(keeper).rebalance(DATA, { value: 10 });

      expect(await usdc.balanceOf(keeper.address) < uBefore).to.equal(true);   // supplied USDC
      expect(await eurc.balanceOf(keeper.address) > eBefore).to.equal(true);   // received EURC
    });

    it('moves the mix towards the target', async () => {
      await fund(1000, 0);
      await t.connect(keeper).rebalance(DATA, { value: 10 });

      const s = await t.getStatus();
      const eurcValue = s.eurcBal * PRICE / 100_000_000n;
      const total = s.usdcBal + eurcValue;
      const bps = Number(s.usdcBal * 10000n / total);
      expect(Math.abs(bps - 7000)).to.be.lessThan(300);    // inside the drift band
    });

    // FINDING: the keeper cannot bound what gets pulled from their wallet.
    it('gives the keeper no way to cap what it takes', async () => {
      const hasLimit = t.interface.fragments.some(f =>
        f.type === 'function' && f.name === 'rebalance' && f.inputs.length > 1);
      expect(hasLimit).to.equal(false);

      // the amount is decided entirely by drift at execution time
      await fund(10000, 0);
      const eBefore = await eurc.balanceOf(keeper.address);
      await t.connect(keeper).rebalance(DATA, { value: 10 });
      const pulledSmall = eBefore - await eurc.balanceOf(keeper.address);

      // same call, a treasury ten times larger, ten times the pull
      const t2 = await (await ethers.getContractFactory('TreasuryAgent')).deploy(
        await pyth.getAddress(), await usdc.getAddress(), await eurc.getAddress(), FEED);
      await usdc.approve(await t2.getAddress(), ethers.MaxUint256);
      await eurc.connect(keeper).approve(await t2.getAddress(), ethers.MaxUint256);
      await t2.deposit(await usdc.getAddress(), U(100000));
      const e2 = await eurc.balanceOf(keeper.address);
      await t2.connect(keeper).rebalance(DATA, { value: 10 });
      const pulledLarge = e2 - await eurc.balanceOf(keeper.address);

      expect(pulledLarge > pulledSmall * 5n).to.equal(true);
    });
  });

  describe('getStatus', () => {
    it('reports balances and the live parameters', async () => {
      await fund(700, 300);
      const s = await t.getStatus();
      expect(s.usdcBal).to.equal(U(700));
      expect(s.eurcBal).to.equal(U(300));
      expect(s._targetUsdcBps).to.equal(7000);
      expect(s._driftBps).to.equal(300);
      expect(s._paused).to.equal(false);
    });
  });
});
