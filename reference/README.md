# 参考副本

这里放「上游发布包」的副本，仅供对照查阅，**不参与构建、不入库**（见 `.gitignore`）。

## pi-web/

在桌面上那个临时安装目录里装的 `@agegr/pi-web@0.9.3`（即本仓库 fork 的上游发布版）。
外层 `node_modules/` 是它的依赖，包本体在 `node_modules/@agegr/pi-web/`：

```text
node_modules/@agegr/pi-web/
  bin/                 启动器（与仓库根目录的 bin/ 对照）
  .next/               发布时的构建产物
  public/
  next.config.ts
  package.json
  README*.md
```

用途：改这一版 fork 时拿它当基准 —— 比如「上游这里原来长什么样」「这个行为是我们改的还是上游如此」。
