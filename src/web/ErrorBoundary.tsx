import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { t } from './i18n';

/** Last-resort screen so an unexpected render error never leaves a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) { console.error('FeedLantern UI error', error, info.componentStack); }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="boot crash" role="alert">
      <div className="brand"><img className="brand-logo" src="/favicon.svg" alt="" width={40} height={40} /><span>FeedLantern{t('app.tagline') && <small>{t('app.tagline')}</small>}</span></div>
      <h1>{t('crash.title')}</h1>
      <p>{t('crash.body')}</p>
      <code>{this.state.error.message}</code>
      <div className="inline"><button className="button primary" onClick={() => location.reload()}>{t('crash.reload')}</button><button className="button" onClick={() => { location.hash = '#/'; location.reload(); }}>{t('crash.backToFeeds')}</button></div>
    </div>;
  }
}
