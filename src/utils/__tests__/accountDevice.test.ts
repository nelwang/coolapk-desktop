import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectAccountDevice, fallbackAccountDevice, parseAccountDevice, type AccountDeviceApi } from '../accountDevice';

const androidUa = 'Dalvik/2.1.0 (Linux; U; Android 16; 2210132C Build/BP2A.250605.031.A3) (#Build; Xiaomi; 2210132C; BP2A.250605.031.A3; HyperOS_3.0; 3.0.310.0) +CoolMarket/16.5.1';
const appleUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) (#Build; Apple; iPhone18,2; 23A341; 26.0) +CoolMarket/16.5.1';
const row = (id: string, dateline: number, extra = {}) => ({ id, dateline, uid: '123', entityType: 'feed', ...extra });
function createApi(): AccountDeviceApi {
  return { getUserFeeds: vi.fn().mockResolvedValue({ data: [] }), getFeedDetail: vi.fn(), getReplyDetail: vi.fn() };
}

describe('账号历史机型识别', () => {
  afterEach(() => vi.useRealTimers());

  it('从 Android UA 提取型号、品牌、Build 和 SDK，并保留 ROM 信息', () => {
    expect(parseAccountDevice(androidUa, 100)).toMatchObject({ model: '2210132C', manufacturer: 'Xiaomi', brand: 'Xiaomi', build: 'BP2A.250605.031.A3', sdkInt: '36', dateline: 100, userAgent: androidUa });
  });

  it('识别苹果硬件代号，不把没有型号的 Safari UA 当作完整指纹', () => {
    expect(parseAccountDevice(appleUa)).toMatchObject({ model: 'iPhone18,2', brand: 'Apple', build: '23A341' });
    expect(parseAccountDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)')).toBeNull();
  });

  it('排除旧版兼容机型、自动设置后的自身记录和异常 UA', () => {
    const old = 'Dalvik/2.1.0 (Linux; U; Android 16; 23113RKC6C Build/AQ3A.250226.002) (#Build; Redmi; 23113RKC6C; AQ3A.250226.002; 16) +CoolMarket/16.2.0-2604201-universal';
    for (const ua of [old, fallbackAccountDevice.userAgent, `${androidUa} CoolapkDesktopAuto`, `${androidUa}\r\nInjected: yes`]) expect(parseAccountDevice(ua)).toBeNull();
    expect(fallbackAccountDevice).toMatchObject({ model: '23113RKC6C', label: 'Redmi K70 Pro', source: 'fallback' });
  });

  it('比较动态和评论发布时间，忽略置顶顺序及其他账号的记录', async () => {
    const api = createApi();
    vi.mocked(api.getUserFeeds).mockImplementation(async (_uid, _page, type) => ({ data: type === 'feed' ? [row('pinned', 10), row('new-feed', 30), row('other', 100, { uid: '456', userAgent: androidUa })] : [row('reply', 40, { entityType: 'feed_reply' })] }));
    vi.mocked(api.getReplyDetail).mockResolvedValue({ data: { id: 'reply', userAgent: appleUa } });
    expect(await detectAccountDevice('123', api)).toMatchObject({ model: 'iPhone18,2', dateline: 40 });
    expect(api.getFeedDetail).not.toHaveBeenCalled();
  });

  it('拒绝详情中不匹配的账号和 ID，单条失败后继续寻找', async () => {
    const api = createApi();
    vi.mocked(api.getUserFeeds).mockResolvedValue({ data: [row('1', 40), row('2', 30), row('3', 20), row('4', 10)] });
    vi.mocked(api.getFeedDetail).mockResolvedValueOnce({ data: { id: '1', uid: '456', useragent: appleUa } }).mockResolvedValueOnce({ data: { id: 'wrong', useragent: appleUa } }).mockRejectedValueOnce(new Error('已删除')).mockResolvedValue({ data: { id: '4', useragent: androidUa } });
    expect(await detectAccountDevice('123', api)).toMatchObject({ model: '2210132C', dateline: 10 });
  });

  it('接口不可用或没有本人记录时不生成虚假的识别结果', async () => {
    const api = createApi();
    vi.mocked(api.getUserFeeds).mockRejectedValue(new Error('离线'));
    expect(await detectAccountDevice('123', api)).toBeNull();
  });

  it('请求一直不返回时在总预算内结束，不阻塞登录', async () => {
    vi.useFakeTimers();
    const api = createApi();
    vi.mocked(api.getUserFeeds).mockImplementation(() => new Promise(() => {}));
    const pending = detectAccountDevice('123', api);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBeNull();
  });
});
