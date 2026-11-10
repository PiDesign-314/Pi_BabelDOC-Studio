# Zotero 10 与划词显示修复（2026-11-10）

- 插件 1.0.0 的 `strict_max_version: 8.*` 排除了用户的 Zotero 10.0.8。
  1.0.1 将范围扩到 `10.*`，保留 7.x 的菜单回退与 8+ 的能力检测。
- 核对本机 `D:/Zotero/app/application.ini`、安装包内菜单与设置页接口，及
  [Zotero 10 官方迁移说明](https://www.zotero.org/support/dev/zotero_10_for_developers)。
  插件不依赖已移除的单选分类 getter，测试覆盖了读取旧 getter 会抛异常的菜单上下文。
- 自定义数据目录由 Zotero 的附件路径接口解析，不需要修改用户的同步设置。
- PDF 文字层原本透明，但全局 `::selection` 将选中文字设为不透明，
  导致浏览器字形覆盖 PDF 画布，尤其在深色界面下发白、重影。
  阅读器现在同时隐藏原生选区背景与文字前景，仍保留复制和自绘选区。

验证：29 项插件及集成测试通过；浏览器三行拖选、浅色/深色选区前景、复制、
高亮保存及清除通过；100%/300% 下选区与保存高亮的四项位置尺寸偏差均为 0。
以上是 1.0.1 的验证范围；后续发现它仍缺少安装器的必填字段，不能作为可安装版本使用。

## 1.0.2：真实安装器验证

本机 `D:/Zotero/omni.ja` 内 `modules/Extension.sys.mjs` 的 `parseManifest`
明确拒绝缺少 `applications.zotero.update_url` 的插件；
`modules/addons/XPIDatabase.sys.mjs` 还要求该地址使用 HTTPS。
前两版遗漏此字段，原测试却错误要求省略它。本次补齐 HTTPS 更新地址，
并新增缺失、空值、HTTP、data URL 四种失败回归检查。

核对来源：[官方插件制作说明](https://www.zotero.org/support/dev/client_coding/plugin_development)、
[官方示例 manifest](https://github.com/zotero/make-it-red/blob/main/src-2.0/manifest.json)，
及本机 10.0.8 实际加载器源码。

1.0.2 在独立配置中由本机 Zotero 10.0.8 成功加载，原生 AddonManager 返回：
`isActive=true`、`isCompatible=true`、`appDisabled=false`。
启动、设置页注册与退出清理日志正常。结果见 `docs/zotero-1.0.2-native-result.json`。
没有修改用户的正式配置、数据目录或安全检查选项。

交付：`dist/babeldoc-zotero-1.0.2.xpi`。HTTPS 更新清单已准备在仓库源码中，
尚未发布到远端，当前仍需手动下载新版本。未来 10.x 接口变化不在已验证范围内。
