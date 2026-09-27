import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Commit } from '../types';
import { Icon } from '../components/Icons';
import { formatDate } from '../utils/helpers';

interface CommitListProps {
  repoName: string;
  ref: string;
  path?: string;
}

export function CommitList({ repoName, ref, path }: CommitListProps) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [skip, setSkip] = useState(0);
  const LIMIT = 50;

  const loadCommits = useCallback(async (isLoadMore = false) => {
    try {
      if (isLoadMore) setLoadingMore(true);
      else setLoading(true);
      
      const data = await api.getCommits(repoName, { ref, path, limit: LIMIT, skip });
      setCommits(prev => isLoadMore ? [...prev, ...data.commits] : data.commits);
      setHasMore(data.commits.length === LIMIT);
      if (!isLoadMore) setSkip(LIMIT);
      else setSkip(prev => prev + LIMIT);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [repoName, ref, path, skip]);

  useEffect(() => {
    loadCommits(false);
  }, [repoName, ref, path]);

  const handleLoadMore = () => loadCommits(true);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        加载提交历史...
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <Icon name="history" size={64} />
        <h3>加载失败</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="empty-state">
        <Icon name="history" size={64} />
        <h3>暂无提交</h3>
        <p>{path ? `路径 ${path} 下没有提交` : '此分支还没有提交'}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="commit-list">
        {commits.map(commit => (
          <Link 
            key={commit.hash} 
            to={`/repo/${repoName}/commit/${commit.hash}`}
            className="commit-item"
          >
            <span className="commit-hash">{commit.hash.slice(0, 7)}</span>
            <span className="commit-message">{commit.message}</span>
            <div className="commit-meta">
              <span className="commit-author">
                <Icon name="user" size={12} />
                {commit.author}
              </span>
              <span className="commit-date">
                <Icon name="clock" size={12} />
                {formatDate(commit.date)}
              </span>
            </div>
          </Link>
        ))}
      </div>

      {hasMore && (
        <div style={{ textAlign: 'center', padding: '16px' }}>
          <button 
            className="btn btn-secondary" 
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <>
                <div className="spinner" style={{ width: 16, height: 16, marginRight: 8 }} />
                加载中...
              </>
            ) : (
              <>
                <Icon name="history" size={14} />
                加载更多
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}