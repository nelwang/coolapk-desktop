import { reactive } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupAccountDeviceSync } from '../accountDeviceSync';
import type { AccountDeviceProfile } from '../accountDevice';

const ua = 'Dalvik/2.1.0 (Linux; U; Android 16; 2210132C Build/actual-build) (#Build; Xiaomi; 2210132C; actual-build; 16) +CoolMarket/16.5.1';
let stop: (() => void) | undefined;
function setup() {
  const auth = reactive({ isLoggedIn: true, user: { uid: '123' } as { uid: string } | null });
  const settings = reactive({ settings: { deviceFingerprint: { customFingerprint: false } }, profile: null as AccountDeviceProfile | null, setAutomaticDeviceProfile: vi.fn(async (profile: AccountDeviceProfile | null) => { settings.profile = profile; }) });
  const api = { getDeviceInfo: vi.fn().mockResolvedValue({ data: { defaultProfile: { source: 'compatibility' } } }), getUserFeeds: vi.fn().mockResolvedValue({ data: [] }), getFeedDetail: vi.fn(), getReplyDetail: vi.fn() };
  return { auth, settings, api };
}

describe('账号设备信息自动同步', () => {
  afterEach(() => stop?.());

  it('无历史记录使用 iPhone 18 Pro Max，启用手动设置后取消自动覆盖', async () => {
    const { auth, settings, api } = setup();
    stop = setupAccountDeviceSync(auth, settings, api);
    await flushPromises();
    expect(settings.profile?.model).toBe('23113RKC6C');
    settings.settings.deviceFingerprint.customFingerprint = true;
    await flushPromises();
    expect(settings.profile).toBeNull();
  });

  it('本机真实设备优先，不扫描账号历史', async () => {
    const { auth, settings, api } = setup();
    api.getDeviceInfo.mockResolvedValue({ data: { defaultProfile: { source: 'native', platform: 'android' } } });
    stop = setupAccountDeviceSync(auth, settings, api);
    await flushPromises();
    expect(settings.profile).toBeNull();
    expect(api.getUserFeeds).not.toHaveBeenCalled();
  });

  it('成功识别本人记录后应用历史机型，退出登录后恢复兜底', async () => {
    const { auth, settings, api } = setup();
    api.getUserFeeds.mockResolvedValue({ data: [{ id: 'own', uid: '123', dateline: 100, userAgent: ua }] });
    stop = setupAccountDeviceSync(auth, settings, api);
    await flushPromises();
    expect(settings.profile).toMatchObject({ source: 'history', model: '2210132C' });
    auth.isLoggedIn = false;
    await flushPromises();
    expect(settings.profile).toMatchObject({ source: 'fallback', model: '23113RKC6C' });
  });

  it('切换账号后旧请求迟到也不能覆盖新账号的兜底结果', async () => {
    const { auth, settings, api } = setup();
    let resolveOld!: (value: any) => void;
    const oldRequest = new Promise(resolve => { resolveOld = resolve; });
    api.getUserFeeds.mockImplementation((uid: string) => uid === '123' ? oldRequest : Promise.resolve({ data: [] }));
    stop = setupAccountDeviceSync(auth, settings, api);
    await flushPromises();
    auth.user = { uid: '456' };
    await flushPromises();
    resolveOld({ data: [{ id: 'old', uid: '123', dateline: 100, userAgent: ua }] });
    await flushPromises();
    expect(settings.profile?.source).toBe('fallback');
  });

  it('识别中改用手动指纹或退出登录时不应用迟到结果', async () => {
    const { auth, settings, api } = setup();
    let resolveDetail!: (value: any) => void;
    api.getUserFeeds.mockResolvedValue({ data: [{ id: 'own', uid: '123', dateline: 100 }] });
    api.getFeedDetail.mockImplementation(() => new Promise(resolve => { resolveDetail = resolve; }));
    stop = setupAccountDeviceSync(auth, settings, api);
    await flushPromises();
    settings.settings.deviceFingerprint.customFingerprint = true;
    await flushPromises();
    resolveDetail({ data: { id: 'own', useragent: ua } });
    await flushPromises();
    expect(settings.profile).toBeNull();
    auth.isLoggedIn = false;
    await flushPromises();
    expect(settings.profile).toBeNull();
  });
});
