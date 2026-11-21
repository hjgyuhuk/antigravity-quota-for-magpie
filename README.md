# magpie-agy-quota

Magpie 独立插件：在 Magpie 中查看本机 Antigravity CLI (`agy`) 的模型额度，不代理对话请求，不读取 Google OAuth 凭据。

## 工作原理

- 通过 Magpie 的 `auth.usage` 钩子调用本机 `agy -p /usage --output-format json`。
- 运行时在临时目录注入空工具的隔离 agent 与 `open` / `xdg-open` 占位脚本，避免触发模型调用或拉起浏览器。
- 所有额度窗口标记 `aside: true`，仅用于展示，不影响 Magpie 路由。

## 安装与登录

```bash
magpie plugin add github:hjgyuhuk/antigravity-quota-for-magpie
# 或使用完整 Git 地址：
# magpie plugin add git+https://github.com/hjgyuhuk/antigravity-quota-for-magpie.git
magpie plugin login agy-quota
magpie quota agy-quota
```

登录提示输入 `agy binary path` 时：
- 直接回车留空：自动探测 `PATH` 与 `~/.local/bin/agy`。
- 输入绝对路径（如 `/path/to/agy`）：使用指定的 `agy` 可执行文件。

## 沙箱测试

克隆仓库并在仓库根目录运行：

```bash
git clone https://github.com/hjgyuhuk/antigravity-quota-for-magpie.git
cd antigravity-quota-for-magpie
bun test

sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add . </dev/null
m plugin --json
m plugin login agy-quota
m quota agy-quota --json
```
