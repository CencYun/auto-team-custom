import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Eye, EyeOff, Mail, Pencil, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import { exportMailboxVaultText } from '../shared/mailbox-vault-text.mjs';
import './mother-vault.css';
import './mailbox-vault.css';

const endpoint = '/api/mailbox-vault';
const emptyRecord = () => ({ account: '', password: '', totp: '' });

function MailboxDialog({ title, busy, onClose, children }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    (dialog.querySelector('input:not([type="hidden"]), textarea, button') || dialog).focus();
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), [tabindex="0"]')].filter((node) => node.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <div className="mother-vault-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="mother-vault-dialog" role="dialog" aria-modal="true" aria-labelledby="mailbox-dialog-title" ref={dialogRef} tabIndex={-1}>
      <div className="mother-vault-dialog-heading"><h2 id="mailbox-dialog-title">{title}</h2><button type="button" className="mother-vault-icon" aria-label="关闭邮箱管理弹窗" disabled={busy} onClick={onClose}><X size={19} /></button></div>
      {children}
    </section>
  </div>;
}

export default function MailboxVaultView({ apiRequest, notify }) {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState('');
  const [hiddenSecrets, setHiddenSecrets] = useState({});
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState(emptyRecord);
  const [editorHidden, setEditorHidden] = useState({});
  const [importText, setImportText] = useState('');
  const [dialogError, setDialogError] = useState('');
  const mounted = useRef(true);
  const generation = useRef(0);
  const importGeneration = useRef(0);
  const fileInput = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; importGeneration.current += 1; };
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setLoading(true); setLoadError('');
    apiRequest(endpoint).then(async (payload) => {
      if (!mounted.current || currentGeneration !== generation.current) return;
      if (!Array.isArray(payload.records)) throw new Error('邮箱列表返回格式不正确');
      const ids = new Set(payload.records.map((record) => record.id));
      const details = ids.size ? await apiRequest(`${endpoint}/export`, { method: 'POST', body: JSON.stringify({ ids: [...ids] }) }) : { records: [] };
      if (!mounted.current || currentGeneration !== generation.current) return;
      validateRecords(details.records, [...ids]);
      setRecords(details.records);
      const keys = new Set([...ids].flatMap((id) => [`${id}:password`, `${id}:totp`]));
      setHiddenSecrets((current) => Object.fromEntries(Object.entries(current).filter(([key]) => keys.has(key))));
      setSelected((current) => current.filter((id) => ids.has(id)));
    }).catch((failure) => {
      if (mounted.current && currentGeneration === generation.current) setLoadError(`无法加载邮箱：${failure.message}`);
    }).finally(() => {
      if (mounted.current && currentGeneration === generation.current) setLoading(false);
    });
    return () => { generation.current += 1; };
  }, [apiRequest, reload]);

  function validateRecords(items, ids) {
    const idSet = new Set(ids);
    if (!Array.isArray(items) || items.length !== ids.length || new Set(items.map((record) => record.id)).size !== ids.length
      || items.some((record) => !idSet.has(record.id) || typeof record.account !== 'string' || typeof record.password !== 'string' || typeof record.totp !== 'string')) throw new Error('邮箱资料已变化，请刷新后重试');
  }

  const visibleRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    return records.filter((record) => !query || record.account.toLowerCase().includes(query));
  }, [records, search]);
  const selectedSet = new Set(selected);
  const selectedVisible = visibleRecords.filter((record) => selectedSet.has(record.id)).length;
  const allVisibleSelected = visibleRecords.length > 0 && selectedVisible === visibleRecords.length;
  const busy = Boolean(pending);
  const unavailable = busy || loading || Boolean(loadError);

  function closeDialog() {
    if (pending) return;
    importGeneration.current += 1;
    setDialog(null); setForm(emptyRecord()); setImportText(''); setDialogError(''); setEditorHidden({});
  }

  function openDialog(type, details = {}) {
    setDialogError(''); setEditorHidden({}); setForm(emptyRecord()); setImportText('');
    setDialog({ type, ...details });
  }

  function toggleVisible(checked) {
    const visibleIds = new Set(visibleRecords.map((record) => record.id));
    setSelected((current) => checked ? [...new Set([...current, ...visibleIds])] : current.filter((id) => !visibleIds.has(id)));
  }

  async function editRecord(record) {
    if (unavailable) return;
    setPending(`edit:${record.id}`);
    try {
      const payload = await apiRequest(`${endpoint}/${encodeURIComponent(record.id)}`);
      if (!mounted.current) return;
      validateRecords([payload.record], [record.id]);
      setForm({ account: payload.record.account, password: payload.record.password, totp: payload.record.totp });
      setDialogError(''); setEditorHidden({}); setDialog({ type: 'edit', id: record.id });
    } catch (failure) {
      if (mounted.current) notify(`读取邮箱失败：${failure.message}`, 'error');
    } finally { if (mounted.current) setPending(''); }
  }

  async function saveRecord(event) {
    event.preventDefault();
    if (pending || !form.account.trim()) return;
    const editing = dialog.type === 'edit';
    setPending('save'); setDialogError('');
    try {
      await apiRequest(editing ? `${endpoint}/${encodeURIComponent(dialog.id)}` : endpoint, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(form) });
      if (!mounted.current) return;
      setDialog(null); setForm(emptyRecord()); setEditorHidden({}); setReload((current) => current + 1);
      notify(editing ? '邮箱资料已保存' : '邮箱已添加');
    } catch (failure) {
      if (mounted.current) setDialogError(`保存失败：${failure.message}`);
    } finally { if (mounted.current) setPending(''); }
  }

  async function readImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || pending) return;
    const currentGeneration = ++importGeneration.current;
    setPending('file'); setDialogError('');
    try {
      if (file.size > 2_000_000) throw new Error('文件不能超过 2 MB，请拆分后导入');
      const text = await file.text();
      if (mounted.current && currentGeneration === importGeneration.current) setImportText(text);
    } catch (failure) {
      if (mounted.current && currentGeneration === importGeneration.current) setDialogError(`读取文件失败：${failure.message}`);
    } finally { if (mounted.current && currentGeneration === importGeneration.current) setPending(''); }
  }

  async function importRecords(event) {
    event.preventDefault();
    if (pending || !importText.trim()) return;
    const body = JSON.stringify({ text: importText });
    if (body.length > 2_000_000) { setDialogError('导入内容过大，请拆分后导入。'); return; }
    setPending('import'); setDialogError('');
    try {
      const result = await apiRequest(`${endpoint}/import`, { method: 'POST', body });
      if (!mounted.current) return;
      setDialog(null); setImportText(''); setReload((current) => current + 1);
      notify(`导入完成：新增 ${result.imported} 个邮箱，重复跳过 ${result.skipped} 个`);
    } catch (failure) {
      if (mounted.current) {
        const issues = Array.isArray(failure.payload?.errors) ? failure.payload.errors : [];
        const detail = issues.slice(0, 5).map((issue) => `第 ${issue.line} 行：${issue.message}`).join('；');
        setDialogError(`导入失败：${detail || failure.message}${issues.length > 5 ? `；另有 ${issues.length - 5} 处错误` : ''}`);
      }
    } finally { if (mounted.current) setPending(''); }
  }

  async function exportRecords(all = false) {
    const ids = all ? records.map((record) => record.id) : [...selected];
    if (!ids.length || unavailable) return;
    setPending(all ? 'export-all' : 'export');
    try {
      const payload = await apiRequest(`${endpoint}/export`, { method: 'POST', body: JSON.stringify({ ids }) });
      if (!mounted.current) return;
      validateRecords(payload.records, ids);
      const content = exportMailboxVaultText(payload.records);
      const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `mailbox-vault-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`已导出 ${payload.records.length} 个邮箱（TXT）`);
    } catch (failure) {
      if (mounted.current) { notify(`导出失败：${failure.message}`, 'error'); setReload((current) => current + 1); }
    } finally { if (mounted.current) setPending(''); }
  }

  async function deleteRecords() {
    if (pending || !dialog?.ids?.length) return;
    const ids = [...dialog.ids];
    setPending('delete'); setDialogError('');
    try {
      const result = ids.length === 1
        ? await apiRequest(`${endpoint}/${encodeURIComponent(ids[0])}`, { method: 'DELETE' })
        : await apiRequest(`${endpoint}/batch-delete`, { method: 'POST', body: JSON.stringify({ ids }) });
      if (!mounted.current) return;
      setDialog(null); setSelected((current) => current.filter((id) => !ids.includes(id))); setReload((current) => current + 1);
      notify(`已删除 ${result.deleted} 个本地邮箱`);
    } catch (failure) {
      if (mounted.current) { setDialogError(`删除失败：${failure.message}`); setReload((current) => current + 1); }
    } finally { if (mounted.current) setPending(''); }
  }

  function renderSecret(record, field, label) {
    const key = `${record.id}:${field}`;
    const shown = hiddenSecrets[key] !== true;
    return <div className="mother-vault-secret"><span className={shown ? 'mother-vault-secret-value' : 'mother-vault-secret-mask'}>{record[field] ? shown ? record[field] : '••••••••' : '未填写'}</span>{record[field] && <button type="button" className="mother-vault-icon" disabled={unavailable} onClick={() => setHiddenSecrets((current) => ({ ...current, [key]: !current[key] }))} aria-label={`${shown ? '隐藏' : '显示'} ${record.account} 的${label}`} title={`${shown ? '隐藏' : '显示'}${label}`}>{shown ? <EyeOff size={14} /> : <Eye size={14} />}</button>}</div>;
  }

  return <section className="content-panel mother-vault mailbox-vault" aria-label="邮箱资料管理">
    <div className="content-toolbar"><div><h2>邮箱资料</h2><p>独立存放邮箱账号、密码和 2FA，支持批量导入及 TXT 导出。</p></div><div className="toolbar-actions">
      <button type="button" className="button ghost" disabled={busy || loading} onClick={() => setReload((current) => current + 1)}><RefreshCw size={15} className={loading ? 'button-spinner' : ''} />刷新</button>
      <button type="button" className="button ghost" disabled={busy} onClick={() => openDialog('import')}><Upload size={15} />一键导入邮箱</button>
      <button type="button" className="button primary" disabled={busy} onClick={() => openDialog('create')}><Plus size={15} />添加邮箱</button>
    </div></div>
    <div className="mother-vault-tools"><div className="search-box"><Search size={15} /><input aria-label="搜索邮箱" placeholder="搜索邮箱账号" value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className="mother-vault-selection-actions">
      <button type="button" className="button ghost" disabled={!selected.length || unavailable} onClick={() => exportRecords()}><Download size={15} />{pending === 'export' ? '正在导出' : `导出已选 TXT (${selected.length})`}</button>
      <button type="button" className="button ghost" disabled={!records.length || unavailable} onClick={() => exportRecords(true)}><Download size={15} />{pending === 'export-all' ? '正在导出' : '全部导出 TXT'}</button>
      <button type="button" className="button ghost mother-vault-danger" disabled={!selected.length || unavailable} onClick={() => openDialog('delete', { ids: [...selected] })}><Trash2 size={15} />删除已选</button>
    </div></div>
    <div className="mother-vault-selection-bar"><label><input type="checkbox" aria-label="全选当前邮箱列表" checked={allVisibleSelected} disabled={!visibleRecords.length || unavailable} ref={(node) => { if (node) node.indeterminate = selectedVisible > 0 && !allVisibleSelected; }} onChange={(event) => toggleVisible(event.target.checked)} />全选当前列表</label><span>共 {records.length} 个 · 显示 {visibleRecords.length} 个 · 已选 {selected.length} 个{selected.length > selectedVisible ? `（含筛选外 ${selected.length - selectedVisible} 个）` : ''}</span>{selected.length > 0 && <button type="button" className="mother-vault-clear" disabled={busy} onClick={() => setSelected([])}>清空选择</button>}</div>
    {loadError ? <div className="empty-state mother-vault-error" role="alert"><AlertTriangle size={25} /><strong>{loadError}</strong><button type="button" className="button ghost" onClick={() => setReload((current) => current + 1)}>重试</button></div>
      : loading ? <div className="empty-state" role="status"><RefreshCw size={25} className="button-spinner" /><strong>正在加载邮箱</strong></div>
        : !visibleRecords.length ? <div className="empty-state"><Mail size={28} /><strong>{records.length ? '没有匹配的邮箱' : '暂未存放邮箱'}</strong><span>{records.length ? '请调整搜索条件。' : '点击“一键导入邮箱”，批量粘贴或选择文件，自动拆分为独立邮箱。'}</span></div>
          : <div className="table-wrap mother-vault-table-wrap"><table className="data-table mother-vault-table mailbox-vault-table"><thead><tr><th className="mother-vault-check"><span className="mother-vault-sr-only">选择</span></th><th>邮箱账号</th><th>密码</th><th>2FA 密钥</th><th>操作</th></tr></thead><tbody>{visibleRecords.map((record) => <tr key={record.id} className={selectedSet.has(record.id) ? 'mother-vault-selected' : ''}>
            <td className="mother-vault-check"><input type="checkbox" aria-label={`选择邮箱 ${record.account}`} checked={selectedSet.has(record.id)} disabled={unavailable} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, record.id])] : current.filter((id) => id !== record.id))} /></td><td><strong className="mother-vault-account">{record.account}</strong></td><td>{renderSecret(record, 'password', '密码')}</td><td>{renderSecret(record, 'totp', '2FA 密钥')}</td><td><div className="mother-vault-row-actions"><button type="button" className="mother-vault-icon" aria-label={`编辑邮箱 ${record.account}`} title="编辑邮箱" disabled={unavailable} onClick={() => editRecord(record)}><Pencil size={15} /></button><button type="button" className="mother-vault-icon mother-vault-danger" aria-label={`删除邮箱 ${record.account}`} title="删除本地邮箱" disabled={unavailable} onClick={() => openDialog('delete', { ids: [record.id] })}><Trash2 size={15} /></button></div></td>
          </tr>)}</tbody></table></div>}
    <p className="mother-vault-footnote">TXT 每行：邮箱----密码----2FA。支持勾选导出或全部导出，可重新导入。</p>
    {dialog && <MailboxDialog title={dialog.type === 'import' ? '批量导入邮箱' : dialog.type === 'delete' ? '删除本地邮箱' : dialog.type === 'edit' ? '编辑邮箱' : '添加邮箱'} busy={busy} onClose={closeDialog}>
      {(dialog.type === 'create' || dialog.type === 'edit') && <form className="mother-vault-form" autoComplete="off" onSubmit={saveRecord}>
        <label className="mother-vault-field">邮箱账号<input type="email" required value={form.account} autoComplete="off" placeholder="account@example.com" disabled={busy} onChange={(event) => setForm((current) => ({ ...current, account: event.target.value }))} /></label>
        <div className="mother-vault-form-grid">{[['password', '密码'], ['totp', '2FA 密钥']].map(([field, label]) => <label className="mother-vault-field" key={field}>{label}<div className="mother-vault-input-secret"><input type={editorHidden[field] ? 'password' : 'text'} value={form[field]} autoComplete="new-password" spellCheck={false} placeholder="可选" disabled={busy} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} /><button type="button" className="mother-vault-icon" disabled={busy} aria-label={`${editorHidden[field] ? '显示' : '隐藏'}填写的${label}`} onClick={() => setEditorHidden((current) => ({ ...current, [field]: !current[field] }))}>{editorHidden[field] ? <Eye size={15} /> : <EyeOff size={15} />}</button></div></label>)}</div>
        {dialogError && <p className="mother-vault-inline-error" role="alert">{dialogError}</p>}
        <div className="mother-vault-dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={closeDialog}>取消</button><button type="submit" className="button primary" disabled={busy || !form.account.trim()}>{pending === 'save' ? '正在保存' : '保存邮箱'}</button></div>
      </form>}
      {dialog.type === 'import' && <form className="mother-vault-form" onSubmit={importRecords}>
        <p className="mother-vault-import-help">每行一个邮箱，自动识别邮箱、密码和 2FA。支持 ----、Tab、竖线和 CSV 分隔；2FA 可留空。重复邮箱会跳过。</p>
        <code className="mother-vault-import-example">account@example.com----password----2FA<br />another@example.com----password----</code>
        <div className="mother-vault-import-file"><input ref={fileInput} type="file" accept=".txt,.csv,.json,text/plain,text/csv,application/json" hidden onChange={readImportFile} /><button type="button" className="button ghost" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={15} />{pending === 'file' ? '正在读取' : '选择 TXT / CSV / JSON 文件'}</button><span>也可直接粘贴批量邮箱</span></div>
        <label className="mother-vault-field">导入内容<textarea rows={8} aria-label="批量邮箱导入内容" value={importText} autoComplete="off" spellCheck={false} placeholder="粘贴邮箱----密码----2FA，每行一个邮箱" disabled={busy} onChange={(event) => setImportText(event.target.value)} /></label>
        {dialogError && <p className="mother-vault-inline-error" role="alert">{dialogError}</p>}
        <div className="mother-vault-dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={closeDialog}>取消</button><button type="submit" className="button primary" disabled={busy || !importText.trim()}>{pending === 'import' ? '正在导入' : '一键导入'}</button></div>
      </form>}
      {dialog.type === 'delete' && <div className="mother-vault-delete-confirm"><p>确定删除这 {dialog.ids.length} 个本地邮箱吗？删除后无法在此恢复。</p><div className="mother-vault-delete-accounts">{records.filter((record) => dialog.ids.includes(record.id)).map((record) => <span key={record.id}>{record.account}</span>)}</div>{dialogError && <p className="mother-vault-inline-error" role="alert">{dialogError}</p>}<div className="mother-vault-dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={closeDialog}>取消</button><button type="button" className="button mother-vault-delete-button" disabled={busy} onClick={deleteRecords}>{pending === 'delete' ? '正在删除' : `删除 ${dialog.ids.length} 个邮箱`}</button></div></div>}
    </MailboxDialog>}
  </section>;
}
