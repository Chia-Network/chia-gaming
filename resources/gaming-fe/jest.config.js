module.exports = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  moduleNameMapper: {
    "^socket.io-client$": "<rootDir>/__mocks__/socket.io-client.ts",
  },
};
