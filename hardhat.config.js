require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');
const path = require('path');

const SOLC_VERSION = '0.8.24';

/* Compile with the solc pinned in devDependencies instead of a binary fetched
   at build time. Same compiler for everyone, on any machine, offline. */
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion !== SOLC_VERSION) return runSuper();
  const compilerPath = path.join(path.dirname(require.resolve('solc/package.json')), 'soljson.js');
  return {
    compilerPath,
    isSolcJs: true,
    version: args.solcVersion,
    longVersion: `${args.solcVersion}-pinned-npm`
  };
});

module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  paths: { sources: './contracts', tests: './test', cache: './.hh-cache', artifacts: './.hh-artifacts' }
};
