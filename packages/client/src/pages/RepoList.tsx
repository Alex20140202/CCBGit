import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Repo } from '../types';
import { Icon } from '../components/Icons';

export function RepoList() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRepos();
  }, []);

  const loadRepos = async () => {
    try {
      setLoading(true);
      const data = await api.getRepos();
      setRepos(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <Icon name="repo" size={64} />
        <h3>加载失败</h3>
        <p>{error}</p>
        <button className="btn btn-primary" onClick={loadRepos}>重试</button>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="empty-state">
        <Icon name="repo" size={64} />
        <h3>暂无仓库</h3>
        <p>在服务器的 repos 目录下创建 Git 仓库</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">仓库列表</h1>
        <span className="text-secondary">{repos.length} 个仓库</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
        {repos.map(repo => (
          <Link key={repo.name} to={`/repo/${repo.name}`} className="repo-card" style={{
            display: 'block',
            padding: '20px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            textDecoration: 'none',
            color: 'inherit',
            transition: 'all 0.15s',
          }} onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent)'} onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border)'}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
              <Icon name="repo" size={28} className="text-accent" />
              <div>
                <h3 style={{ fontSize: '1.125rem', fontWeight: 600 }}>{repo.name}</h3>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{repo.path}</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '16px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <span><Icon name="branch" size={12} /> 分支</span>
              <span><Icon name="commit" size={12} /> 提交</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}