// 减脂进度照流水线（本地运行）
//   1. 读 inbox/ 下命名为 YYYY-MM-DD.* 的照片
//   2. sharp 烤入 EXIF 方向、去元数据(含 GPS)、长边缩到 1600、转 JPEG
//   3. 上传 R2，key = fat-loss/YYYY-MM-DD.jpg
//   4. 把对应日期那一行的「照片」单元格填上缩略图(点击开大图)
//   5. 原图移到 inbox/done/（不进 git）
//
// 用法:  npm run photo        正式跑（上传 + 改 md）
//        npm run photo:dry    只处理+改 md，跳过上传，便于本地验证

import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const ROOT = path.resolve(import.meta.dirname, '..');
const INBOX = path.join(ROOT, 'inbox');
const DONE = path.join(INBOX, 'done');
const POST = path.join(ROOT, 'content', 'posts', 'fat-loss-journey', 'index.md');

const PREFIX = 'fat-loss'; // R2 key 前缀
const MAX_EDGE = 1600; // 上传原图长边上限（px）
const THUMB_W = 60; // 表格里缩略图显示宽（px）
const THUMB_H = 80; // 高（px），3:4 竖图
const DRY = process.argv.includes('--dry-run');

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.(jpe?g|png|heic|heif|webp)$/i; // 根目录文件
const DIR_RE = /^\d{4}-\d{2}-\d{2}$/; // 日期命名的子目录
const IMG_RE = /\.(jpe?g|png|heic|heif|webp)$/i;

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ 缺少环境变量 ${name}（在 .env 里填，参考 .env.example）`);
    process.exit(1);
  }
  return v;
}

// 生成表格单元格：固定尺寸 3:4 缩略图(2x 裁切) + 点击开大图(width=1080)
// max-width:none 覆盖主题的 img{max-width:100%}，否则会被窄列压扁
function buildCell(domain, date) {
  const base = `${domain.replace(/\/$/, '')}/cdn-cgi/image`;
  const big = `${base}/width=1080,format=auto,quality=82/${PREFIX}/${date}.jpg`;
  const thumb = `${base}/width=${THUMB_W * 2},height=${THUMB_H * 2},fit=cover,gravity=auto,format=auto,quality=80/${PREFIX}/${date}.jpg`;
  return `<a href="${big}"><img src="${thumb}" width="${THUMB_W}" height="${THUMB_H}" loading="lazy" alt="${date}" style="border-radius:8px;display:block;object-fit:cover;max-width:none"></a>`;
}

// 把 md 数据表里 first cell == date 那行的第 2 个单元格(照片列)替换为 html
function patchRow(md, date, html) {
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('|');
    // 表格行: ['', ' 日期 ', ' 照片 ', ' 体重 ', ..., '']  共 8 段
    if (parts.length >= 7 && parts[1].trim() === date) {
      parts[2] = ` ${html} `;
      lines[i] = parts.join('|');
      return { md: lines.join('\n'), found: true };
    }
  }
  return { md, found: false };
}

// 发现待处理项。支持两种放法：
//   inbox/2026-05-24.jpg            （根目录文件，日期来自文件名）
//   inbox/2026-05-24/任意图片.jpg   （日期目录，日期来自文件夹名，绕开内层文件名）
async function collect() {
  const items = [];
  const entries = await readdir(INBOX, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'done' || e.name === '.gitkeep') continue;
    if (e.isFile() && DATE_RE.test(e.name)) {
      const date = e.name.match(DATE_RE)[1];
      items.push({ date, src: path.join(INBOX, e.name), moveTo: path.join(DONE, e.name) });
    } else if (e.isDirectory() && DIR_RE.test(e.name)) {
      const dir = path.join(INBOX, e.name);
      const imgs = (await readdir(dir)).filter((f) => IMG_RE.test(f)).sort();
      if (imgs.length === 0) {
        console.warn(`! ${e.name}/ 里没有图片，跳过`);
        continue;
      }
      if (imgs.length > 1) console.warn(`! ${e.name}/ 有 ${imgs.length} 张图，只用第一张 ${imgs[0]}`);
      // 日期取自文件夹名（内层文件名可能手误）；整个文件夹处理后移到 done/
      items.push({ date: e.name, src: path.join(dir, imgs[0]), moveTo: path.join(DONE, e.name), srcDir: dir });
    }
  }
  return items;
}

async function main() {
  let items = [];
  try {
    items = await collect();
  } catch {
    console.error(`✗ 找不到 inbox/ 目录：${INBOX}`);
    process.exit(1);
  }
  if (items.length === 0) {
    console.log('inbox/ 里没有 YYYY-MM-DD.* 文件或 YYYY-MM-DD/ 目录，啥也不做。');
    return;
  }

  let s3, bucket, domain;
  if (!DRY) {
    const accountId = need('R2_ACCOUNT_ID');
    bucket = need('R2_BUCKET');
    domain = need('IMG_DOMAIN');
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: need('R2_ACCESS_KEY_ID'),
        secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
      },
    });
  } else {
    domain = process.env.IMG_DOMAIN || 'https://img.neepoo.dev';
  }

  let md = await readFile(POST, 'utf8');
  const notFound = [];
  await mkdir(DONE, { recursive: true });

  for (const { date, src, moveTo, srcDir } of items) {
    // 处理图：烤方向 + 去元数据 + 缩放 + JPEG
    const buf = await sharp(src)
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    const key = `${PREFIX}/${date}.jpg`;
    if (!DRY) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buf,
          ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      console.log(`↑ 已上传 ${key}  (${(buf.length / 1024).toFixed(0)} KB)`);
    } else {
      console.log(`[dry] 跳过上传 ${key}  (${(buf.length / 1024).toFixed(0)} KB)`);
    }

    const res = patchRow(md, date, buildCell(domain, date));
    if (res.found) {
      md = res.md;
      console.log(`✓ 已写入表格行 ${date}`);
    } else {
      notFound.push(date);
      console.warn(`! 表格里没有 ${date} 这行，跳过写入（先在数据表加该日数据）`);
    }

    // 移到 done/：目录形式移整个文件夹，文件形式移单文件
    if (!DRY) await rename(srcDir ?? src, moveTo);
  }

  await writeFile(POST, md);
  console.log(`\n完成。改了 ${items.length - notFound.length} 行${DRY ? '（dry-run，未上传/未移动原图）' : ''}。`);
  if (notFound.length) console.log(`缺数据行: ${notFound.join(', ')}`);
}

main().catch((e) => {
  console.error('✗ 出错:', e.message);
  process.exit(1);
});
