# 英语一 Cloze 复习库

一个静态网页应用，可部署到 GitHub Pages。配置 Supabase 后，电脑和手机用同一账号登录即可同步复习库。

## 手机/电脑交互

- 电脑端：保留 Hover 显示答案、鼠标悬停词条后按 `q` 加入复习库。
- 手机端：自动隐藏 Hover，禁用 `q` 快捷键，只保留点击操作。
- 两端登录同一个 Supabase 账号后，复习库会自动同步。

## 配置 Supabase

1. 创建 Supabase 项目。
2. 打开 Supabase SQL Editor，执行 `supabase-schema.sql`。
3. 在 Supabase Project Settings 里复制：
   - Project URL
   - anon public key
4. 编辑 `sync-config.js`：

```js
window.SYNC_CONFIG = {
  supabaseUrl: "https://你的项目.supabase.co",
  supabaseAnonKey: "你的 anon public key",
};
```

不要把 service_role key 放进前端文件。

## 部署到 GitHub Pages

把这个文件夹作为 GitHub 仓库根目录推送到 GitHub：

```bash
git init
git add .
git commit -m "deploy cloze review app"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库.git
git push -u origin main
```

然后在 GitHub 仓库：

1. Settings -> Pages。
2. Source 选择 GitHub Actions。
3. 等待 `Deploy to GitHub Pages` 工作流完成。

部署完成后，GitHub Pages 给出的地址就是手机和电脑都能打开的网址。
