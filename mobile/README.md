# 视频更新速递 · Android 版（v1.0）

把桌面 Edge 扩展的核心流水线移植到手机：监控 B 站作者新投稿 → 字幕/评论区文字版/文案三级降级 → 调用你的 OpenAI 兼容模型生成总结与速评 → 直连 SMTP 发送邮件。

## 安装

1. 把 `视频更新速递-Android-v1.0.apk` 拷到 Android 手机（需 Android 8.0+）
2. 点击安装（需允许「安装未知来源应用」）
3. 打开 App，按界面填写配置并「保存配置」

## 首次使用（三步）

1. **登录 bilibili**：点「打开 bilibili 登录」，在内置 WebView 里扫码/登录后关闭对话框。登录态由 WebView 持久保存，API 调用带登录 Cookie 绕开风控（与桌面扩展同策略）。
2. **配置**：B 站作者 UID、模型 API（OpenAI 兼容 base URL + 模型 ID + Key）、收发邮箱与 SMTP 授权码（默认 465 SSL；163/126/QQ 邮箱均可）。
3. **加密保存（可选）**：设置保管密码后，模型 Key 与 SMTP 授权码以 PBKDF2-SHA256（30 万次迭代）+ AES-256-GCM 加密存本机；重启后点「解锁」恢复，免重输。

## 流水线（与桌面版一致）

- **字幕**：x/player/v2 多轮收集 + 评分选优（抗字幕轮换/错配）
- **文字版**：字幕不可用时读评论区「文字版」链接（UP 主置顶），含 SPA 壳页 markdown 数据源兜底
- **文案兜底**：两者都没有时基于视频文案总结，报告与速评注明「字幕与文字版均不可用」
- **发信**：直连 SMTP（手机无浏览器限制，不需要桌面版的中继），邮件含完整报告 HTML
- **记账**：sentBvids 防重复发信；失败重试不会重复发送已确认的邮件

## 与桌面版的差异

| 项 | 桌面 Edge 扩展 | Android 版 |
| --- | --- | --- |
| 登录态 | Edge 浏览器 | 应用内 WebView 登录一次 |
| 邮件 | HTTPS→SMTP 中继 | 直连 SMTP（465/587） |
| 截图/长图 | 视频帧截图 + 长图 PNG | v1.0 暂不含（报告为 HTML 邮件），后续可加 WebView 渲染 |
| 讲解页 | 可选 lecture.html 附件 | 后续版本 |
| 定时检查 | 后台定时 | v1.0 为手动「立即检查更新」，后续可加前台服务定时 |
| 抖音 | 支持 | v1.0 仅 B 站 |

## 构建（开发者）

```
mobile/            # Android 工程（AGP 8.2.2 / Kotlin 1.9.22 / minSdk 26）
app-debug.apk 产物：mobile/app/build/outputs/apk/debug/
```

本机工具链在 `mobile-toolchain/`（JDK 17 + Android SDK + Gradle 8.6），最终用户不需要这些——只需 APK。
