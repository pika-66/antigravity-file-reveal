# Antigravity 文件右键打开位置（agy-file-reveal）

一个面向 Google Antigravity 客户端的 UI 增强插件：为对话中的关联文件胶囊与 `file://` 链接接管右键菜单，新增 **打开文件位置** 与 **复制完整路径** 功能。

## 功能特性

- **打开文件位置**：在 Windows 资源管理器（`explorer.exe /select`）、macOS Finder（`open -R`）或 Linux 文件管理器中直接定位并选中目标文件；若原文件已不存在，则自动回退打开存在的上级目录并给出气泡提示。
- **复制完整路径**：一键复制解码后的本地系统完整路径（自动剥离 `#L10-L20` 等行号锚点与 `%3A` 编码）。
- **保留复制功能**：优先复制当前划词选中文本，否则复制文件标签文字。
- **零外部依赖**：基于 Antigravity Sidecar + 本地 DevTools (CDP) 注入 Shadow DOM 右键菜单，自适应明暗主题，零第三方 npm 依赖。

## 目录结构

```text
antigravity-file-reveal/
├── .gitignore
├── plugin.json
├── README.md
├── assets/
│   └── logo.svg
└── sidecars/
    └── file_reveal/
        ├── sidecar.json
        └── main.mjs
```

## 安装方式

将本仓库克隆到 Antigravity 全局插件目录 `~/.gemini/config/plugins/agy-file-reveal`：

```bash
git clone https://github.com/pika-66/antigravity-file-reveal.git ~/.gemini/config/plugins/agy-file-reveal
```

Windows PowerShell：

```powershell
git clone https://github.com/pika-66/antigravity-file-reveal.git "$env:USERPROFILE\.gemini\config\plugins\agy-file-reveal"
```

安装后重启 Antigravity 客户端（或在 **自定义 → 已安装插件** 中重新启用一次）即可生效。可在右侧辅助面板 `+` 菜单打开 **文件右键位置** 查看连接状态与最近操作记录。
