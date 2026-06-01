import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMG_RE = /\.(jpe?g|png|heic|heif|webp)$/i;
const MONTH_RE = /^\d{4}-\d{2}$/;
const FIGURE_WIDTH = 380;
const DISPLAY_WIDTH = 760;
const LINK_WIDTH = 1080;

const ACTIVITIES = {
  running: {
    label: '跑步',
    aliases: ['running', 'run', '跑步'],
    heading: ['跑步'],
    caption: (monthName, rows) => {
      const count = rows.get('累计跑步');
      const distance = rows.get('累计距离');
      if (count && distance) return `跑步月统计截图：${monthName}累计跑步 ${count}，距离 ${distance}。`;
      return `跑步月统计截图：${monthName}跑步训练数据。`;
    },
  },
  cycling: {
    label: '骑行',
    aliases: ['cycling', 'cycle', 'bike', 'riding', '骑行'],
    heading: ['骑行'],
    caption: (monthName, rows) => {
      const count = rows.get('累计骑行');
      const distance = rows.get('累计距离');
      if (count && distance) return `骑行月统计截图：${monthName}累计骑行 ${count}，距离 ${distance}。`;
      return `骑行月统计截图：${monthName}骑行训练数据。`;
    },
  },
  gym: {
    label: '健身房和健身设备',
    aliases: ['gym', 'strength', 'fitness', 'workout', '健身', '力量', '椭圆机'],
    heading: ['力量训练', '椭圆机', '健身房'],
    caption: (monthName, rows) => {
      const strength = rows.get('力量训练');
      const elliptical = rows.get('椭圆机');
      if (strength && elliptical) return `健身房和健身设备月统计截图：力量训练 ${strength}，椭圆机 ${elliptical}。`;
      return `健身房和健身设备月统计截图：${monthName}力量和器械训练数据。`;
    },
  },
};

const { values } = parseArgs({
  options: {
    month: { type: 'string' },
    src: { type: 'string' },
    post: { type: 'string' },
    order: { type: 'string' },
    width: { type: 'string', default: String(LINK_WIDTH) },
    quality: { type: 'string', default: '86' },
    'dry-run': { type: 'boolean', default: false },
    'no-upload': { type: 'boolean', default: false },
    'no-patch': { type: 'boolean', default: false },
  },
});

function usage() {
  console.error(`Usage:
  npm run summary:images -- --month 2026-05
  npm run summary:images -- --month 2026-05 --order gym,cycling,running

Tips:
  - Default source: inbox/<month>-summary/
  - Default post: content/posts/training-summary-<month>/index.md
  - If screenshots are named running.jpg, cycling.jpg, gym.jpg, --order is not needed.
  - If screenshots have random names, --order maps sorted files to activity keys.`);
}

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

function monthName(month) {
  const names = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  return names[Number(month.slice(5, 7)) - 1] || `${Number(month.slice(5, 7))} 月`;
}

function normalizeActivity(value) {
  const raw = value.trim().toLowerCase();
  for (const [id, config] of Object.entries(ACTIVITIES)) {
    if (id === raw || config.aliases.some((alias) => raw.includes(alias.toLowerCase()))) return id;
  }
  return null;
}

function inferActivity(filename) {
  return normalizeActivity(filename.replace(/\.[^.]+$/, ''));
}

function imageUrl(domain, key, options) {
  return `${domain}/cdn-cgi/image/${options}/${key}`;
}

function getR2Domain() {
  return (process.env.IMG_DOMAIN || 'https://img.neepoo.dev').replace(/\/$/, '');
}

async function collectImages(srcDir) {
  const files = (await readdir(srcDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && IMG_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No images found in ${srcDir}.`);
  }

  const order = values.order ? values.order.split(',').map((item) => item.trim()).filter(Boolean) : [];
  if (order.length > 0 && order.length !== files.length) {
    throw new Error(`--order has ${order.length} item(s), but ${files.length} image(s) were found.`);
  }

  return files.map((file, index) => {
    const id = order.length > 0 ? normalizeActivity(order[index]) : inferActivity(file);
    if (!id) {
      throw new Error(`Cannot infer activity for ${file}. Rename it to running/cycling/gym or pass --order.`);
    }

    return { id, file, src: path.join(srcDir, file) };
  });
}

function findSection(lines, activity) {
  const start = lines.findIndex((line) => /^#{2,6}\s+/.test(line) && activity.heading.some((word) => line.includes(word)));
  if (start === -1) throw new Error(`Cannot find heading for ${activity.label}.`);

  const startLevel = lines[start].match(/^(#{2,6})\s+/)[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{2,6})\s+/);
    if (match && match[1].length <= startLevel) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function tableRows(lines, section) {
  const tableStart = lines.findIndex((line, index) => index > section.start && index < section.end && line.trim().startsWith('|'));
  if (tableStart === -1) throw new Error(`Cannot find table after heading at line ${section.start + 1}.`);

  let tableEnd = tableStart;
  while (tableEnd < section.end && lines[tableEnd].trim().startsWith('|')) tableEnd++;

  const rows = new Map();
  for (const line of lines.slice(tableStart, tableEnd)) {
    if (/^\|\s*-+/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length >= 2 && cells[0] !== '指标') rows.set(cells[0], cells[1]);
  }

  return { rows, insertAt: tableEnd };
}

function figureBlock({ activityId, month, dimensions, domain }) {
  const activity = ACTIVITIES[activityId];
  const key = `training-summary/${month}/${activityId}.jpg`;
  const displayHeight = Math.round((dimensions.height / dimensions.width) * FIGURE_WIDTH);
  const year = month.slice(0, 4);
  const monthNumber = Number(month.slice(5, 7));
  const title = `${year} 年 ${monthNumber} 月${activity.label}月统计数据`;
  const alt = `${year} 年 ${monthNumber} 月${activity.label}月统计截图`;
  const caption = activity.caption(monthName(month), dimensions.rows);
  const link = imageUrl(domain, key, `width=${LINK_WIDTH},format=auto,quality=82`);
  const thumb = imageUrl(domain, key, `width=${FIGURE_WIDTH},format=auto,quality=80`);
  const display = imageUrl(domain, key, `width=${DISPLAY_WIDTH},format=auto,quality=82`);

  return [
    `<!-- monthly-summary-image:${activityId}:start -->`,
    `<figure style="max-width:${FIGURE_WIDTH}px;margin:1.5rem auto;text-align:center;">`,
    `  <a class="lightgallery" href="${link}" title="${title}" data-thumbnail="${thumb}">`,
    `    <img src="${display}" width="${FIGURE_WIDTH}" height="${displayHeight}" loading="lazy" decoding="async" alt="${alt}" style="display:block;width:100%;height:auto;border-radius:8px;border:1px solid rgba(128,128,128,.24);box-shadow:0 10px 30px rgba(0,0,0,.10);">`,
    `  </a>`,
    `  <figcaption class="image-caption">${caption}</figcaption>`,
    `</figure>`,
    `<!-- monthly-summary-image:${activityId}:end -->`,
  ].join('\n');
}

function stripExisting(md, month, activityId) {
  const marked = new RegExp(
    `\\n?<!-- monthly-summary-image:${activityId}:start -->[\\s\\S]*?<!-- monthly-summary-image:${activityId}:end -->\\n?`,
    'g',
  );
  const unmarked = new RegExp(
    `\\n?<figure(?:(?!</figure>)[\\s\\S])*?training-summary/${month}/${activityId}\\.jpg(?:(?!</figure>)[\\s\\S])*?</figure>\\n?`,
    'g',
  );

  return md.replace(marked, '\n').replace(unmarked, '\n');
}

function patchPost(md, month, images, domain) {
  for (const image of images) {
    md = stripExisting(md, month, image.id);
  }

  let lines = md.split('\n');
  for (const image of images) {
    const section = findSection(lines, ACTIVITIES[image.id]);
    const { rows, insertAt } = tableRows(lines, section);
    const block = figureBlock({
      activityId: image.id,
      month,
      domain,
      dimensions: { width: image.width, height: image.height, rows },
    });

    lines.splice(insertAt, 0, '', block);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function main() {
  const month = values.month;
  if (!month || !MONTH_RE.test(month)) {
    usage();
    process.exit(1);
  }

  const uploadWidth = Number.parseInt(values.width, 10);
  const quality = Number.parseInt(values.quality, 10);
  if (!Number.isFinite(uploadWidth) || uploadWidth <= 0 || !Number.isFinite(quality) || quality <= 0 || quality > 100) {
    throw new Error('Invalid --width or --quality value.');
  }

  const srcDir = path.resolve(ROOT, values.src || path.join('inbox', `${month}-summary`));
  const postPath = path.resolve(ROOT, values.post || path.join('content', 'posts', `training-summary-${month}`, 'index.md'));
  const domain = getR2Domain();
  const images = await collectImages(srcDir);

  const seen = new Set();
  for (const image of images) {
    if (seen.has(image.id)) throw new Error(`Duplicate activity ${image.id}.`);
    seen.add(image.id);
  }

  let s3;
  let bucket;
  if (!values['dry-run'] && !values['no-upload']) {
    const accountId = need('R2_ACCOUNT_ID');
    bucket = need('R2_BUCKET');
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: need('R2_ACCESS_KEY_ID'),
        secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

  for (const image of images) {
    const result = await sharp(image.src)
      .rotate()
      .resize({ width: uploadWidth, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    image.width = result.info.width;
    image.height = result.info.height;
    const key = `training-summary/${month}/${image.id}.jpg`;

    if (!values['dry-run'] && !values['no-upload']) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: result.data,
          ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    }

    const action = values['dry-run'] || values['no-upload'] ? 'prepared' : 'uploaded';
    console.log(`${action} ${key} from ${image.file} (${Math.round(result.data.length / 1024)} KB)`);
  }

  if (!values['no-patch']) {
    const before = await readFile(postPath, 'utf8');
    const after = patchPost(before, month, images, domain);
    if (!values['dry-run']) await writeFile(postPath, after);
    console.log(`${values['dry-run'] ? 'would patch' : 'patched'} ${path.relative(ROOT, postPath)}`);
  }
}

main().catch((error) => {
  const name = error?.name ? `${error.name}: ` : '';
  const message = error?.message || String(error);
  console.error(`${name}${message}`);
  process.exit(1);
});
