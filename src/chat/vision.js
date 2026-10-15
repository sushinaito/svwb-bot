import { discord } from './api.js';

export const MAX_IMAGES = 2;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function validAttachmentUrl(raw, channelId, attachmentId) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname) &&
      !u.username && !u.password && !u.port && /^\d+$/.test(channelId) && /^\d+$/.test(attachmentId) &&
      u.pathname.startsWith(`/attachments/${channelId}/${attachmentId}/`) &&
      u.pathname.split('/').length === 5 && u.href.length <= 2500;
  } catch { return false; }
}

export function collectImages(message, referenced) {
  const images = [], issues = [], seen = new Set();
  for (const [source, item] of [['upload', message], ['reply', referenced]]) {
    for (const a of item?.attachments || []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const type = a.content_type?.split(';')[0].toLowerCase() ||
        ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[String(a.filename).split('.').at(-1).toLowerCase()];
      if (!TYPES.has(type)) {
        issues.push('附件格式不支援；請傳 PNG、JPEG、WebP 或 GIF 圖片。'); continue;
      }
      if (images.length >= MAX_IMAGES) { issues.push('每則最多讀取 2 張圖片，其餘圖片請分次傳送。'); continue; }
      if (a.size > MAX_IMAGE_BYTES || a.width > 8000 || a.height > 8000) {
        issues.push('圖片超過單張 5 MB 或 8000 像素限制，請縮小後重傳。'); continue;
      }
      if (!validAttachmentUrl(a.url, message.channel_id, a.id)) {
        issues.push('圖片連結無法安全讀取，請重新上傳附件。'); continue;
      }
      images.push({ id: a.id, messageId: item.id, channelId: message.channel_id, url: a.url,
        filename: String(a.filename || 'image').slice(0, 150), mediaType: type, source });
    }
  }
  return { images, imageIssues: [...new Set(issues)].slice(0, 4) };
}

function dimensions(bytes, type) {
  const ascii = (at, len) => String.fromCharCode(...bytes.subarray(at, at + len));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'image/png' && bytes.length >= 24 &&
      [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n) && ascii(12,4) === 'IHDR') {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (type === 'image/gif' && bytes.length >= 10 && ['GIF87a','GIF89a'].includes(ascii(0,6))) {
    return [view.getUint16(6,true), view.getUint16(8,true)];
  }
  if (type === 'image/webp' && bytes.length >= 30 && ascii(0,4) === 'RIFF' && ascii(8,4) === 'WEBP') {
    if (ascii(12,4) === 'VP8X') return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
    if (ascii(12,4) === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return [view.getUint16(26,true) & 16383, view.getUint16(28,true) & 16383];
    if (ascii(12,4) === 'VP8L' && bytes[20] === 47) return [1 + ((bytes[21] | bytes[22] << 8) & 16383), 1 + ((bytes[22] >> 6 | bytes[23] << 2 | bytes[24] << 10) & 16383)];
  }
  if (type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p++] !== 255) break;
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (p + 2 > bytes.length) break;
      const size = view.getUint16(p);
      if (size < 2 || p + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) return [view.getUint16(p + 5), view.getUint16(p + 3)];
      p += size;
    }
  }
  throw Error('圖片格式無效，請重新匯出為 PNG 或 JPEG。');
}

export function imageBlock(bytes, mediaType) {
  if (!TYPES.has(mediaType) || bytes.length > MAX_IMAGE_BYTES) throw Error('圖片格式不支援或超過 5 MB，請縮小後重傳。');
  const [width, height] = dimensions(bytes, mediaType);
  if (!width || !height || width > 8000 || height > 8000) throw Error('圖片尺寸無效或超過 8000 像素，請縮小後重傳。');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: btoa(binary) } };
}

async function download(env, image, fetcher, asPng = false) {
  let url = image.url;
  if (!validAttachmentUrl(url, image.channelId, image.id)) throw Error('圖片連結無效，請重新上傳。');
  const requestUrl = raw => {
    if (!asPng) return raw;
    const proxy = new URL(raw); proxy.hostname = 'media.discordapp.net';
    proxy.searchParams.set('format', 'png');
    return proxy.href;
  };
  let response = await fetcher(requestUrl(url), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if ([403,404].includes(response.status)) {
    await response.body?.cancel();
    // Re-fetch only the explicitly referenced message to refresh its signed URL.
    const current = await discord(env, `/channels/${image.channelId}/messages/${image.messageId}`, 'GET', undefined, fetcher);
    if (current.id !== image.messageId || current.channel_id !== image.channelId) throw Error('圖片訊息已無法讀取。');
    url = current.attachments?.find(a => a.id === image.id)?.url;
    if (!validAttachmentUrl(url, image.channelId, image.id)) throw Error('圖片已刪除或無法讀取，請重新上傳。');
    response = await fetcher(requestUrl(url), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  }
  const type = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (!response.ok || !TYPES.has(type) || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES || !response.body) {
    await response.body?.cancel(); throw Error('圖片無法讀取、格式不支援或超過 5 MB，請重新上傳較小的圖片。');
  }
  const reader = response.body.getReader(), parts = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_IMAGE_BYTES) throw Error('圖片超過 5 MB，請縮小後重傳。');
      parts.push(value);
    }
  } catch (e) { await reader.cancel(); throw e; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let p = 0;
  for (const part of parts) { bytes.set(part,p); p += part.length; }
  return imageBlock(bytes, type);
}

// The card renderer decodes PNG/JPEG. Discord's attachment proxy converts WebP
// on the same trusted host, retaining the exact attachment ID and signed URL.
export async function loadArtwork(env, image, fetcher = fetch) {
  let block = await download(env, image, fetcher, image.mediaType === 'image/webp');
  if (block.source.media_type === 'image/webp') block = await download(env, image, fetcher, true);
  if (!['image/png', 'image/jpeg'].includes(block.source.media_type)) throw Error('立繪轉換失敗；未送出空白卡，請重新上傳 PNG/JPEG。');
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

export async function loadImages(env, input, fetcher = fetch) {
  const blocks = [], report = [];
  for (const image of (input.images || []).slice(0, MAX_IMAGES)) {
    try {
      const block = await download(env, image, fetcher);
      blocks.push({ type: 'text', text: `圖片 ${report.length + 1}（${image.source === 'reply' ? '被回覆訊息的附件' : '本則上傳附件'}）：` }, block);
      report.push({ filename: image.filename, source: image.source, status: 'loaded' });
    } catch {
      report.push({ filename: image.filename, source: image.source, status: 'unavailable',
        message: '未讀到此圖片；可能已失效、格式不符或超過 5 MB／8000 像素，請重傳較小的 PNG 或 JPEG。' });
    }
  }
  return { blocks, report };
}
