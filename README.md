<h1>链接变更监控</h1>
<h2>pc版本说明</h2>

本仓库包含 Chrome 扩展 **链接变更监控**（Manifest V3）：多链接定时检测页面正文变化，支持门户招标站点选添加、噪声过滤与多种添加入口（面板、右键、地址栏 `lj`）。

**当前版本：2.0.31** · 插件目录：**`chrome-link-monitor/`**

**配套 Android 应用：** 安装包 **`链接变更监控-v1.0.0.apk`**（仓库根目录），工程在 [`link-monitor-android/`](link-monitor-android/)。

## 快速开始

1. Chrome 打开 `chrome://extensions/`，开启开发者模式
2. **加载已解压的扩展程序** → 选择 **`chrome-link-monitor`**（内含 `manifest.json`）
3. Windows：**设置 → 系统 → 通知** → 允许 Chrome 通知
4. 路径含中文时建议复制到 `D:\chrome-link-monitor` 再加载
5. 面板添加链接，或右键 / `lj` / 门户点选（需在「启动行为」勾选显示点选工具条）

完整说明（原理、迭代、故障排查）见 **[chrome-link-monitor/README.md](chrome-link-monitor/README.md)**。

安装前可在 `chrome-link-monitor` 目录运行：`python verify_extension.py`

## 仓库结构

```
chrome-link-monitor/    ← 在 Chrome 中加载此目录
link-monitor-android/   ← Android 配套 APK 工程
链接变更监控-v1.0.0.apk  ← 可直接安装到手机
README.md               ← 本文件（仓库总览）
```

## 许可证

供学习与个人使用。请遵守目标网站服务条款。
