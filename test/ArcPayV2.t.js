const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const E = n => ethers.parseEther(String(n));
const jump = async s => { await network.provider.send('evm_increaseTime', [s]); await network.provider.send('evm_mine'); };

describe('ArcPayV2', function () {
  let pay, alice, bob, carol;

  beforeEach(async () => {
    [alice, bob, carol] = await ethers.getSigners();
    pay = await (await ethers.getContractFactory('ArcPayV2')).deploy();
  });

  describe('pay', () => {
    it('forwards the whole amount and records the note', async () => {
      const before = await ethers.provider.getBalance(bob.address);
      await expect(pay.connect(alice).pay(bob.address, 'coffee', { value: E(1) }))
        .to.emit(pay, 'PaymentSent').withArgs(alice.address, bob.address, E(1), 'coffee');
      expect(await ethers.provider.getBalance(bob.address) - before).to.equal(E(1));
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(0n);
    });

    it('rejects a zero amount', async () => {
      await expect(pay.pay(bob.address, '', { value: 0 })).to.be.revertedWith('zero amount');
    });
  });

  describe('splitPay', () => {
    it('splits equally and returns the rounding dust to the sender', async () => {
      const b0 = await ethers.provider.getBalance(bob.address);
      const c0 = await ethers.provider.getBalance(carol.address);
      // 3 wei over an even split: each gets (v-1)/3, 1 wei of dust comes back
      const value = 10n;
      await pay.connect(alice).splitPay([bob.address, carol.address, alice.address], 'dinner', { value });
      const share = value / 3n;
      expect(await ethers.provider.getBalance(bob.address) - b0).to.equal(share);
      expect(await ethers.provider.getBalance(carol.address) - c0).to.equal(share);
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(0n);
    });

    it('emits one receipt per recipient', async () => {
      await expect(pay.splitPay([bob.address, carol.address], 'x', { value: E(2) }))
        .to.emit(pay, 'PaymentSent').withArgs(alice.address, bob.address, E(1), 'x')
        .and.to.emit(pay, 'PaymentSent').withArgs(alice.address, carol.address, E(1), 'x');
    });

    it('enforces 1..20 recipients', async () => {
      await expect(pay.splitPay([], 'x', { value: E(1) })).to.be.revertedWith('1-20 recipients');
      const many = Array(21).fill(bob.address);
      await expect(pay.splitPay(many, 'x', { value: E(21) })).to.be.revertedWith('1-20 recipients');
    });

    it('rejects a total too small to divide', async () => {
      await expect(pay.splitPay([bob.address, carol.address], 'x', { value: 1 }))
        .to.be.revertedWith('zero share');
    });

    // FINDING: one recipient that rejects the transfer kills the whole batch.
    it('reverts the entire split when a single recipient refuses payment', async () => {
      const bad = await (await ethers.getContractFactory('RejectingReceiver')).deploy();
      const c0 = await ethers.provider.getBalance(carol.address);
      await expect(
        pay.splitPay([carol.address, await bad.getAddress()], 'team payout', { value: E(2) })
      ).to.be.revertedWith('transfer failed');
      // carol was first in the list and still receives nothing
      expect(await ethers.provider.getBalance(carol.address)).to.equal(c0);
    });
  });

  describe('payRecallable', () => {
    it('holds the funds in the contract until claimed', async () => {
      await pay.connect(alice).payRecallable(bob.address, 3600, 'later', { value: E(1) });
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(E(1));
    });

    it('enforces the 60s–30d window', async () => {
      await expect(pay.payRecallable(bob.address, 59, '', { value: E(1) }))
        .to.be.revertedWith('60s - 30d window');
      await expect(pay.payRecallable(bob.address, 30 * 86400 + 1, '', { value: E(1) }))
        .to.be.revertedWith('60s - 30d window');
    });

    it('rejects the zero address and a zero amount', async () => {
      await expect(pay.payRecallable(ethers.ZeroAddress, 3600, '', { value: E(1) }))
        .to.be.revertedWith('bad recipient');
      await expect(pay.payRecallable(bob.address, 3600, '', { value: 0 }))
        .to.be.revertedWith('zero amount');
    });

    it('indexes the payment for both parties', async () => {
      await pay.connect(alice).payRecallable(bob.address, 3600, '', { value: E(1) });
      await pay.connect(alice).payRecallable(carol.address, 3600, '', { value: E(1) });
      expect((await pay.sentBy(alice.address)).map(Number)).to.deep.equal([0, 1]);
      expect((await pay.receivedBy(bob.address)).map(Number)).to.deep.equal([0]);
      expect((await pay.receivedBy(carol.address)).map(Number)).to.deep.equal([1]);
      expect(await pay.total()).to.equal(2n);
    });
  });

  describe('claim and recall', () => {
    beforeEach(async () => {
      await pay.connect(alice).payRecallable(bob.address, 3600, 'note', { value: E(1) });
    });

    it('lets the recipient claim before the window opens', async () => {
      await expect(pay.connect(bob).claim(0)).to.emit(pay, 'Claimed').withArgs(0, bob.address, E(1));
      expect((await pay.rpays(0)).status).to.equal(1);
    });

    it('refuses a claim from anyone else', async () => {
      await expect(pay.connect(carol).claim(0)).to.be.revertedWith('not recipient');
    });

    it('refuses a recall before the window opens', async () => {
      await expect(pay.connect(alice).recall(0)).to.be.revertedWith('window not open yet');
    });

    it('allows a recall once the window opens', async () => {
      await jump(3601);
      await expect(pay.connect(alice).recall(0)).to.emit(pay, 'Recalled').withArgs(0, alice.address, E(1));
      expect((await pay.rpays(0)).status).to.equal(2);
    });

    it('refuses a recall from anyone but the sender', async () => {
      await jump(3601);
      await expect(pay.connect(carol).recall(0)).to.be.revertedWith('not sender');
    });

    it('cannot be claimed after a recall, or recalled after a claim', async () => {
      await pay.connect(bob).claim(0);
      await jump(3601);
      await expect(pay.connect(alice).recall(0)).to.be.revertedWith('not recallable');

      await pay.connect(alice).payRecallable(bob.address, 60, '', { value: E(1) });
      await jump(61);
      await pay.connect(alice).recall(1);
      await expect(pay.connect(bob).claim(1)).to.be.revertedWith('not claimable');
    });

    it('still lets the recipient claim after the window opens', async () => {
      await jump(3601);
      await expect(pay.connect(bob).claim(0)).to.emit(pay, 'Claimed');
    });
  });

  describe('hostile recipients', () => {
    // The guard that matters: status is set before the external call.
    it('cannot be drained by a recipient that re-enters claim', async () => {
      const evil = await (await ethers.getContractFactory('ReentrantClaimer')).deploy();
      const evilAddr = await evil.getAddress();
      // a second payment so the contract holds more than the attacker is owed
      await pay.connect(alice).payRecallable(evilAddr, 3600, '', { value: E(1) });
      await pay.connect(alice).payRecallable(carol.address, 3600, '', { value: E(5) });
      await evil.arm(await pay.getAddress(), 0);

      await evil.go();

      expect(await ethers.provider.getBalance(evilAddr)).to.equal(E(1));       // exactly what it was owed
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(E(5)); // carol's is untouched
      expect(await evil.reentries() > 0n).to.equal(true);                      // it really did try
    });

    // The recovery path: a recipient that cannot receive does not strand funds.
    it('lets the sender recall when the recipient cannot accept payment', async () => {
      const bad = await (await ethers.getContractFactory('RejectingReceiver')).deploy();
      await pay.connect(alice).payRecallable(await bad.getAddress(), 60, '', { value: E(1) });
      await expect(pay.connect(bob).claim(0)).to.be.reverted;   // it cannot be paid
      await jump(61);
      await expect(pay.connect(alice).recall(0)).to.emit(pay, 'Recalled');
    });
  });
});
