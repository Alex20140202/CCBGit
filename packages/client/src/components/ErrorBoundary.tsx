import { Component, ReactNode, ErrorInfo } from 'react';
import { Icon } from './Icons';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="empty-state" style={{ padding: '48px' }}>
          <Icon name="x" size={64} className="text-danger" />
          <h3>页面出错</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '16px', fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
            {this.state.error?.message}
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}