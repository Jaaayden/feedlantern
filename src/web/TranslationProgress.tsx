import { useEffect, useState } from 'react';
import { api } from './api';
export interface TranslationProgressData {
  worker: { activeArticles: number; activeRequests: number; queuedSegments: number; cooldownUntil: number | null; stopped: boolean };
  tasks: { id: string; title: string; status: string; attempts: number; nextAt: number; error: string | null }[];
  logs: { id: number; at: number; message: string; itemId: string }[];
}
const states: Record<string, string> = { running: '正在翻译', pending: '排队等待', success: '已完成', failed: '失败，需手动重试' };
const time = (value: number) => new Date(value).toLocaleString('zh-CN');
export function TranslationProgress({ id, enabled }: { id: string; enabled: boolean }) {
  const [data, setData] = useState<TranslationProgressData>();
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false, loading = false;
    setData(undefined); setError('');
    const load = async () => {
      if (loading) return;
      loading = true;
      try { const result = await api.feeds.translationProgress(id); if (!disposed) { setData(result); setError(''); } }
      catch { if (!disposed) setError('翻译进度读取失败，正在重试'); }
      finally { loading = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [id]);
  return <section className="translation-progress" aria-label="翻译进度">
    <strong>翻译进度 · 每 2 秒更新</strong>
    {error && <p role="alert">{error}</p>}
    {!data ? <p>正在读取翻译状态…</p> : <>
      <p role="status">{!enabled ? '订阅已暂停' : data.worker.stopped ? '翻译服务已暂停' : data.worker.cooldownUntil ? `Google 请求受限，${time(data.worker.cooldownUntil)} 后恢复调度` : data.tasks.some(t => t.status === 'running') ? '翻译已启动，正在处理' : data.tasks.some(t => t.status === 'pending') ? '等待调度或自动重试' : data.tasks.length ? '本轮翻译已结束' : '等待 RSS 抓取完成'}。全站当前 {data.worker.activeRequests} 个翻译请求，{data.worker.queuedSegments} 个片段排队。</p>
      <details><summary>文章状态（{data.tasks.length}）</summary>
        {data.tasks.map(task => <p key={task.id}><strong>{task.title}</strong>：{states[task.status] ?? task.status}{task.status === 'pending' && task.nextAt > Date.now() && `，下次尝试 ${time(task.nextAt)}`}{task.error && `；${task.error}`}</p>)}
      </details>
      <details open><summary>翻译日志（最近 100 条，保留 7 天）</summary>
        <div className="translation-log-list">{data.logs.length ? data.logs.map(log => <p key={log.id}><time>{time(log.at)}</time> · {data.tasks.find(task => task.id === log.itemId)?.title ?? '文章'} · {log.message}</p>) : <p>暂无翻译日志；新任务开始后会在这里显示。</p>}</div>
      </details>
    </>}
  </section>;
}
