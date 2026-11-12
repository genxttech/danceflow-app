module.exports = function (api) {
  api.cache(true);

  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-reanimated/plugin"],
    env: {
      // Jest runs CommonJS without VM modules; Metro handles import() itself.
      test: { plugins: ["@babel/plugin-transform-dynamic-import"] }
    }
  };
};
