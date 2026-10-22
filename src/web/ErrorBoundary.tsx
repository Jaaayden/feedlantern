import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/** Last-resort screen so an unexpected render error never leaves a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) { console.error('FeedLantern UI error', error, info.componentStack); }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="boot crash" role="alert">
      <div className="brand"><img className="brand-logo" src="/favicon.svg" alt="" width={40} height={40} /><span>FeedLantern<small>订阅灯</small></span></div>
      <h1>页面出错了</h1>
      <p>界面遇到意外错误。订阅和后台任务不受影响，重新加载通常即可恢复。</p>
      <code>{this.state.error.message}</code>
      <div className="inline"><button className="button primary" onClick={() => location.reload()}>重新加载</button><button className="button" onClick={() => { location.hash = '#/'; location.reload(); }}>返回订阅列表</button></div>
    </div>;
  }
}
