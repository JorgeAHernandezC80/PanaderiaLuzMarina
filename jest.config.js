module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'validation.js',
    'server.js',
    'db.js',
    'JS/core/**/*.js',
  ],
  coverageReporters: ['text', 'text-summary', 'lcov'],
};
