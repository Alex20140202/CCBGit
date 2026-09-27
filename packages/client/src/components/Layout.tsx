import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icons';

interface LayoutProps {
  repos: { name: string }[];
  currentRepo?: string;
  onSelectRepo: (name: string) => void;
  onRefresh: () => void;
  children: React.ReactNode;
}

export function Layout({ repos, currentRepo, onSelectRepo, onRefresh, children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="layout">
      <header className="header">
        <div className="header-brand">
          <Link to="/" onClick={() => setSidebarOpen(false)}>
            <Icon name="repo" size={28} />
            <span>CCBGit</span>
          </Link>
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost btn-sm" onClick={onRefresh} title="刷新">
            <Icon name="refresh" size={16} />
          </button>
          <button 
            className="btn btn-ghost btn-sm md:hidden" 
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="切换侧边栏"
          >
            <Icon name={sidebarOpen ? 'x' : 'menu'} size={20} />
          </button>
        </div>
      </header>

      <aside 
        className={`sidebar ${sidebarOpen ? 'open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      >
        <div className="sidebar-section">
          <div className="sidebar-title">仓库</div>
          <ul className="repo-list">
            {repos.map(repo => (
              <li 
                key={repo.name}
                className={`repo-item ${currentRepo === repo.name ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectRepo(repo.name);
                  setSidebarOpen(false);
                }}
              >
                <Icon name="repo" className="repo-icon" />
                <span className="repo-name">{repo.name}</span>
              </li>
            ))}
            {repos.length === 0 && (
              <li className="repo-item" style={{ justifyContent: 'center', color: 'var(--text-secondary)' }}>
                暂无仓库
              </li>
            )}
          </ul>
        </div>
      </aside>

      <main className="main" onClick={() => setSidebarOpen(false)}>
        {children}
      </main>
    </div>
  );
}