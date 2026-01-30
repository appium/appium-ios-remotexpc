module.exports = {
  require: ['tsx/cjs'],
  'node-option': ['import=tsx'],
  forbidOnly: Boolean(process.env.CI),
};
