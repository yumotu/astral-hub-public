const { macDistributionConfig } = require('./macos-signing.cjs');
module.exports = () => macDistributionConfig(require('./package.json').build);
