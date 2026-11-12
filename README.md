# 尖塔 Mod 启动器

给《杀戮尖塔》（Slay the Spire）+ ModTheSpire 使用的 Windows 桌面启动器：扫描本地与创意工坊 mod，按组合启用/禁用、检查依赖，并一键启动游戏。

- 源码仓库：<https://github.com/musujd/sts-mod-launcher>
- 下载安装包：[GitHub Releases](https://github.com/musujd/sts-mod-launcher/releases/latest)

## 安装版（推荐分享）

从 [GitHub Releases](https://github.com/musujd/sts-mod-launcher/releases/latest) 下载 `STSModLauncher-Setup-1.0.0.exe` 后运行：

1. 选择安装目录（默认安装到当前用户目录，无需管理员）。
2. 安装完成后启动器会自动检测 Steam 版《杀戮尖塔》和 ModTheSpire。
3. 检测到后会自动接管 Steam 的「启动 with mod」入口，不需要再手动点安装。
4. 以后从 Steam 选「启动 with mod」会打开启动器；选「启动原始版本」仍直接进入原版游戏。

如果没检测到游戏或 ModTheSpire，可以打开「Steam 接管」面板手动安装。

卸载：Windows 设置 → 应用 → 卸载。建议先在启动器「Steam 接管」→「卸载接管」，再卸载启动器。如果忘了，包装器找不到启动器时会自动回退到正常 MTS 启动，不会导致 with mod 打不开；也可以手动把 `jre\bin\javaw.exe.original` 改名回 `javaw.exe`。

安装包未签名，Windows SmartScreen 可能提示「未知发布者」；源码在本仓库，可自行构建核对。

## 功能

- 自动定位 Steam 游戏目录与创意工坊目录（appid `646570`）
- 扫描 `<游戏目录>\mods\*.jar` 与工坊 `<id>\*.jar`，读取 jar 内 `ModTheSpire.json`（名称、版本、作者、依赖）
- 卡片直接显示中文名、版本、作者、简介和前置依赖；缺少前置时标红
- 勾选启用/禁用 mod，拖拽调整加载顺序；启用时自动带上前置
- 依赖检查：缺失前置、前置未启用、重复 modid、同名 jar、循环依赖；诊断中可一键补齐前置
- 详情弹窗显示完整简介与路径，并可打开 Steam 工坊页面（订阅后由 Steam 下载）
- 多套 Mod 组合（配置档）：新建、复制、重命名、删除、备注，一键切换整套组合
- 保存时写入 ModTheSpire 的 `mod_lists.json`，自动生成 `.bak` 备份
- 一键启动：`javaw -jar ModTheSpire.jar --profile <组合> --skip-launcher --skip-intro`
- 日志查看：列出游戏 `logs/`、`sendToDevs/` 与 ModTheSpire 配置目录中的日志，并提取 `ERROR` / `Exception` 行

## 环境要求

- Windows 10 / 11
- 《杀戮尖塔》Steam 版（也可以手动指定游戏目录）
- 已安装 ModTheSpire（游戏根目录存在 `ModTheSpire.jar`）
- Node.js 18+（仅从源码运行时需要）

## 运行

```powershell
cd sts-mod-launcher
npm.cmd install
npm.cmd start
```

> 如果 PowerShell 提示「因为在此系统上禁止运行脚本」，请使用 `npm.cmd` 而不是 `npm`。
>
> 打包失败或不想打包时，继续用 `npm.cmd start` 即可。Steam 启动接管只会在界面里点击「安装接管」时修改游戏目录，打包失败不会自动碰任何游戏文件。

## 首次使用

1. 启动器会自动读取 Steam 注册表与 `libraryfolders.vdf` 查找游戏。
2. 找不到时点击右上角「选择目录」，选中包含 `SlayTheSpire.exe` / `ModTheSpire.jar` 的文件夹。
3. 左侧选择或新建 Mod 组合，中间勾选 mod，右侧点「保存并启动游戏」。

## Steam 启动接管

可以把「从 Steam 点《杀戮尖塔》」改成先打开启动器：

1. 先打包并安装启动器：

   ```powershell
   npm.cmd run package
   npm.cmd run install-local
   ```

2. 打开启动器，点顶栏「Steam 接管」→「安装接管」→ 确认。
3. 之后从 Steam 点「启动 with mod」，会先打开启动器；确认组合后再点「保存并启动游戏」。点「启动原始版本」仍会直接进入原版游戏。

Steam 的两个启动项都调用游戏内置的 `jre\bin\javaw.exe`，不经过 `SlayTheSpire.exe`。启动器只拦截「启动 with mod」的 `-jar mts-launcher.jar`；原版的 `-jar desktop-1.0.jar` 会直接转发给原版 `javaw-real.exe`。

安装会做这些事：

- 把原 `jre\bin\javaw.exe` 备份为 `javaw.exe.original`
- 把原文件另存为 `javaw-real.exe`（包装器转发时使用）
- 用 `tools/JavaWrapper.exe` 替换 `jre\bin\javaw.exe`
- 写入 `jre\bin\sts-launcher.path`（启动器绝对路径）和 `jre\bin\sts-java-hook.json`（包装器 SHA-256）

从 Steam 点「启动 with mod」时，包装器会打开启动器；启动器启动游戏时会带 `STS_LAUNCHER_CHILD=1`，直接转发给 `javaw-real.exe`，不会递归。点「启动原始版本」时包装器直接转发，不打开启动器。

卸载：点「Steam 接管」→「卸载接管」，会把 `javaw.exe.original` 恢复回 `javaw.exe`，并删除 `javaw-real.exe`。

注意：

- Steam 校验文件或游戏更新会还原 `javaw.exe`，接管会失效；启动器会显示「已失效」，点「重新安装接管」即可。
- 个别杀毒软件可能对替换后的 javaw.exe 误报。
- Steam 的「停止」按钮可能只关闭启动器；游戏由启动器另行启动，Steam 时长/overlay 可能不准确。
- 安装或卸载前请先退出游戏。
- 手动恢复：删除 `jre\bin\javaw.exe`，把 `jre\bin\javaw.exe.original` 改名回 `javaw.exe`；`javaw-real.exe` 可以删除。

## 原理：会读写哪些文件

- **启用列表**：`%LOCALAPPDATA%\ModTheSpire\mod_lists.json`

  ```json
  {
    "defaultList": "main",
    "lists": {
      "main": ["BaseMod.jar", "CoolMod.jar"]
    }
  }
  ```

  保存时会把当前组合写入 `lists.<组合名>`，并把 `defaultList` 设为该组合；原文件备份为 `mod_lists.json.bak`，文件中的其他未知字段会原样保留。

- **mod 扫描**：
  - `<游戏目录>\mods\*.jar`
  - `<steamapps>\workshop\content\646570\<工坊 id>\*.jar`（以及该目录下的 `mods\*.jar`）

- **启动入口**（按优先级自动选择）：
  1. `<游戏目录>\ModTheSpire.jar`（本地安装）
  2. `<steamapps>\workshop\content\646570\1605060445\ModTheSpire.jar`（Steam 工坊版）
  3. `<游戏目录>\mts-launcher.jar`（回退；它只是 Steam 引导器，不解析 `--profile`，可能会先显示 ModTheSpire 的选 mod 界面）

- **启动命令**：

  ```text
  <游戏目录>\jre\bin\javaw.exe -jar <上面的 ModTheSpire.jar> --profile <组合名> --skip-launcher --skip-intro
  ```

  游戏没有内置 `jre` 时，回退到系统 `PATH` 中的 `javaw` / `java`。

## 配置档保存在哪里

启动器自身状态（游戏目录、组合说明、当前组合）：

```text
%APPDATA%\sts-mod-launcher\launcher-state.json
```

组合本身仍以 ModTheSpire 的 `mod_lists.json` 为准，所以从 ModTheSpire 原生界面做的修改也能被启动器读到。

## 环境变量（便携 / 多环境）

| 变量 | 作用 |
| --- | --- |
| `STS_LAUNCHER_USER_DATA` | 覆盖启动器状态目录 |
| `STS_MTS_CONFIG_DIR` | 覆盖 ModTheSpire 配置目录（默认 `%LOCALAPPDATA%\ModTheSpire`） |

## 开发与测试

```powershell
npm.cmd test
```

运行时只依赖 Electron，jar/zip 解析为内置实现（读取 zip 中央目录 + `inflateRaw`），不依赖第三方压缩库。

## 打包成 exe（可选）

生成安装程序（推荐分享）：

```powershell
npm.cmd run dist
```

产物为 `release\尖塔Mod启动器-Setup-<version>.exe`，双击即可安装。

只生成免安装目录：

```powershell
npm.cmd run package
npm.cmd run install-local
```

`npm run package` 生成 `dist\尖塔Mod启动器-win32-x64\`，`npm run install-local` 把它复制到 `%LOCALAPPDATA%\STSModLauncher`。

如果打包或复制失败，跳过这两步，继续用 `npm.cmd start`。打包失败不会修改游戏目录，Steam 启动接管也不会自动安装。

## 已知限制

- 只支持《杀戮尖塔》1 代 + ModTheSpire。
- 如果只能用 `mts-launcher.jar` 启动，它不会转发 `--profile`，可能仍会显示 ModTheSpire 的选 mod 界面。
- 不会自动下载 mod：启动器提供「浏览创意工坊」和「打开工坊页面」，订阅后由 Steam 自动下载。真正免客户端下载需要 SteamCMD/Steamworks 与账号授权，未集成。
- 本地与工坊存在同名 jar 时，ModTheSpire 本身按文件名识别，启动器只能提示冲突。
- 修改启用列表后需要重启游戏才会生效。
- 日志只读取 `logs/`、`sendToDevs/` 与 ModTheSpire 配置目录下的 `.log` / `.txt` 文件。
