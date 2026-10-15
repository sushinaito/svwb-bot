import test from 'node:test';
import assert from 'node:assert/strict';
import { collectImages, validAttachmentUrl, imageBlock, loadImages, MAX_IMAGE_BYTES } from '../src/chat/vision.js';
import { routeMessage } from '../src/chat/routing.js';
import { DiscordGateway } from '../src/chat/gateway.js';
import { FakeContext, env, message } from './helpers.js';

export const pngBytes = () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
const attachment = (id = '111', extra = {}) => ({ id, filename: 'deck.png', content_type: 'image/png', size: 66, width: 1, height: 1,
  url: `https://cdn.discordapp.com/attachments/456/${id}/deck.png?ex=abc&hm=secret`, ...extra });
const descriptor = collectImages(message({ attachments: [attachment()] })).images[0];
const pngResponse = () => new Response(pngBytes(), { headers: { 'Content-Type': 'image/png' } });

test('attachments work with a bare mention, image-only thread, or reply to a bot picture', () => {
  const upload = message({ content: '<@999>', attachments: [attachment()] });
  const result = routeMessage(upload, '999', { type: 0 }, {}, env);
  assert.equal(result.images.length, 1); assert.match(result.text, /圖片/);
  assert.equal(routeMessage({ ...upload, content: '', mentions: [] }, '999', { type: 0 }, {}, env), null);
  const threaded = routeMessage({ ...upload, content: '', mentions: [] }, '999', { type: 11 }, { '456': { expires: Date.now()+60000 } }, env);
  assert.equal(threaded.images.length, 1);
  const reply = message({ type: 19, content: '', mentions: [], message_reference: { message_id: '222', channel_id: '456' },
    referenced_message: { id: '222', channel_id: '456', author: { id: '999', bot: true }, attachments: [attachment()] } });
  assert.equal(routeMessage(reply, '999', { type: 0 }, {}, env).images[0].source, 'reply');
  reply.referenced_message.author.id = 'someone';
  assert.equal(routeMessage(reply, '999', { type: 0 }, {}, env), null, 'Reply to other users still needs a mention');
  reply.mentions = [{ id: '999' }];
  assert.equal(routeMessage(reply, '999', { type: 0 }, {}, env).images.length, 1);
  reply.message_reference.channel_id = 'different';
  assert.equal(routeMessage({ ...reply, content: '看看圖片' }, '999', { type: 0 }, {}, env).images, undefined);
});

test('only same-channel Discord CDN attachments are eligible; inputs are bounded and deduplicated', () => {
  assert.equal(validAttachmentUrl(attachment().url, '456', '111'), true);
  for (const url of ['https://evil.example/attachments/456/111/a.png','http://cdn.discordapp.com/attachments/456/111/a.png',
    'https://cdn.discordapp.com/attachments/999/111/a.png','https://cdn.discordapp.com/attachments/456/111/../other/a.png',
    'https://user@cdn.discordapp.com/attachments/456/111/a.png','https://cdn.discordapp.com:8443/attachments/456/111/a.png']) {
    assert.equal(validAttachmentUrl(url, '456','111'), false);
  }
  const result = collectImages(message({ attachments: [attachment(), attachment('112'), attachment('113'), attachment('114',{ size: MAX_IMAGE_BYTES+1 })] }),
    { id: '222', attachments: [attachment()] });
  assert.equal(result.images.length, 2); assert.match(result.imageIssues.join(''), /最多讀取 2/);
  const unsupported = collectImages(message({ attachments: [attachment('1',{ content_type: 'application/pdf' }), attachment('2',{ width: 9000 }), attachment('3',{ size: MAX_IMAGE_BYTES+1 })] }));
  assert.equal(unsupported.images.length, 0); assert.equal(unsupported.imageIssues.length, 2);
  assert.equal(collectImages(message({ attachments: [attachment('1',{ content_type: undefined })] })).images.length, 1);
});

test('download sends pixels, not signed URLs, and refreshes an expired attachment from its exact message', async () => {
  const calls = [];
  const result = await loadImages(env, { images: [descriptor] }, async (raw, options = {}) => {
    const u = new URL(raw); calls.push(u);
    if (u.hostname === 'discord.com') {
      assert.match(options.headers.Authorization, /^Bot /);
      assert.equal(u.pathname, '/api/v10/channels/456/messages/m1');
      return Response.json({ id: 'm1', channel_id: '456', attachments: [attachment('111', { url: attachment().url+'&fresh=1' })] });
    }
    assert.equal(options.headers, undefined, 'Never send Discord credentials to the CDN');
    assert.equal(options.redirect, 'manual');
    return u.searchParams.has('fresh') ? pngResponse() : new Response(null, { status: 403 });
  });
  assert.equal(calls.length, 3); assert.equal(result.report[0].status, 'loaded');
  const image = result.blocks.find(b => b.type === 'image');
  assert.equal(image.source.type, 'base64'); assert.equal(image.source.media_type, 'image/png');
  assert.deepEqual(Buffer.from(image.source.data,'base64'), Buffer.from(pngBytes()));
  assert.ok(!JSON.stringify(result).includes('hm=secret'));
});

test('failed or malformed images do not prevent usable images from loading', async () => {
  const second = { ...descriptor, id: '112', url: attachment('112').url };
  const result = await loadImages(env, { images: [descriptor, second] }, async url =>
    url.includes('/112/') ? pngResponse() : new Response('not an image', { headers: { 'Content-Type': 'image/png' } }));
  assert.deepEqual(result.report.map(r => r.status), ['unavailable','loaded']);
  assert.equal(result.blocks.filter(b => b.type === 'image').length, 1);
  for (const response of [new Response(null,{status:302,headers:{ Location:'https://evil.example' }}),
    new Response('html',{headers:{'Content-Type':'text/html'}}),
    new Response(new Uint8Array(MAX_IMAGE_BYTES+1),{headers:{'Content-Type':'image/png'}})]) {
    assert.equal((await loadImages(env,{images:[descriptor]},async()=>response)).report[0].status,'unavailable');
  }
  const huge = pngBytes(); new DataView(huge.buffer).setUint32(16,9000);
  assert.throws(()=>imageBlock(huge,'image/png'), /8000/);
  assert.throws(()=>imageBlock(pngBytes(),'image/jpeg'), /格式/);
});

test('JPEG, GIF and WebP dimensions are recognized alongside PNG', () => {
  const jpeg = Uint8Array.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]);
  const gif = Uint8Array.from([...Buffer.from('GIF89a'),1,0,1,0,0,0,0]);
  const webp = new Uint8Array(30); webp.set(Buffer.from('RIFF')); webp.set(Buffer.from('WEBPVP8X'),8);
  for (const [bytes,type] of [[jpeg,'image/jpeg'],[gif,'image/gif'],[webp,'image/webp']]) {
    assert.equal(imageBlock(bytes,type).source.media_type,type);
  }
});

test('gateway accepts image-only thread messages and resolves image replies before routing', async t => {
  const ctx = new FakeContext(), gateway = new DiscordGateway(ctx, env); await ctx.ready;
  gateway.state.botId = '999'; gateway.state.threads['456'] = { owner: '789', expires: Date.now()+60000 };
  await gateway.receive(message({ content: '', mentions: [], attachments: [attachment()] }));
  assert.equal(gateway.state.pending[0].images.length, 1);
  delete gateway.state.threads['456'];
  t.mock.method(globalThis,'fetch',async raw => new URL(raw).pathname.endsWith('/messages/222') ?
    Response.json({id:'222',channel_id:'456',author:{id:'999',bot:true},attachments:[attachment()]}) : Response.json({ type:0 }));
  await gateway.receive(message({ id:'m2',type:19,content:'',mentions:[],message_reference:{message_id:'222',channel_id:'456'} }));
  assert.equal(gateway.state.pending[1].images[0].source,'reply');
});
