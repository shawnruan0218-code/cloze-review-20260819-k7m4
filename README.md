# Cloze Review

英语一、英语二和完形填空的本地优先挖空复习应用。静态内容由 GitHub Pages 提供，登录和增量同步由独立的 Cloudflare Worker 与 D1 提供。

## 数据安全

- 用户操作立即写入本机 IndexedDB，断网时仍可训练和修改复习库。
- 原有 `cloze-review-library-v1`、批注和设置键会被读取兼容，但不会清空或改名。
- 云同步只上传 dirty queue，并按服务端 change sequence 增量拉取。
- 删除使用 tombstone 软删除；退出 GitHub 登录不会删除本机学习数据。
- 页面保留带校验和的 JSON 导出和非破坏性合并导入。
- 旧 Supabase 项目和原始导出不会由本项目删除。

## 本地验证

```bash
npm ci
npm test
npm run migration:verify
npm run d1:migrate:local
npm run dev:worker
```

静态页面可用任意静态服务器打开，例如：

```bash
python3 -m http.server 8765
```

## 部署结构

- 命名空间：`cloze-review-20260819-k7m4`
- Worker 与 D1 配置：`wrangler.toml`
- D1 migration：`migrations/`
- Worker API：`worker/src/index.js`
- 浏览器同步引擎：`cloud-sync.js`
- Supabase 转换脚本：`scripts/build-d1-import.mjs`
- 加密备份工作流：`.github/workflows/encrypted-d1-backup.yml`

密钥只允许写入 Cloudflare Worker Secrets 或 GitHub Actions Secrets。完整部署和恢复步骤见 [迁移与恢复说明](docs/迁移与恢复说明.md)。
