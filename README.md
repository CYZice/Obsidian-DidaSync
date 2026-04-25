<h1 align="center">Obsidian-DidaSync</h1>

<p align="center"><b>Obsidian 与 滴答清单/TickTick 的双向同步插件</b></p>

<p align="center">

一个强大的 Obsidian 任务同步插件，将您的滴答清单/TickTick 任务直接带入笔记中，并提供直观的日历时间轴和时间块视图。

</p>

<p align="center"><a href="https://github.com/CYZice/Obsidian-DidaSync/stargazers">

<img src="https://img.shields.io/github/stars/CYZice/Obsidian-DidaSync?style=flat-square&color=6c5ce7" alt="GitHub Stars">

</a>

<a href="https://github.com/CYZice/Obsidian-DidaSync/releases/latest">

<img src="https://img.shields.io/github/v/release/CYZice/Obsidian-DidaSync?style=flat-square&color=00b894" alt="Latest Release">

</a>

<a href="https://github.com/CYZice/Obsidian-DidaSync/releases">

<img src="https://img.shields.io/github/downloads/CYZice/Obsidian-DidaSync/total?style=flat-square&color=0984e3" alt="Downloads">

</a>

<a href="https://github.com/CYZice/Obsidian-DidaSync/blob/main/LICENSE">

<img src="https://img.shields.io/github/license/CYZice/Obsidian-DidaSync?style=flat-square&color=636e72" alt="License">

</a>

</p>

<p align="center">

<b>简体中文</b> | <a href="./README_EN.md">English</a>

</p>

## 亮点

### 🔄 双向同步

Obsidian-DidaSync 确保您的任务始终保持最新，无论是在 Obsidian 还是在滴答清单中。

| 原生任务同步 | 快速创建任务 |
|:--:|:--:|
| ![Native Task Sync](./assets/native-task-sync.png) | ![Sidebar View](./assets/sidebar-view.png) |
| 直接将滴答清单任务同步到笔记中，跨平台保持状态和详情同步 | 使用专用弹窗和命令，从 Obsidian 笔记中快速创建任务 |

### 📅 视觉化任务管理

| 时间块视图 | 时间线视图 | 侧边栏视图 |
|:--:|:--:|:--:|
| ![Time Block View](./assets/time-block-view.png) | ![Timeline View](./assets/timeline-view.png) | ![Sidebar View](./assets/sidebar-view.png) |
| 使用日历风格的时间块视图可视化您的一天 | 垂直时间线，跟踪任务进度和截止日期 | 直接从 Obsidian 侧边栏管理整个滴答清单任务列表 |

## 功能特性

| 功能 | 描述 |
|---------|-------------|
| 🔄 **双向同步** | 在 Obsidian 和 滴答清单/TickTick 之间同步任务状态、内容和详情 |
| 🗓️ **多样视图** | 提供时间块、时间线和侧边栏任务列表等多种查看方式 |
| ✋ **交互与拖拽排期**| 时间段视图支持全天任务丝滑拖拽排期，防止编辑误触，点击日期徽章即可一键唤出日历重新排期 |
| 🔁 **循环任务支持** | 完美同步并管理滴答清单中的复杂重复任务（支持显示与打卡循环规则） |
| 📝 **日记集成** | 自动将今日任务同步到您的日记中 |
| ⚡ **快速命令** | 通过简单的快捷键将任务添加到特定项目或插入任务建议 |
| 🕒 **自动同步** | 可配置的后台同步，保持数据实时更新 |
| 🎛️ **项目管理** | 查看并管理按滴答清单/TickTick 项目分组的任务 |
| 📋 **拖拽到 Markdown** | 支持将任务行直接拖拽到 Markdown 编辑器，生成带链接的复选框列表 |
| 🔍 **任务搜索** | 在任务操作菜单中直接搜索已有关务并快速关联 |
| 📆 **日历日期选择** | 日期菜单采用完整日历网格，支持月份导航，直观选择到期日期 |
| ✓ **反向完成验证** | 同步后自动验证线上任务状态，解决因网络延迟导致的完成状态不一致问题 |

## 快速开始

1. 打开 **Obsidian 设置** → **第三方插件** → **浏览** → 搜索 **"Obsidian-DidaSync"**
2. 安装并启用插件
3. 在插件设置中使用安全便捷的 OAuth 授权一键连接您的滴答清单/TickTick 账号（无需繁琐配置 API Key）
4. 打开侧边栏或使用功能条图标开始同步您的任务！

## 安装

### 社区插件市场（推荐）

见上方的“快速开始”。

### 手动安装

1. 前往 [Releases](https://github.com/CYZice/Obsidian-DidaSync/releases) 下载最新的 `main.js`, `manifest.json`, 和 `styles.css`
2. 创建文件夹：`<vault>/.obsidian/plugins/Obsidian-DidaSync/`
3. 将文件复制到该文件夹中，并在 Obsidian 设置中启用插件

## 支持

如果您觉得 Obsidian-DidaSync 对您有所帮助，请考虑为仓库点个 Star 或提交 Issue 以帮助改进！

<p align="center">

<a href="https://github.com/CYZice/Obsidian-DidaSync/issues" target="_blank">
<img src="https://img.shields.io/badge/反馈-问题-red?style=for-the-badge" alt="Issues">
</a>

</p>

## 开源协议

[MIT License](LICENSE)
