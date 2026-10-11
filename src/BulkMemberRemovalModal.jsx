import React, { useMemo, useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldAlert, UserMinus, XCircle } from 'lucide-react';
import { teamMemberRemovalCandidates } from '../shared/team-member-removal-batch.mjs';
import './bulk-member-removal.css';

const normalized = (value) => String(value || '').trim().toLowerCase();
const targetKey = (target) => JSON.stringify([
  target.childId, normalized(target.email), normalized(target.motherId), normalized(target.workspaceId),
]);
const teamName = (mother) => mother.teamName || mother.displayName || '未命名 Team';

export default function BulkMemberRemovalModal({
  accounts = [], mothers = [], initialMotherId = '', busy = false, batch = {}, onConfirm, onClose,
}) {
  const [motherId, setMotherId] = useState(() => mothers.some((mother) => mother.id === initialMotherId)
    ? initialMotherId : mothers.length === 1 ? mothers[0].id : '');
  const [selected, setSelected] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const candidates = useMemo(() => motherId ? teamMemberRemovalCandidates(accounts, mothers, motherId) : [], [accounts, mothers, motherId]);
  const candidateKeys = new Set(candidates.map(targetKey));
  const selectedKeys = new Set(selected.map(targetKey));
  const staleCount = selected.filter((target) => !candidateKeys.has(targetKey(target))).length;
  const allSelected = candidates.length > 0 && candidates.every((target) => selectedKeys.has(targetKey(target)));
  const loading = Boolean(batch.loading);
  const locked = busy || loading || submitted;
  const results = Array.isArray(batch.results) ? batch.results : [];
  const showResults = loading || results.length > 0 || Boolean(batch.error);
  const total = Number(batch.total) || 0;
  const completed = Number(batch.completed) || 0;
  const finished = submitted && !loading;

  function changeSelection(next) {
    setSelected(next);
    setConfirmed(false);
    setSubmitError('');
  }

  function changeTeam(next) {
    setMotherId(next);
    changeSelection([]);
  }

  async function confirmRemoval() {
    if (locked || !confirmed || !selected.length || staleCount) return;
    setSubmitted(true);
    setSubmitError('');
    try {
      // Submit the reviewed snapshots, never a freshly expanded candidate list.
      const accepted = await onConfirm(selected.map((target) => ({ ...target })));
      if (accepted === false) {
        setSubmitted(false);
        setConfirmed(false);
      }
    } catch (error) {
      setSubmitted(false);
      setConfirmed(false);
      setSubmitError(error?.message || '暂时无法移除成员，请重试');
    }
  }

  return <div className="bulk-member-removal">
    {!submitted && !loading && <>
      <p className="bulk-member-removal-intro">选择 Team 和要移除的成员，确认后逐个处理。仅移除成员关系，保留本地账号资料。</p>
      <label className="bulk-member-removal-team">
        <span>目标 Team</span>
        <select className="select-control" value={motherId} disabled={locked} onChange={(event) => changeTeam(event.target.value)}>
          <option value="">请选择 Team</option>
          {mothers.map((mother) => <option key={mother.id} value={mother.id}>{teamName(mother)}{mother.email && normalized(teamName(mother)) !== normalized(mother.email) ? ` · ${mother.email}` : ''}</option>)}
        </select>
      </label>
      <div className="bulk-member-removal-selection-head">
        <label>
          <input type="checkbox" checked={allSelected} disabled={locked || !candidates.length} onChange={() => changeSelection(allSelected ? [] : candidates.map((target) => ({ ...target })))} />
          <span>全选可移除成员 ({candidates.length})</span>
        </label>
        <span>已选 {selected.length} 个{selected.length > 0 && <button className="text-button" disabled={locked} onClick={() => changeSelection([])}>清空</button>}</span>
      </div>
      <div className="bulk-member-removal-list" aria-label="选择要移除的成员">
        {!candidates.length && <p className="bulk-member-removal-empty">{motherId ? '此 Team 暂无可移除的本地成员' : '请先选择一个 Team'}</p>}
        {candidates.map((target) => <label className="bulk-member-removal-row" key={targetKey(target)}>
          <input type="checkbox" disabled={locked} checked={selectedKeys.has(targetKey(target))}
            onChange={(event) => changeSelection(event.target.checked
              ? [...selected, { ...target }]
              : selected.filter((item) => targetKey(item) !== targetKey(target)))} />
          <span><strong>{target.email || target.childId}</strong><small>{target.teamName || '当前 Team'} · 当前成员</small></span>
        </label>)}
      </div>
      {staleCount > 0 && <p className="bulk-member-removal-error" role="alert">有 {staleCount} 个已选成员的账号或 Team 状态已变化，请清空后重新选择。</p>}
      <label className="bulk-member-removal-confirm">
        <input type="checkbox" checked={confirmed} disabled={locked || !selected.length || staleCount > 0} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>我确认移除所选成员，保留本地账号资料</span>
      </label>
      <p className="bulk-member-removal-note"><ShieldAlert size={14} /><span>移除成功且不再属于其他 Team 后，即可在列表勾选删除本地账号。</span></p>
    </>}
    {showResults && <section className="bulk-member-removal-results" aria-label="成员移除结果">
      {(loading || submitted) && <p className="bulk-member-removal-result-team">{teamName(mothers.find((mother) => mother.id === (batch.motherId || motherId)) || { teamName: selected[0]?.teamName || '所选 Team' })}</p>}
      <div className="bulk-member-removal-progress" role="status" aria-live="polite">
        <strong>{loading ? <><RefreshCw size={14} className="button-spinner" />正在移除 {completed}/{total}</> : submitted ? '移除处理完成' : '上次移除结果'}</strong>
        <span>成功 {Number(batch.succeeded) || 0} · 失败 {Number(batch.failed) || 0}</span>
      </div>
      {loading && <progress max={Math.max(total, 1)} value={completed} aria-label="成员移除进度" />}
      {batch.error && <p className="bulk-member-removal-error" role="alert">{batch.error}</p>}
      {results.length > 0 && <ul>
        {results.map((result, index) => <li key={`${targetKey(result)}:${index}`} className={result.ok ? 'succeeded' : 'failed'}>
          {result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
          <div><strong>{result.email || result.childId}</strong><span>{result.ok
            ? result.canDelete ? '已移除，可勾选删除本地账号' : '已移除，本地账号保留；仍有其他成员关系时不可删除'
            : result.error || '移除失败，请稍后重试'}</span></div>
        </li>)}
      </ul>}
    </section>}
    {submitError && <p className="bulk-member-removal-error" role="alert">{submitError}</p>}
    <div className="modal-foot">
      <button className="button ghost" disabled={loading} onClick={onClose}>{finished ? '完成' : '取消'}</button>
      {!finished && <button className="button danger" disabled={locked || !confirmed || !selected.length || staleCount > 0} onClick={confirmRemoval}>
        <UserMinus size={15} />{loading ? `正在移除 ${completed}/${total}` : `确认移除 ${selected.length} 个成员`}
      </button>}
    </div>
  </div>;
}
