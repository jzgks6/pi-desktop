import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // demo/ is a separate Next.js project with its own lint config.
  // desktop/src-tauri 下是打包产物：runtime/ 是组装出来的 Node 运行时（里面是几千个
  // 第三方 JS），target/ 是 Rust 编译输出，icons/ 是生成的图标。都不是本项目源码。
  {
    ignores: [
      "demo/**",
      "desktop/src-tauri/runtime/**",
      "desktop/src-tauri/target/**",
      "desktop/src-tauri/icons/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
