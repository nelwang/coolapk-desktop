/** 历史发布记录只用于识别机型和系统信息，不复制设备唯一标识。 */
export interface AccountDeviceProfile {
  manufacturer: string;
  brand: string;
  model: string;
  build: string;
  userAgent: string;
  sdkInt?: string;
  label: string;
  source: 'history' | 'fallback';
  dateline: number;
}

// 型号来自随包 AppleDB 表；系统为兼容模板，Build 不伪装成真实设备构建号。
export const fallbackAccountDevice: AccountDeviceProfile = {
  manufacturer: 'Xiaomi',
  brand: 'Redmi',
  model: '23113RKC6C',
  build: 'AQ3A.250226.002',
  userAgent: 'Dalvik/2.1.0 (Linux; U; Android 14; 23113RKC6C Build/AQ3A.250226.002) (#Build; Redmi; 23113RKC6C; AQ3A.250226.002; 14) +CoolMarket/16.2.0-2604201-universal',
  sdkInt: '34',
  label: 'Redmi K70 Pro',
  source: 'fallback',
  dateline: 0,
};

const androidSdks: Record<string, string> = { '10': '29', '11': '30', '12': '31', '12.1': '32', '13': '33', '14': '34', '15': '35', '16': '36', '17': '37' };

/** 只接受包含机型、系统和构建号的手机 UA，网页 UA 与桌面兜底记录不能作为识别依据。 */
export function parseAccountDevice(userAgent: unknown, dateline = 0): AccountDeviceProfile | null {
  if (typeof userAgent !== 'string' || userAgent.length > 2048 || /[\r\n\x00]/.test(userAgent) || /CoolapkDesktop(?:Fallback|Auto)/i.test(userAgent)) return null;
  const metadata = userAgent.match(/\(#Build;\s*([^)]*)\)/)?.[1]?.split(';').map(value => value.trim());
  const android = userAgent.match(/Android ([\d.]+);\s*([^;()]+?) Build\/([^\s)]+)/);
  const apple = userAgent.match(/CPU (?:iPhone )?OS ([\d_]+) like Mac OS X/);
  const brand = metadata?.[0] || '';
  const model = metadata?.[1] || android?.[2]?.trim() || '';
  const build = metadata?.[2] || android?.[3] || '';
  if (!model || !build || model.length > 80 || build.length > 120 || /[;\r\n]/.test(model + build)) return null;
  // 旧版桌面兼容模板不是用户实际手机，避免把客户端自身记录再次识别为手机。
  if (model === '23113RKC6C' && build === 'AQ3A.250226.002' && userAgent.includes('+CoolMarket/16.2.0-2604201-universal')) return null;
  if (apple && /^(iPhone|iPad|iPod)\d+,\d+$/.test(model)) {
    return { manufacturer: 'Apple', brand: 'Apple', model, build, userAgent, label: model, source: 'history', dateline };
  }
  if (!android || !brand || /windows|macintosh|x86_64|emulator/i.test(userAgent)) return null;
  return { manufacturer: /^(redmi|poco|xiaomi)$/i.test(brand) ? 'Xiaomi' : brand, brand, model, build, userAgent, sdkInt: androidSdks[android[1]], label: `${brand} ${model}`, source: 'history', dateline };
}

export interface AccountDeviceApi {
  getUserFeeds(uid: string, page: number, type: string): Promise<any>;
  getFeedDetail(id: string): Promise<any>;
  getReplyDetail(id: string): Promise<any>;
}

/** 限制历史扫描范围；按发布时间比较动态与评论，不能把置顶顺序当作最近使用顺序。 */
export async function detectAccountDevice(uid: string, api: AccountDeviceApi, isCurrent: () => boolean = () => true): Promise<AccountDeviceProfile | null> {
  const deadline = Date.now() + 20_000;
  async function request<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('历史机型识别超时')), Math.max(1, deadline - Date.now())); })]);
    } finally { clearTimeout(timer); }
  }
  const lists = await Promise.allSettled(['feed', 'reply'].map(type => request(() => api.getUserFeeds(uid, 1, type))));
  if (!isCurrent()) return null;
  const candidates: Array<{ id: string; type: string; dateline: number; raw: any }> = [];
  lists.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !Array.isArray(result.value?.data)) return;
    for (const item of result.value.data) {
      const owner = String(item.uid ?? item.userInfo?.uid ?? '');
      const id = String(item.id ?? '');
      const dateline = Number(item.dateline || 0);
      if (owner !== uid || !id || !Number.isFinite(dateline) || dateline <= 0 || !['feed', 'feed_reply', 'reply', ''].includes(String(item.entityType || ''))) continue;
      candidates.push({ id, type: index === 0 ? 'feed' : 'reply', dateline, raw: item });
    }
  });
  candidates.sort((left, right) => right.dateline - left.dateline);
  for (const candidate of candidates.slice(0, 8)) {
    if (!isCurrent() || Date.now() >= deadline) break;
    const direct = parseAccountDevice(candidate.raw.useragent ?? candidate.raw.userAgent, candidate.dateline);
    if (direct) return direct;
    try {
      const response = await request(() => candidate.type === 'feed' ? api.getFeedDetail(candidate.id) : api.getReplyDetail(candidate.id));
      const detail = response?.data;
      if (!detail || String(detail.id ?? '') !== candidate.id) continue;
      const detailOwner = String(detail.uid ?? detail.userInfo?.uid ?? uid);
      if (detailOwner !== uid) continue;
      const profile = parseAccountDevice(detail.useragent ?? detail.userAgent, candidate.dateline);
      if (profile) return profile;
    } catch {
      // 单条已删除、不可见或接口失败时继续检查其他本人记录。
    }
  }
  return null;
}
