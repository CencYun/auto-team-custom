import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileJson, RefreshCw, Search, Trash2 } from 'lucide-react';
import './account-exports.css';

export default function AccountExportsView({ apiRequest, mothers, localAccounts = [], initialFilter, notify, onDeleteAccounts, onRefreshAccounts, deletionBusy = false }) {
  const [accounts, setAccounts] = useState([]);
  const [scope, setScope] = useState(initialFilter.scope || 'all');
  const [motherId, setMotherId] = useState(initialFilter.motherId || '');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const requestGeneration = useRef(0);
  const operationPending = useRef(false);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError('');
    Promise.all([apiRequest('/api/account-exports'), onRefreshAccounts?.()]).then(([payload]) => {
      if (generation !== requestGeneration.current) return;
      const next = Array.isArray(payload.accounts) ? payload.accounts : [];
      setAccounts(next);
      const ids = new Set(next.map((account) => account.id));
      setSelected((current) => current.filter((id) => ids.has(id)));
    }).catch((failure) => {
      if (generation !== requestGeneration.current) return;
      setError(`无法加载可导出账号：${failure.message}`);
    }).finally(() => {
      if (generation === requestGeneration.current) setLoading(false);
    });
    return () => { requestGeneration.current += 1; };
  }, [apiRequest, reload]);

  const teams = useMemo(() => {
    const byId = new Map(mothers.map((mother) => [mother.id, {
      id: mother.id,
      name: mother.name || mother.teamName || mother.email || mother.id,
      email: mother.email || '',
    }]));
    for (const account of accounts) {
      if (account.scope !== 'team') continue;
      const team = byId.get(account.motherId);
      byId.set(account.motherId, { id: account.motherId, name: account.teamName || team?.name || account.workspaceId, email: team?.email || '' });
    }
    return [...byId.values()];
  }, [accounts, mothers]);
  const query = search.trim().toLowerCase();
  const visible = accounts.filter((account) => (scope === 'all' || account.scope === scope)
    && (!motherId || account.motherId === motherId)
    && (!query || [account.email, account.teamName, account.workspaceId].some((value) => String(value || '').toLowerCase().includes(query))));
  const selectedSet = new Set(selected);
  const localById = new Map(localAccounts.map((account) => [account.id, account]));
  const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
  const ownerEmails = new Set(mothers.flatMap((mother) => [mother.email, mother.primaryOwnerEmail, ...(mother.ownerAccounts || []).map((owner) => owner.email)]).map(normalizeEmail).filter(Boolean));
  function deletionPolicy(account) {
    if (['owner', 'account-owner'].includes(account.role) || ownerEmails.has(normalizeEmail(account.email))) return { eligible: false, message: '母号请在 Team 管理中维护' };
    const local = localById.get(account.childId);
    if (!local || normalizeEmail(local.email) !== normalizeEmail(account.email)) return { eligible: false, message: '未关联可删除的本地账号' };
    return local.localDeletion || { eligible: false, message: '请刷新账号状态后再删除' };
  }
  const selectedRows = accounts.filter((account) => selectedSet.has(account.id));
  const deletableIds = [...new Set(selectedRows.filter((account) => deletionPolicy(account).eligible === true).map((account) => account.childId))];
  const protectedCount = selectedRows.filter((account) => deletionPolicy(account).eligible !== true).length;
  const visibleSelected = visible.filter((account) => selectedSet.has(account.id)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  const changing = exporting || deleting;
  const unavailable = loading || changing || Boolean(error);
  const scopes = [['all', '全部 JSON'], ['free', '账号 JSON'], ['team', 'Team JSON']];

  function changeScope(next) {
    setScope(next);
    setMotherId('');
    setSelected([]);
  }

  function toggleVisible(checked) {
    const visibleIds = new Set(visible.map((account) => account.id));
    setSelected((current) => checked ? [...new Set([...current, ...visibleIds])] : current.filter((id) => !visibleIds.has(id)));
  }

  async function downloadSelected() {
    if (!selected.length || unavailable || operationPending.current) return;
    operationPending.current = true;
    setExporting(true);
    try {
      const payload = await apiRequest('/api/account-exports', { method: 'POST', body: JSON.stringify({ ids: selected }) });
      if (!Array.isArray(payload.accounts) || payload.accounts.length !== selected.length) {
        throw new Error('可导出账号已变化，请刷新列表后重新选择');
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const selectedScopes = new Set(accounts.filter((account) => selectedSet.has(account.id)).map((account) => account.scope));
      const kind = selectedScopes.size === 1 && selectedScopes.has('team') ? 'team-' : '';
      const now = new Date();
      const localDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
      anchor.href = url;
      anchor.download = `sub2api-${kind}accounts-${localDate}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`已导出所选 ${payload.accounts.length} 份 JSON`);
    } catch (failure) {
      notify(`导出失败：${failure.message}`, 'error');
      setReload((current) => current + 1);
    } finally {
      operationPending.current = false;
      setExporting(false);
    }
  }

  async function deleteSelected() {
    if (!deletableIds.length || unavailable || deletionBusy || !onDeleteAccounts || operationPending.current) return;
    operationPending.current = true;
    setDeleting(true);
    try {
      const payload = await onDeleteAccounts(deletableIds);
      if (!payload) return;
      const deletedIds = new Set((payload.deleted || []).map((account) => account.id));
      const deletedRows = new Set(accounts.filter((account) => deletedIds.has(account.childId)).map((account) => account.id));
      setAccounts((current) => current.filter((account) => !deletedIds.has(account.childId)));
      setSelected((current) => current.filter((id) => !deletedRows.has(id)));
      setReload((current) => current + 1);
    } catch (failure) {
      notify(`批量删除失败：${failure.message}`, 'error');
      setReload((current) => current + 1);
    } finally {
      operationPending.current = false;
      setDeleting(false);
    }
  }

  return <section className="content-panel account-exports" aria-label="账号 JSON 选择导出">
    <div className="content-toolbar">
      <div><h2>选择要导出的账号</h2><p>仅显示已获取完整 JSON 的账号；同一邮箱在不同空间的授权可分别选择。</p></div>
      <div className="toolbar-actions">
        <button className="button ghost" disabled={loading || changing} onClick={() => setReload((current) => current + 1)}><RefreshCw size={15} className={loading ? 'button-spinner' : ''} />刷新列表</button>
        <button className="button primary" disabled={!selected.length || unavailable} onClick={downloadSelected}><Download size={15} />{exporting ? '正在导出' : `导出已选 (${selected.length})`}</button>
        <button className="button danger" disabled={!deletableIds.length || unavailable || deletionBusy || !onDeleteAccounts} title="按账号去重删除本地记录及其全部 JSON；仍在 Team 的成员和母号会保留" onClick={deleteSelected}><Trash2 size={15} />{deleting ? '正在核验删除' : `删除已选 (${deletableIds.length})`}</button>
      </div>
    </div>
    <div className="export-filters">
      <div className="segmented export-types" role="group" aria-label="JSON 类型">
        {scopes.map(([value, label]) => <button key={value} aria-pressed={scope === value} className={scope === value ? 'selected' : ''} disabled={changing} onClick={() => changeScope(value)}>{label}<span>{accounts.filter((account) => value === 'all' || account.scope === value).length}</span></button>)}
      </div>
      <div className="export-search-row">
        <div className="search-box"><Search size={15} /><input aria-label="搜索可导出账号" value={search} disabled={changing} onChange={(event) => setSearch(event.target.value)} placeholder="搜索邮箱或工作空间" /></div>
        {scope !== 'free' && <select className="select-control" aria-label="导出目标 Team" disabled={changing} value={motherId} onChange={(event) => { setMotherId(event.target.value); setSelected([]); }}>
          <option value="">全部 Team</option>
          {teams.map((team) => <option key={team.id} value={team.id}>{team.name}{team.email && team.name !== team.email ? ` · ${team.email}` : ''}</option>)}
        </select>}
      </div>
    </div>
    <div className="export-selection-bar">
      <label><input type="checkbox" aria-label="全选当前列表" checked={allVisibleSelected} disabled={!visible.length || unavailable} ref={(node) => { if (node) node.indeterminate = visibleSelected > 0 && !allVisibleSelected; }} onChange={(event) => toggleVisible(event.target.checked)} />全选当前列表</label>
      <span>显示 {visible.length} 份 · 已选 {selected.length} 份{selected.length > visibleSelected ? `（含筛选外 ${selected.length - visibleSelected} 份）` : ''}</span>
      {selected.length > 0 && <span className="export-delete-summary" role="status">可删除 {deletableIds.length} 个账号{protectedCount ? ` · ${protectedCount} 份 JSON 对应账号不可删除` : ''}</span>}
      {selected.length > 0 && <button className="export-clear" disabled={changing} onClick={() => setSelected([])}>清空选择</button>}
    </div>
    {error ? <div className="empty-state export-error" role="alert"><AlertTriangle size={25} /><strong>{error}</strong><button className="button ghost" onClick={() => setReload((current) => current + 1)}>重试</button></div>
      : loading ? <div className="empty-state" role="status"><RefreshCw className="button-spinner" size={25} /><strong>正在加载可导出账号</strong></div>
      : !visible.length ? <div className="empty-state"><FileJson size={28} /><strong>{accounts.length ? '没有符合筛选条件的 JSON' : '暂无可导出的 JSON'}</strong><span>{accounts.length ? '调整类型、Team 或搜索条件后再试。' : '先在 Free 账号管理中获取 JSON，成功后刷新此列表。'}</span></div>
      : <div className="table-wrap export-table-wrap"><table className="data-table export-table"><thead><tr><th className="export-check-cell"><span className="export-visually-hidden">选择</span></th><th>账号邮箱</th><th>JSON 类型</th><th>授权空间</th><th>状态</th></tr></thead>
        <tbody>{visible.map((account) => <tr key={account.id} className={selectedSet.has(account.id) ? 'export-row-selected' : ''}>
          <td className="export-check-cell"><input type="checkbox" aria-label={`选择 ${account.email} 的${account.scope === 'team' ? ` ${account.teamName || account.workspaceId} Team` : '账号'} JSON`} checked={selectedSet.has(account.id)} disabled={changing} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, account.id])] : current.filter((id) => id !== account.id))} /></td>
          <td><strong className="export-email">{account.email}</strong>{account.role && <small>{['account-owner', 'owner'].includes(account.role) ? '所有者' : ['account-admin', 'admin'].includes(account.role) ? '管理员' : '成员'}</small>}</td>
          <td><span className={`export-scope ${account.scope}`}>{account.scope === 'team' ? 'Team JSON' : '账号 JSON'}</span></td>
          <td><strong>{account.scope === 'team' ? account.teamName || 'Team 空间' : '个人空间'}</strong><small className="mono">{account.workspaceId || '—'}</small></td>
          <td><span className={account.accessTokenExpired ? 'export-ready pending' : 'export-ready'}>{account.accessTokenExpired ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}{account.accessTokenExpired ? '已保存 · 待刷新' : 'JSON 已就绪'}</span>{account.accessTokenExpired && <small>含 RT，使用前刷新授权</small>}<small className="export-delete-policy">{deletionPolicy(account).eligible ? '可删除本地账号' : deletionPolicy(account).message}</small></td>
        </tr>)}</tbody></table></div>}
    <p className="export-footnote">导出为 Sub2API 兼容 JSON 文件，包含所选账号的授权凭据。</p>
    <p className="export-footnote export-delete-note">删除按账号去重，会清除该账号及其全部本地 JSON；仍在 Team 的账号需先移除成员，母号请在 Team 管理中维护。</p>
  </section>;
}
