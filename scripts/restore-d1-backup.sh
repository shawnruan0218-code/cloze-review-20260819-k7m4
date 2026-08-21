#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法: BACKUP_ENCRYPTION_KEY=... $0 <backup.sql.gz.enc>" >&2
  exit 2
fi
if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
  echo "缺少 BACKUP_ENCRYPTION_KEY。" >&2
  exit 2
fi

encrypted="$1"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$encrypted" -out "$workdir/d1.sql.gz" -pass env:BACKUP_ENCRYPTION_KEY
gzip -t "$workdir/d1.sql.gz"
gzip -dc "$workdir/d1.sql.gz" > "$workdir/d1.sql"
grep -q 'cloze-review-20260819-k7m4_records' "$workdir/d1.sql"

echo "备份已成功解密并校验。默认不会写入正式数据库。"
echo "确认要恢复时，手动执行："
echo "npx wrangler d1 execute cloze-review-20260819-k7m4 --remote --file=$workdir/d1.sql"
echo "当前临时文件会在脚本退出后删除；请先在另一个终端完成确认后的命令。"
