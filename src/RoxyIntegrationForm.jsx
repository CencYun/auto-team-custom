import React, { useEffect, useMemo, useState } from 'react';
import { Check, Plug, RefreshCw, X } from 'lucide-react';

const DEFAULT_BASE_URL = 'http://127.0.0.1:50000';

function normalizeProfiles(value) {
  return (Array.isArray(value) ? value : []).filter((item) => item && item.childId && item.dirId).map((item) => ({
    childId: String(item.childId),
    dirId: String(item.dirId),
    proxyId: String(item.proxyId || ''),
  }));
}

export default function RoxyIntegrationForm({ config = {}, accounts = [], proxySettings = {}, onSave, onCheck, compact = false }) {
  const [form, setForm] = useState(() => ({
    enabled: config.enabled === true,
    headless: config.headless === true,
    useProxyPool: config.useProxyPool === true,
    concurrency: [1, 2, 3].includes(config.concurrency) ? config.concurrency : 1,
    baseUrl: config.baseUrl || DEFAULT_BASE_URL,
    apiKey: '',
    apiKeySet: config.apiKeySet === true,
    workspaceId: config.workspaceId || '',
    profiles: normalizeProfiles(config.profiles),
  }));
  const [workspaces, setWorkspaces] = useState([]);
  const [remoteProfiles, setRemoteProfiles] = useState([]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [checkedWorkspace, setCheckedWorkspace] = useState(null);
  const savedConfig = JSON.stringify({ enabled: config.enabled === true, headless: config.headless === true, useProxyPool: config.useProxyPool === true, concurrency: [1, 2, 3].includes(config.concurrency) ? config.concurrency : 1, baseUrl: config.baseUrl || DEFAULT_BASE_URL, apiKeySet: config.apiKeySet === true, workspaceId: config.workspaceId || '', profiles: normalizeProfiles(config.profiles) });

  useEffect(() => {
    setForm({ ...JSON.parse(savedConfig), apiKey: '' });
  }, [savedConfig]);

  const accountOptions = useMemo(() => (Array.isArray(accounts) ? accounts : []).filter((account) => account?.id), [accounts]);
  const proxyEntries = Array.isArray(proxySettings.entries) ? proxySettings.entries : [];
  const proxyPoolProblem = !proxySettings.enabled ? '工具代理池尚未启用，请先在「代理池」中启用并保存。' : !proxyEntries.length ? '代理池为空，请先添加代理。' : '';
  const usedDirIds = new Set(form.profiles.map((item) => item.dirId));
  const update = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setMessage(''); setError(''); };

  async function checkConnection() {
    if (checking) return;
    setChecking(true); setError(''); setMessage('');
    try {
      const next = { enabled: form.enabled, headless: form.headless, useProxyPool: form.useProxyPool, concurrency: form.concurrency, baseUrl: form.baseUrl.trim(), workspaceId: form.workspaceId, profiles: form.profiles };
      if (form.apiKey.trim()) next.apiKey = form.apiKey.trim();
      const payload = await onCheck(next);
      if (payload?.ok === false) throw new Error(payload.message || 'Roxy 连接失败');
      setWorkspaces(Array.isArray(payload?.workspaces) ? payload.workspaces : []);
      setRemoteProfiles(Array.isArray(payload?.profiles) ? payload.profiles : []);
      setCheckedWorkspace(form.workspaceId || '');
      setMessage(payload?.message || `连接成功${payload?.workspaces?.length ? `，读取到 ${payload.workspaces.length} 个工作空间` : ''}`);
    } catch (cause) {
      setWorkspaces([]); setRemoteProfiles([]); setCheckedWorkspace(null); setError(cause?.message || 'Roxy 连接失败');
    } finally { setChecking(false); }
  }

  function updateMapping(childId, dirId) {
    setForm((current) => ({ ...current, profiles: [...current.profiles.filter((item) => item.childId !== childId), ...(dirId ? [{ childId, dirId, proxyId: current.profiles.find((item) => item.childId === childId)?.proxyId || '' }] : [])] }));
    setMessage(''); setError('');
  }

  function updateProxy(childId, proxyId) {
    setForm((current) => ({ ...current, profiles: current.profiles.map((item) => item.childId === childId ? { ...item, proxyId } : item) }));
    setMessage(''); setError('');
  }

  function changeWorkspace(workspaceId) {
    if (form.profiles.length && !window.confirm('切换 Roxy 工作空间会清除当前窗口映射，确认切换？')) return;
    setForm((current) => ({ ...current, workspaceId, profiles: [] }));
    setRemoteProfiles([]); setCheckedWorkspace(null); setError(''); setMessage('');
  }

  async function save() {
    if (saving) return;
    setSaving(true); setError(''); setMessage('');
    if (form.enabled && (!form.workspaceId.trim() || (!form.apiKey.trim() && !form.apiKeySet))) {
      setSaving(false); setError('开启 Roxy 前，请填写 API Key 并选择工作空间'); return;
    }
    if (form.enabled && form.useProxyPool && proxyPoolProblem) {
      setSaving(false); setError(proxyPoolProblem); return;
    }
    const seen = new Set();
    const duplicate = form.profiles.find((item) => {
      if (!item.dirId || seen.has(item.dirId)) return true;
      seen.add(item.dirId); return false;
    });
    if (duplicate) { setSaving(false); setError('同一个 Roxy 窗口不能分配给多个账号'); return; }
    try {
      const next = { enabled: form.enabled, headless: form.headless, useProxyPool: form.useProxyPool, concurrency: form.concurrency, baseUrl: form.baseUrl.trim() || DEFAULT_BASE_URL, workspaceId: form.workspaceId.trim(), profiles: normalizeProfiles(form.profiles) };
      if (form.apiKey.trim()) next.apiKey = form.apiKey.trim();
      const saved = await onSave(next);
      if (saved === false) { setError('Roxy 配置未保存'); return; }
      setForm((current) => ({ ...current, apiKey: '', apiKeySet: Boolean(current.apiKey.trim() || current.apiKeySet) }));
      setMessage('Roxy 配置已保存');
    } catch (cause) { setError(cause?.message || '保存失败'); }
    finally { setSaving(false); }
  }

  return <section className={`roxy-panel ${compact ? 'roxy-compact' : 'content-panel'}`}>
    {compact ? <div className="modal-intro">开启后使用 Roxy 窗口自动登录；关闭时使用纯协议登录。</div> : <div className="content-toolbar"><div><h2><Plug size={17} /> RoxyBrowser</h2><p>开启后使用 Roxy 窗口自动登录；关闭时使用纯协议登录。</p></div><span className={`status-chip ${config.enabled ? 'online' : 'cooldown'}`}><i />{config.enabled ? '已启用' : '未启用'}</span></div>}
    <div className="form-grid roxy-form">
      <label className="wide"><span>Local API 地址</span><input value={form.baseUrl} disabled={checking || saving} onChange={(event) => { update('baseUrl', event.target.value); setWorkspaces([]); setRemoteProfiles([]); setCheckedWorkspace(null); }} placeholder={DEFAULT_BASE_URL} /></label>
      <label className="wide"><span>API Key{form.apiKeySet && <small className="field-hint">已保存</small>}</span><input type="password" value={form.apiKey} disabled={checking || saving} onChange={(event) => { update('apiKey', event.target.value); setWorkspaces([]); setRemoteProfiles([]); setCheckedWorkspace(null); }} placeholder={form.apiKeySet ? '留空保持现有密钥' : '输入 Roxy API Key'} autoComplete="off" /></label>
      <label className="wide"><span>Roxy 工作空间</span><select className="select-control" value={form.workspaceId} disabled={checking || saving} onChange={(event) => changeWorkspace(event.target.value)}><option value="">请选择工作空间</option>{form.workspaceId && !workspaces.some((item) => String(item.id) === String(form.workspaceId)) && <option value={form.workspaceId}>{form.workspaceId}（已保存）</option>}{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name || item.id} · {item.id}</option>)}</select></label>
      <label className="integration-enabled wide"><span>自动授权使用 Roxy</span><button type="button" className={`toggle ${form.enabled ? 'checked' : ''}`} disabled={checking || saving} onClick={() => update('enabled', !form.enabled)} aria-pressed={form.enabled} aria-label={form.enabled ? '关闭 Roxy 自动授权' : '开启 Roxy 自动授权'}><span /></button></label>
      <label className="wide"><span>浏览器启动方式</span><select className="select-control" value={form.headless ? 'headless' : 'headed'} disabled={checking || saving} onChange={(event) => update('headless', event.target.value === 'headless')}><option value="headed">有头 · 实际打开浏览器</option><option value="headless">无头 · 后台运行</option></select><small className="roxy-field-note">无头模式是否生效取决于 Roxy 版本 / 内核。</small></label>
      <label className="wide"><span>Roxy 浏览器并发数</span><select className="select-control" aria-label="Roxy 浏览器并发数" value={form.concurrency} disabled={checking || saving} onChange={(event) => update('concurrency', Number(event.target.value))}><option value={1}>1 个 · 逐个执行（默认）</option><option value={2}>2 个 · 同时执行</option><option value={3}>3 个 · 同时执行</option></select><small className="roxy-field-note">最多同时执行 3 个账号；完成一个后自动接着下一个。与 Free 账号管理页共用此设置。</small></label>
      <label className="integration-enabled wide"><span>使用工具代理池</span><button type="button" className={`toggle ${form.useProxyPool ? 'checked' : ''}`} disabled={checking || saving} onClick={() => update('useProxyPool', !form.useProxyPool)} aria-pressed={form.useProxyPool} aria-label={form.useProxyPool ? '关闭 Roxy 使用工具代理池' : '开启 Roxy 使用工具代理池'}><span /></button></label>
    </div>
    <p className={`roxy-profile-note ${form.useProxyPool && proxyPoolProblem ? 'roxy-pool-warning' : ''}`} role={form.useProxyPool && proxyPoolProblem ? 'status' : undefined}>{form.useProxyPool ? proxyPoolProblem || `代理池已启用，共 ${proxyEntries.length} 条。启动时使用账号绑定的代理，自动分配后保持固定；连接状态以实际授权结果为准。` : '使用 Roxy 窗口原有网络配置。开启代理池后，浏览器与本次授权请求使用同一条代理。'}</p>
    <div className="roxy-actions"><button type="button" className="button ghost" onClick={checkConnection} disabled={checking || saving || !form.baseUrl.trim()}><RefreshCw size={14} className={checking ? 'button-spinner' : ''} />{checking ? '检查中' : '检查连接'}</button><button type="button" className="button primary" onClick={save} disabled={saving || checking}><Check size={14} />{saving ? '保存中' : '保存配置'}</button></div>
    {error && <div className="roxy-feedback error"><X size={14} />{error}</div>}
    {message && <div className="roxy-feedback success"><Check size={14} />{message}</div>}
    <div className="roxy-mapping-head"><strong>账号环境 · 一号一窗口</strong><span>{form.profiles.length} 个已绑定 · {checkedWorkspace ? `${remoteProfiles.length} 个可选窗口` : '首次授权时自动绑定'}</span></div>
    <p className="roxy-profile-note">首次自动授权时，为未绑定账号创建并保存独立窗口；后续复用自己的登录状态。也可检查连接后手动指定窗口，同一窗口不能分配给多个账号。</p>
    {!accountOptions.length && <div className="roxy-empty">暂无 Free 账号</div>}
    <div className="roxy-mappings">{accountOptions.map((account) => {
      const mapping = form.profiles.find((item) => item.childId === account.id);
      const dirId = mapping?.dirId || '';
      const proxyId = mapping?.proxyId || '';
      return <div className="roxy-mapping" key={account.id}>
        <div className="roxy-mapping-account"><strong title={account.email || account.id}>{account.email || account.id}</strong>{dirId && <button type="button" className="icon-button small danger-hover" disabled={checking || saving} title="取消窗口绑定" aria-label={`取消 ${account.email || account.id} 的窗口绑定`} onClick={() => updateMapping(account.id, '')}><X size={14} /></button>}</div>
        <div className="roxy-mapping-controls">
          <label><span>独立窗口</span><select className="select-control" aria-label={`${account.email || account.id} 的 Roxy 窗口`} value={dirId} disabled={checking || saving} onChange={(event) => updateMapping(account.id, event.target.value)}><option value="">首次授权时自动创建并绑定</option>{dirId && !remoteProfiles.some((item) => String(item.dirId) === dirId) && <option value={dirId}>已绑定 · {account.email || account.id}</option>}{remoteProfiles.map((profile) => { const id = String(profile.dirId); return <option key={id} value={id} disabled={usedDirIds.has(id) && id !== dirId}>{profile.name || id} · {id}</option>; })}</select></label>
          {form.useProxyPool && <label><span>固定代理</span><select className="select-control" aria-label={`${account.email || account.id} 的代理`} value={proxyId} disabled={checking || saving || !dirId} onChange={(event) => updateProxy(account.id, event.target.value)}><option value="">自动分配并固定</option>{proxyId && !proxyEntries.some((entry) => entry.id === proxyId) && <option value={proxyId}>原代理已删除，请重新选择</option>}{proxyEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label ? `${entry.label} · ` : ''}{entry.display || entry.id}{entry.healthy === false ? '（待恢复）' : ''}</option>)}</select></label>}
        </div>
      </div>;
    })}</div>
  </section>;
}
