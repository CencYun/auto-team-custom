import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, MailPlus, RefreshCw, Search, Users } from 'lucide-react';
import { teamInviteCandidateState } from '../shared/team-workflow-ui.mjs';
import './team-invite.css';

const resultLabels = {
  invited: '已发送邀请',
  already_member: '已在 Team',
  failed: '邀请失败',
  skipped: '已跳过',
};

export default function TeamInviteForm({ accounts = [], mother, seats, onRefresh, onInvite, onCancelInvitation, onContinue, onClose, onBusyChange }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [cancelConfirmation, setCancelConfirmation] = useState('');
  const [cancellingId, setCancellingId] = useState('');
  const [cancellationNote, setCancellationNote] = useState('');
  const [selectionNote, setSelectionNote] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [capacityCheck, setCapacityCheck] = useState(null);
  const [refreshing, setRefreshing] = useState(Boolean(onRefresh));
  const [refreshError, setRefreshError] = useState('');
  const refreshGeneration = useRef(0);
  const refreshCallback = useRef(onRefresh);
  refreshCallback.current = onRefresh;
  const submittingRef = useRef(false);
  const busy = submitting || Boolean(cancellingId);
  const selectAllRef = useRef(null);
  const preferredType = mother?.defaultSeatType === 'prolite' ? 'prolite' : 'default';
  const seatTypes = Array.isArray(seats?.types) ? seats.types : [];
  const reservations = Array.isArray(capacityCheck?.reservations) ? capacityCheck.reservations : [];
  const preferredSeat = seatTypes.find((seat) => seat.type === preferredType);
  const preferredReservations = reservations.filter((reservation) => reservation.seatType === preferredType).length;
  const totalOpen = seats?.open;
  const typeOpen = preferredSeat ? preferredSeat.available == null ? null
    : Math.max(0, preferredSeat.available - preferredReservations) : seatTypes.length ? 0 : null;
  const openValue = typeOpen != null && totalOpen != null ? Math.min(Number(typeOpen), Number(totalOpen)) : typeOpen;
  const cachedAvailableSeats = openValue !== null && openValue !== undefined && openValue !== ''
    && Number.isFinite(Number(openValue)) ? Math.max(0, Math.floor(Number(openValue))) : null;
  // A cached zero can include an expired invitation. Only a complete current
  // server check may disable recipients based on capacity.
  const capacityVerified = capacityCheck?.fresh === true && !refreshing;
  const availableSeats = capacityVerified ? cachedAvailableSeats : null;
  const checkLabels = { members: '成员', subscription: '订阅席位', invitations: '邀请' };
  const failedChecks = Object.entries(capacityCheck?.checks || {}).filter(([, check]) => check?.ok === false);
  const failedCheckMessage = failedChecks.map(([key, check]) => {
    const label = checkLabels[key] || '状态核验';
    if (Number(check.status) === 403) return `${label}接口返回 403，暂无法读取`;
    if (Number(check.status) === 401) return `${label}接口返回 401，授权已失效`;
    return `${label}状态核验失败${check.status ? `（${check.status}）` : ''}`;
  }).join('；');
  const checkMessage = refreshError || (failedCheckMessage
    ? `${failedCheckMessage}。请检查母号授权及连接后刷新；已核验的邀请仍可单独撤销。`
    : capacityCheck && !capacityCheck.fresh ? '席位或邀请状态未能完整核验，请检查连接后刷新。' : '');
  const candidates = useMemo(() => accounts.map((account) => ({
    account,
    ...teamInviteCandidateState(account, mother),
  })), [accounts, mother]);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return candidates.filter(({ account }) => !search || String(account.email || '').toLowerCase().includes(search));
  }, [candidates, query]);
  const selectable = filtered.filter((candidate) => candidate.selectable);
  const allVisibleSelected = selectable.length > 0 && selectable.every(({ account }) => selected.includes(account.id));
  const someVisibleSelected = selectable.some(({ account }) => selected.includes(account.id));
  const capacityReached = availableSeats !== null && selected.length >= availableSeats;
  const resultRows = Array.isArray(result?.results) ? result.results : [];
  const invitedCount = resultRows.filter((item) => item.status === 'invited').length;
  const alreadyMemberCount = resultRows.filter((item) => item.status === 'already_member').length;
  const failedCount = resultRows.filter((item) => item.status === 'failed').length;
  const skippedCount = resultRows.filter((item) => item.status === 'skipped').length;
  const teamName = mother?.teamName || mother?.displayName || mother?.name || mother?.email || '当前 Team';

  async function refreshCapacity({ duringSubmit = false } = {}) {
    if (!refreshCallback.current || (submittingRef.current && !duringSubmit)) return;
    const generation = ++refreshGeneration.current;
    setRefreshing(true);
    setRefreshError('');
    try {
      const response = await refreshCallback.current();
      if (generation !== refreshGeneration.current) return;
      if (!response || typeof response.fresh !== 'boolean') throw new Error('未收到席位核验结果，请重试刷新。');
      setCapacityCheck(response);
    } catch (cause) {
      if (generation !== refreshGeneration.current) return;
      setCapacityCheck(null);
      setRefreshError(cause?.message || '刷新席位失败，请检查连接后重试。');
    } finally {
      if (generation === refreshGeneration.current) setRefreshing(false);
    }
  }

  useEffect(() => {
    setCapacityCheck(null);
    setSelected([]);
    setCancelConfirmation('');
    setCancellationNote('');
    void refreshCapacity();
    return () => { refreshGeneration.current += 1; };
  }, [mother?.id, mother?.accountId, mother?.team]);

  useEffect(() => {
    const eligibleIds = new Set(candidates.filter((candidate) => candidate.selectable).map(({ account }) => account.id));
    setSelected((current) => {
      const next = current.filter((id) => eligibleIds.has(id)).slice(0, availableSeats ?? Infinity);
      return current.length === next.length && current.every((id, index) => id === next[index]) ? current : next;
    });
  }, [candidates, availableSeats]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  function toggleAccount(id) {
    if (submittingRef.current || refreshing) return;
    setSelectionNote('');
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (availableSeats !== null && current.length >= availableSeats) return current;
      return [...current, id];
    });
  }

  function toggleVisible() {
    if (submittingRef.current || refreshing) return;
    if (allVisibleSelected || (capacityReached && someVisibleSelected)) {
      const visibleIds = new Set(selectable.map(({ account }) => account.id));
      setSelected((current) => current.filter((id) => !visibleIds.has(id)));
      setSelectionNote('');
      return;
    }
    const additionalIds = selectable.map(({ account }) => account.id).filter((id) => !selected.includes(id));
    const room = availableSeats === null ? additionalIds.length : Math.max(0, availableSeats - selected.length);
    setSelected((current) => [...current, ...additionalIds.slice(0, room)]);
    setSelectionNote(additionalIds.length > room ? `可用席位有限，本次最多选择 ${availableSeats} 个账号。` : '');
  }

  async function submit(event) {
    event.preventDefault();
    if (submittingRef.current || refreshing || !selected.length) return;
    submittingRef.current = true;
    setSubmitting(true);
    onBusyChange?.(true);
    setError('');
    setSelectionNote('');
    setCancelConfirmation('');
    setCancellationNote('');
    try {
      const response = await onInvite([...selected]);
      if (!response || !Array.isArray(response.results)) throw new Error('未收到有效的邀请结果，请刷新 Team 后查看邀请状态。');
      setResult(response);
      const handledIds = new Set(response.results.filter((item) => ['invited', 'already_member'].includes(item.status)).map((item) => item.id));
      setSelected((current) => current.filter((id) => !handledIds.has(id)));
      await refreshCapacity({ duringSubmit: true });
    } catch (cause) {
      setError(cause?.message || '邀请未完成，请稍后重试。');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      onBusyChange?.(false);
    }
  }

  async function cancelInvitation(reservation) {
    if (submittingRef.current || refreshing || !onCancelInvitation || reservation.cancellable !== true
      || !['invited', 'detached_invitation'].includes(reservation.phase)
      || !['invited', 'unverified'].includes(reservation.status)) return;
    submittingRef.current = true;
    setCancellingId(reservation.id);
    onBusyChange?.(true);
    setError('');
    setCancellationNote('');
    try {
      const response = await onCancelInvitation(reservation.id);
      if (!response || response.ok !== true || typeof response.fresh !== 'boolean' || !Array.isArray(response.reservations)) {
        throw new Error('未收到有效的撤销结果，请刷新席位核对邀请状态。');
      }
      setCapacityCheck(response);
      setRefreshError('');
      setResult(null);
      setSelectionNote('');
      setCancelConfirmation('');
      setCancellationNote(response.message || `已处理 ${reservation.email || '此账号'} 的邀请，席位已重新核验。`);
    } catch (cause) {
      setError(cause?.message || '撤销邀请失败，已保留占位记录，请稍后重试。');
    } finally {
      submittingRef.current = false;
      setCancellingId('');
      onBusyChange?.(false);
    }
  }

  return <form className="team-invite-form" onSubmit={submit} aria-busy={busy || refreshing}>
    <div className="team-invite-intro">
      <span className="team-invite-icon"><Users size={19} aria-hidden="true" /></span>
      <div><strong>{teamName}</strong><p>选择要邀请的子号。发送后，前往 Free 账号管理，选择此 Team 并点击“全自动获取 JSON”，后台会确认入团、获取 Team JSON 并检测额度。</p></div>
    </div>
    <div className="team-invite-capacity">
      <span>{preferredType === 'prolite' ? '高级席位' : '普通席位'} · {refreshing ? '正在同步席位与邀请…' : availableSeats === null ? '可用数量待服务端核验' : <>当前可用 <strong>{availableSeats}</strong> 个</>}</span>
      <div className="team-invite-capacity-actions"><span>已选 <strong>{selected.length}</strong> 个</span><button type="button" className="button ghost compact-button" disabled={refreshing || busy} onClick={() => refreshCapacity()}><RefreshCw size={13} className={refreshing ? 'button-spinner' : ''} />刷新席位</button></div>
    </div>
    <p className="team-invite-note">{capacityVerified ? '已同步' : '上次记录'}：在用 {seats?.used ?? '--'} / {seats?.total ?? '--'} · 官方暂留 {seats?.held ?? '--'} · 待核验占位 {seats?.reserved ?? '--'}</p>
    {checkMessage && <p className="team-invite-feedback error" role="alert"><AlertCircle size={15} aria-hidden="true" />{checkMessage}</p>}
    {capacityCheck?.released > 0 && <p className="team-invite-feedback" role="status">已清理 {capacityCheck.released} 条失效邀请预约，席位已重新计算。</p>}
    {cancellationNote && <p className="team-invite-feedback" role="status">{cancellationNote}</p>}
    {reservations.length > 0 && <div className="team-invite-reservations" aria-label="席位预约记录">
      {reservations.map((reservation) => {
        const cancellable = Boolean(onCancelInvitation) && reservation.cancellable === true
          && ['invited', 'detached_invitation'].includes(reservation.phase)
          && ['invited', 'unverified'].includes(reservation.status);
        const confirming = cancelConfirmation === reservation.id;
        return <div className="team-invite-reservation" key={reservation.id}>
          <div className="team-invite-reservation-row"><strong>{reservation.email || '未识别账号'}</strong><div className="team-invite-reservation-actions"><span>{reservation.status === 'invited' ? '邀请待接受' : reservation.status === 'approval_pending' ? '入团状态待确认' : '旧邀请待核验'}</span>
            {cancellable && !confirming && <button type="button" className="button ghost compact-button" disabled={busy || refreshing} onClick={() => { setCancelConfirmation(reservation.id); setError(''); }}>撤销邀请</button>}
          </div></div>
          {cancellable && confirming && <div className="team-invite-cancel-confirm" role="group" aria-label={`确认撤销 ${reservation.email || '此账号'} 的邀请`}>
            <p>确认撤销 <strong>{reservation.email || '此账号'}</strong> 的邀请？后台会撤销仍有效的官方邀请并刷新席位；已失效的邀请会清理本地占位。</p>
            <div><button type="button" className="button ghost compact-button" disabled={busy || refreshing} onClick={() => setCancelConfirmation('')}>保留邀请</button><button type="button" className="button secondary compact-button" disabled={busy || refreshing} onClick={() => cancelInvitation(reservation)}>{cancellingId === reservation.id ? '正在撤销…' : '确认撤销邀请'}</button></div>
          </div>}
        </div>;
      })}
      <p>也可前往 <a href="https://chatgpt.com/admin/members" target="_blank" rel="noreferrer">官方 Team 成员页</a>核对邀请后刷新。</p>
    </div>}
    <label className="team-invite-search">
      <Search size={15} aria-hidden="true" />
      <input type="search" aria-label="搜索待邀请子号邮箱" placeholder="搜索子号邮箱" value={query} onChange={(event) => setQuery(event.target.value)} disabled={busy} />
    </label>
    <div className="team-invite-list-head">
      <label><input ref={selectAllRef} type="checkbox" aria-label={capacityReached && someVisibleSelected && !allVisibleSelected ? '清空当前已选子号' : '全选当前可选子号'} checked={allVisibleSelected} disabled={busy || refreshing || !selectable.length || (capacityReached && !someVisibleSelected)} onChange={toggleVisible} />{capacityReached && someVisibleSelected && !allVisibleSelected ? '清空当前已选' : '全选当前可选'}</label>
      <span>可选 {selectable.length} 个 · 共 {filtered.length} 个</span>
    </div>
    <div className="team-invite-candidates" role="group" aria-label="待邀请子号">
      {filtered.length ? filtered.map(({ account, selectable: canSelect, reason }) => {
        const checked = selected.includes(account.id);
        const limitDisabled = !checked && capacityReached;
        return <label className={`team-invite-candidate${checked ? ' selected' : ''}${!canSelect || limitDisabled ? ' unavailable' : ''}`} key={account.id}>
          <input type="checkbox" aria-label={`邀请 ${account.email || '未设置邮箱的账号'}`} checked={checked} disabled={busy || refreshing || !canSelect || limitDisabled} onChange={() => toggleAccount(account.id)} />
          <span className="team-invite-candidate-copy"><strong>{account.email || '未设置邮箱'}</strong><small>{reason || (limitDisabled ? '已达到当前可用席位数量' : '可邀请 · 无需先获取 Free JSON')}</small></span>
          {checked && <CheckCircle2 size={16} aria-hidden="true" />}
        </label>;
      }) : <div className="team-invite-empty">{query.trim() ? '没有匹配的子号' : '账号池暂无子号，请先导入账号。'}</div>}
    </div>
    <p className="team-invite-note">{!capacityVerified && '可先选择账号，发送前会再次核验席位。'}发送邀请不代表已加入 Team；实际可用席位及席位类型以服务端核验为准。</p>
    {selectionNote && <p className="team-invite-feedback" role="status">{selectionNote}</p>}
    {error && <p className="team-invite-feedback error" role="alert"><AlertCircle size={15} aria-hidden="true" />{error}</p>}
    {result && <section className="team-invite-results" aria-label="邀请结果" aria-live="polite">
      <div className="team-invite-result-summary"><strong>邀请结果</strong><span>已邀请 {invitedCount} · 已在 Team {alreadyMemberCount} · 失败 {failedCount}{skippedCount ? ` · 跳过 ${skippedCount}` : ''}</span></div>
      <div className="team-invite-result-list">{resultRows.map((item, index) => <div className={`team-invite-result ${item.status}`} key={`${item.id || item.email}-${index}`}>
        <div><strong>{item.email || '未知账号'}</strong>{item.message && <small>{item.message}</small>}</div>
        <span>{resultLabels[item.status] || '待确认'}</span>
      </div>)}</div>
    </section>}
    <div className="modal-foot team-invite-foot">
      <button className="button ghost" type="button" disabled={busy} onClick={onClose}>{result ? '关闭' : '取消'}</button>
      <div className="modal-foot-actions">
        {result && <button className="button secondary" type="button" disabled={busy} onClick={onContinue}>前往 Free 账号管理<ArrowRight size={14} aria-hidden="true" /></button>}
        <button className="button primary" type="submit" disabled={busy || refreshing || !selected.length}><MailPlus size={15} aria-hidden="true" />{submitting ? '正在发送邀请…' : `${capacityVerified ? '发送邀请' : '核验并发送邀请'}${selected.length ? `（${selected.length}）` : ''}`}</button>
      </div>
    </div>
  </form>;
}
