import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Eye, EyeOff, FolderLock, Pencil, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import { exportMotherVaultText } from '../shared/mother-vault-text.mjs';
import './mother-vault.css';

const emptyRecord = () => ({ account: '', password: '', totp: '', note: '', remarkTime: '' });
const localCalendarDate = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};

function VaultDialog({ title, children, onClose, busy = false }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    const firstInput = dialog?.querySelector('input:not([type="hidden"]), textarea, button');
    (firstInput || dialog)?.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((element) => element.getClientRects().length);
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return <div className="mother-vault-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="mother-vault-dialog" role="dialog" aria-modal="true" aria-labelledby="mother-vault-dialog-title" ref={dialogRef} tabIndex={-1}>
      <div className="mother-vault-dialog-heading"><h2 id="mother-vault-dialog-title">{title}</h2><button type="button" className="mother-vault-icon" aria-label="关闭母号管理弹窗" disabled={busy} onClick={onClose}><X size={19} /></button></div>
      {children}
    </section>
  </div>;
}

function exportFilename(format) {
  const now = new Date();
  const pad = (number, length = 2) => String(number).padStart(length, '0');
  return `mother-vault-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.${format}`;
}

export default function MotherVaultView({ apiRequest, notify }) {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState([]);
  const [exportFormat, setExportFormat] = useState('txt');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState('');
  const [hiddenSecrets, setHiddenSecrets] = useState({});
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState(emptyRecord);
  const [autoRemarkDate, setAutoRemarkDate] = useState(true);
  const manualRemarkTime = useRef('');
  const [importText, setImportText] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [editorVisible, setEditorVisible] = useState({});
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
    setLoading(true);
    setLoadError('');
    apiRequest('/api/mother-vault').then(async (payload) => {
      if (!mounted.current || currentGeneration !== generation.current) return;
      if (!Array.isArray(payload.records)) throw new Error('账号列表返回格式不正确');
      const ids = new Set(payload.records.map((record) => record.id));
      // The list shows credentials by default. Reuse the authenticated batch
      // read; keep the values only in this view's memory, never browser storage.
      const details = ids.size ? await apiRequest('/api/mother-vault/export', { method: 'POST', body: JSON.stringify({ ids: [...ids] }) }) : { records: [] };
      if (!mounted.current || currentGeneration !== generation.current) return;
      if (!Array.isArray(details.records) || details.records.length !== ids.size || new Set(details.records.map((record) => record.id)).size !== ids.size
        || details.records.some((record) => !ids.has(record.id) || typeof record.password !== 'string' || typeof record.totp !== 'string')) throw new Error('账号资料已变化，请刷新列表');
      setRecords(details.records.map((record) => ({ ...record, hasPassword: Boolean(record.password), hasTotp: Boolean(record.totp) })));
      const secretKeys = new Set([...ids].flatMap((id) => [`${id}:password`, `${id}:totp`]));
      setHiddenSecrets((current) => Object.fromEntries(Object.entries(current).filter(([key]) => secretKeys.has(key))));
      setSelected((current) => current.filter((id) => ids.has(id)));
    }).catch((failure) => {
      if (mounted.current && currentGeneration === generation.current) setLoadError(`无法加载母号资料：${failure.message}`);
    }).finally(() => {
      if (mounted.current && currentGeneration === generation.current) setLoading(false);
    });
    return () => { generation.current += 1; };
  }, [apiRequest, reload]);

  const visibleRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    return records.filter((record) => !query || [record.account, record.note, record.remarkTime].some((value) => String(value || '').toLowerCase().includes(query)));
  }, [records, search]);
  const selectedSet = new Set(selected);
  const selectedVisible = visibleRecords.filter((record) => selectedSet.has(record.id)).length;
  const allVisibleSelected = visibleRecords.length > 0 && selectedVisible === visibleRecords.length;
  const busy = Boolean(pending);
  const unavailable = busy || loading || Boolean(loadError);

  function closeDialog() {
    if (pending) return;
    importGeneration.current += 1;
    setDialog(null);
    setForm(emptyRecord());
    manualRemarkTime.current = '';
    setAutoRemarkDate(true);
    setImportText('');
    setDialogError('');
    setEditorVisible({});
  }

  function openDialog(type, details = {}) {
    setDialogError('');
    setEditorVisible({});
    setForm({ ...emptyRecord(), remarkTime: type === 'create' ? localCalendarDate() : '' });
    manualRemarkTime.current = '';
    setAutoRemarkDate(type === 'create');
    setImportText('');
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
      const payload = await apiRequest(`/api/mother-vault/${encodeURIComponent(record.id)}`);
      if (!mounted.current) return;
      if (!payload.record || payload.record.id !== record.id) throw new Error('账号资料已变化，请刷新列表');
      const next = payload.record;
      setForm({ account: next.account || '', password: next.password || '', totp: next.totp || '', note: next.note || '', remarkTime: next.remarkTime || '' });
      manualRemarkTime.current = next.remarkTime || '';
      setAutoRemarkDate(false);
      setDialogError('');
      setEditorVisible({});
      setDialog({ type: 'edit', id: record.id });
    } catch (failure) {
      if (mounted.current) notify(`读取资料失败：${failure.message}`, 'error');
    } finally {
      if (mounted.current) setPending('');
    }
  }

  function toggleSecret(record, field) {
    if (unavailable) return;
    const key = `${record.id}:${field}`;
    setHiddenSecrets((current) => ({ ...current, [key]: !current[key] }));
  }

  function toggleAutoRemarkDate(checked) {
    if (checked) {
      manualRemarkTime.current = form.remarkTime;
      setForm((current) => ({ ...current, remarkTime: localCalendarDate() }));
    } else {
      setForm((current) => ({ ...current, remarkTime: manualRemarkTime.current }));
    }
    setAutoRemarkDate(checked);
  }

  function editRemarkTime(value) {
    manualRemarkTime.current = value;
    setAutoRemarkDate(false);
    setForm((current) => ({ ...current, remarkTime: value }));
  }

  async function saveRecord(event) {
    event.preventDefault();
    if (pending || !form.account.trim()) return;
    const editing = dialog.type === 'edit';
    setPending('save');
    setDialogError('');
    try {
      await apiRequest(editing ? `/api/mother-vault/${encodeURIComponent(dialog.id)}` : '/api/mother-vault', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(form) });
      if (!mounted.current) return;
      setDialog(null);
      setForm(emptyRecord());
      setEditorVisible({});
      setReload((current) => current + 1);
      notify(editing ? '母号资料已保存' : '母号资料已添加');
    } catch (failure) {
      if (mounted.current) setDialogError(`保存失败：${failure.message}`);
    } finally {
      if (mounted.current) setPending('');
    }
  }

  async function readImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || pending) return;
    const currentGeneration = ++importGeneration.current;
    setPending('file');
    setDialogError('');
    try {
      if (file.size > 2_000_000) throw new Error('文件不能超过 2 MB，请拆分后导入');
      const text = await file.text();
      if (mounted.current && currentGeneration === importGeneration.current) setImportText(text);
    } catch (failure) {
      if (mounted.current && currentGeneration === importGeneration.current) setDialogError(`读取文件失败：${failure.message}`);
    } finally {
      if (mounted.current && currentGeneration === importGeneration.current) setPending('');
    }
  }

  async function importRecords(event) {
    event.preventDefault();
    if (pending || !importText.trim()) return;
    const body = JSON.stringify({ text: importText });
    if (body.length > 2_000_000) {
      setDialogError('导入内容过大，请拆分后导入（提交内容不能超过 2,000,000 个字符）。');
      return;
    }
    setPending('import');
    setDialogError('');
    try {
      const result = await apiRequest('/api/mother-vault/import', { method: 'POST', body });
      if (!mounted.current) return;
      setDialog(null);
      setImportText('');
      setReload((current) => current + 1);
      notify(`导入完成：新增 ${result.imported} 条，重复跳过 ${result.skipped} 条`);
    } catch (failure) {
      if (mounted.current) {
        const issues = Array.isArray(failure.payload?.errors) ? failure.payload.errors : [];
        const detail = issues.slice(0, 5).map((issue) => `第 ${issue.line} 行：${issue.message}`).join('；');
        setDialogError(`导入失败：${detail || failure.message}${issues.length > 5 ? `；另有 ${issues.length - 5} 处错误` : ''}`);
      }
    } finally {
      if (mounted.current) setPending('');
    }
  }

  async function exportSelected() {
    if (!selected.length || unavailable) return;
    const ids = [...selected];
    const format = exportFormat;
    setPending('export');
    try {
      const payload = await apiRequest('/api/mother-vault/export', { method: 'POST', body: JSON.stringify({ ids }) });
      if (!mounted.current) return;
      if (!Array.isArray(payload.records) || payload.records.length !== ids.length || new Set(payload.records.map((record) => record.id)).size !== ids.length || payload.records.some((record) => !ids.includes(record.id))) throw new Error('所选账号已变化，请刷新列表后重新选择');
      const content = format === 'txt' ? exportMotherVaultText(payload.records) : JSON.stringify(payload, null, 2);
      const url = URL.createObjectURL(new Blob([content], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFilename(format);
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`已导出所选 ${payload.records.length} 条母号资料（${format.toUpperCase()}）`);
    } catch (failure) {
      if (mounted.current) { notify(`导出失败：${failure.message}`, 'error'); setReload((current) => current + 1); }
    } finally {
      if (mounted.current) setPending('');
    }
  }

  async function deleteRecords() {
    if (pending || !dialog?.ids?.length) return;
    const ids = [...dialog.ids];
    setPending('delete');
    setDialogError('');
    try {
      const result = ids.length === 1
        ? await apiRequest(`/api/mother-vault/${encodeURIComponent(ids[0])}`, { method: 'DELETE' })
        : await apiRequest('/api/mother-vault/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
      if (!mounted.current) return;
      setDialog(null);
      setSelected((current) => current.filter((id) => !ids.includes(id)));
      setReload((current) => current + 1);
      notify(`已删除 ${result.deleted} 条本地母号资料`);
    } catch (failure) {
      if (mounted.current) { setDialogError(`删除失败：${failure.message}`); setReload((current) => current + 1); }
    } finally {
      if (mounted.current) setPending('');
    }
  }

  function renderSecret(record, field, label) {
    const hasValue = field === 'password' ? record.hasPassword : record.hasTotp;
    const key = `${record.id}:${field}`;
    const shown = hiddenSecrets[key] !== true;
    return <div className="mother-vault-secret"><span className={shown ? 'mother-vault-secret-value' : 'mother-vault-secret-mask'}>{hasValue ? shown ? record[field] || '—' : '••••••••' : '未填写'}</span>{hasValue && <button type="button" className="mother-vault-icon" disabled={busy} onClick={() => toggleSecret(record, field)} aria-label={`${shown ? '隐藏' : '显示'} ${record.account} 的${label}`} title={shown ? `隐藏${label}` : `显示${label}`}>{shown ? <EyeOff size={14} /> : <Eye size={14} />}</button>}</div>;
  }

  return <section className="content-panel mother-vault" aria-label="母号资料管理">
    <div className="content-toolbar">
      <div><h2>母号资料</h2><p>仅存放账号资料，不参与 Team 授权或轮转。</p></div>
      <div className="toolbar-actions">
        <button type="button" className="button ghost" disabled={busy || loading} onClick={() => setReload((current) => current + 1)}><RefreshCw size={15} className={loading ? 'button-spinner' : ''} />刷新</button>
        <button type="button" className="button ghost" disabled={busy} onClick={() => openDialog('import')}><Upload size={15} />导入资料</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => openDialog('create')}><Plus size={15} />添加母号</button>
      </div>
    </div>
    <div className="mother-vault-tools">
      <div className="search-box"><Search size={15} /><input aria-label="搜索母号资料" placeholder="搜索账号、备注或时间" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <div className="mother-vault-selection-actions">
        <select className="mother-vault-export-format" aria-label="母号导出格式" value={exportFormat} disabled={busy} onChange={(event) => setExportFormat(event.target.value)}><option value="txt">TXT 文本</option><option value="json">JSON 文件</option></select>
        <button type="button" className="button ghost" disabled={!selected.length || unavailable} onClick={exportSelected}><Download size={15} />{pending === 'export' ? '正在导出' : `导出 ${exportFormat.toUpperCase()} (${selected.length})`}</button>
        <button type="button" className="button ghost mother-vault-danger" disabled={!selected.length || unavailable} onClick={() => openDialog('delete', { ids: [...selected] })}><Trash2 size={15} />删除已选</button>
      </div>
    </div>
    <div className="mother-vault-selection-bar">
      <label><input type="checkbox" aria-label="全选当前母号列表" checked={allVisibleSelected} disabled={!visibleRecords.length || unavailable} ref={(element) => { if (element) element.indeterminate = selectedVisible > 0 && !allVisibleSelected; }} onChange={(event) => toggleVisible(event.target.checked)} />全选当前列表</label>
      <span>共 {records.length} 条 · 显示 {visibleRecords.length} 条 · 已选 {selected.length} 条{selected.length > selectedVisible ? `（含筛选外 ${selected.length - selectedVisible} 条）` : ''}</span>
      {selected.length > 0 && <button type="button" className="mother-vault-clear" disabled={busy} onClick={() => setSelected([])}>清空选择</button>}
    </div>
    {loadError ? <div className="empty-state mother-vault-error" role="alert"><AlertTriangle size={25} /><strong>{loadError}</strong><button type="button" className="button ghost" onClick={() => setReload((current) => current + 1)}>重试</button></div>
      : loading ? <div className="empty-state" role="status"><RefreshCw size={25} className="button-spinner" /><strong>正在加载母号资料</strong></div>
        : !visibleRecords.length ? <div className="empty-state"><FolderLock size={28} /><strong>{records.length ? '没有匹配的母号资料' : '暂未存放母号资料'}</strong><span>{records.length ? '请调整搜索条件。' : '点击“添加母号”逐条保存，或导入文本、JSON 文件。'}</span></div>
          : <div className="table-wrap mother-vault-table-wrap"><table className="data-table mother-vault-table"><thead><tr><th className="mother-vault-check"><span className="mother-vault-sr-only">选择</span></th><th>账号</th><th>密码</th><th>2FA 密钥</th><th>备注</th><th>备注时间</th><th>操作</th></tr></thead><tbody>{visibleRecords.map((record) => <tr key={record.id} className={selectedSet.has(record.id) ? 'mother-vault-selected' : ''}>
            <td className="mother-vault-check"><input type="checkbox" aria-label={`选择母号 ${record.account}`} checked={selectedSet.has(record.id)} disabled={busy} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, record.id])] : current.filter((id) => id !== record.id))} /></td>
            <td><strong className="mother-vault-account">{record.account}</strong></td>
            <td>{renderSecret(record, 'password', '密码')}</td><td>{renderSecret(record, 'totp', '2FA 密钥')}</td>
            <td><span className="mother-vault-note">{record.note || '—'}</span></td><td><span className="mother-vault-time">{record.remarkTime || '—'}</span></td>
            <td><div className="mother-vault-row-actions"><button type="button" className="mother-vault-icon" aria-label={`编辑母号 ${record.account}`} title="编辑资料" disabled={busy} onClick={() => editRecord(record)}>{pending === `edit:${record.id}` ? <RefreshCw size={15} className="button-spinner" /> : <Pencil size={15} />}</button><button type="button" className="mother-vault-icon mother-vault-danger" aria-label={`删除母号 ${record.account}`} title="删除本地资料" disabled={busy} onClick={() => openDialog('delete', { ids: [record.id] })}><Trash2 size={15} /></button></div></td>
          </tr>)}</tbody></table></div>}
    <p className="mother-vault-footnote">TXT 每行：账号----密码----2FA----备注----时间。导出包含所选账号的密码和 2FA，可在此重新导入；也可切换为 JSON。</p>

    {dialog && <VaultDialog title={dialog.type === 'import' ? '导入母号资料' : dialog.type === 'delete' ? '删除本地母号资料' : dialog.type === 'edit' ? '编辑母号资料' : '添加母号资料'} busy={busy} onClose={closeDialog}>
      {(dialog.type === 'create' || dialog.type === 'edit') && <form onSubmit={saveRecord} className="mother-vault-form" autoComplete="off">
        <label className="mother-vault-field">账号<input value={form.account} required autoComplete="off" placeholder="邮箱或账号" disabled={busy} onChange={(event) => setForm((current) => ({ ...current, account: event.target.value }))} /></label>
        <div className="mother-vault-form-grid">{[['password', '密码'], ['totp', '2FA 密钥']].map(([field, label]) => {
          const shown = editorVisible[field] !== false;
          return <label className="mother-vault-field" key={field}>{label}<div className="mother-vault-input-secret"><input type={shown ? 'text' : 'password'} value={form[field]} autoComplete="new-password" placeholder="可选" disabled={busy} spellCheck={false} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} /><button type="button" className="mother-vault-icon" disabled={busy} aria-label={`${shown ? '隐藏' : '显示'}填写的${label}`} title={`${shown ? '隐藏' : '显示'}${label}`} onClick={() => setEditorVisible((current) => ({ ...current, [field]: !shown }))}>{shown ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>;
        })}</div>
        <label className="mother-vault-field">备注<textarea value={form.note} rows={3} placeholder="用途、来源等（可选）" disabled={busy} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} /></label>
        <div className="mother-vault-date-field">
          <label className="mother-vault-field">备注时间<input value={form.remarkTime} placeholder="如 2026-10-10，或手动填写到期时间（可选）" disabled={busy} aria-describedby="mother-vault-date-hint" onChange={(event) => editRemarkTime(event.target.value)} /></label>
          <label className="mother-vault-auto-date"><input type="checkbox" checked={autoRemarkDate} disabled={busy} onChange={(event) => toggleAutoRemarkDate(event.target.checked)} />自动填写今天日期（年-月-日）</label>
          <small id="mother-vault-date-hint" className="mother-vault-date-hint">已填日期可直接编辑；手动修改后取消自动勾选，保存你输入的内容。</small>
        </div>
        {dialogError && <p className="mother-vault-inline-error" role="alert">{dialogError}</p>}
        <div className="mother-vault-dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={closeDialog}>取消</button><button type="submit" className="button primary" disabled={busy || !form.account.trim()}>{pending === 'save' ? '正在保存' : '保存资料'}</button></div>
      </form>}
      {dialog.type === 'import' && <form onSubmit={importRecords} className="mother-vault-form">
        <p className="mother-vault-import-help">每行一条，格式：账号----密码----2FA----备注----备注时间。最后两项可省略；已有账号会跳过，原资料保持不变。</p>
        <code className="mother-vault-import-example">account@example.com----password----2FA----备注----2026-10-10</code>
        <div className="mother-vault-import-file"><input ref={fileInput} type="file" accept=".txt,.json,text/plain,application/json" hidden onChange={readImportFile} /><button type="button" className="button ghost" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={15} />{pending === 'file' ? '正在读取' : '选择 TXT / JSON 文件'}</button><span>也支持粘贴本页导出的完整 JSON</span></div>
        <label className="mother-vault-field">导入内容<textarea rows={8} value={importText} autoComplete="off" spellCheck={false} placeholder="粘贴账号资料，或选择文件" disabled={busy} onChange={(event) => setImportText(event.target.value)} /></label>
        {dialogError && <p className="mother-vault-inline-error" role="alert">{dialogError}</p>}
        <div className="mother-vault-dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={closeDialog}>取消</button><button type="submit" className="button primary" disabled={busy || !importText.trim()}>{pending === 'import' ? '正在导入' : '导入资料'}</button></div>
      </form>}
      {dialog.type === 'delete' && <div className="mother-vault-delete-confirm">
        <p>确定删除这 {dialog.ids.length} 条本地资料吗？删除后无法在此恢复。</p>
        <div className="mother-vault-delete-accounts">{records.filter((record) => dialog.ids.includes(record.id)).map((record) => <span key={record.id}>{record.account}</span>)}</div>
        <p className="mother-vault-delete-note">仅删除本页保存的资料，不会删除远端账号，也不会移出 Team 或修改授权。</p>
        {dialogError && <p className="mother-vault-inline-error" role="alert">{dialogError}</p>}
        <div className="mother-vault-dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={closeDialog}>取消</button><button type="button" className="button mother-vault-delete-button" disabled={busy} onClick={deleteRecords}>{pending === 'delete' ? '正在删除' : `删除 ${dialog.ids.length} 条本地资料`}</button></div>
      </div>}
    </VaultDialog>}
  </section>;
}
