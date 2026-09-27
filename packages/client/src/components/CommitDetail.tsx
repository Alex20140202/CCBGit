import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { CommitDetail } from '../types';
import { Icon } from '../components/Icons';
import { formatDate } from '../utils/helpers';
import { parseDiff, highlightDiff } from '../utils/helpers';

interface CommitDetailViewProps {
  repoName: string;
  hash: string;
}

export function CommitDetailView({ repoName, hash }: CommitDetailViewProps) {
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCommit();
  }, [repoName, hash]);

  const loadCommit = async () => {
    try {
      setLoading(true);
      const data = await api.getCommit(repoName, hash);
      setCommit(data);
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
        加载提交详情...
      </div>
    );
  }

  if (error || !commit) {
    return (
      <div className="empty-state">
        <Icon name="commit" size={64} />
        <h3>加载失败</h3>
        <p>{error || '提交不存在'}</p>
      </div>
    );
  }

  const diffFiles = parseDiff(commit.diff);

  return (
    <div>
      <div className="breadcrumb" style={{ marginBottom: '16px' }}>
        <Link to="/"><Icon name="home" size={16} /></Link>
        <Icon name="chevronRight" size={14} className="breadcrumb-separator" />
        <Link to={`/repo/${repoName}`}>{repoName}</Link>
        <Icon name="chevronRight" size={14} className="breadcrumb-separator" />
        <Link to={`/repo/${repoName}/commits`}>提交</Link>
        <Icon name="chevronRight" size={14} className="breadcrumb-separator" />
        <span>{hash.slice(0, 8)}</span>
      </div>

      <div className="commit-detail">
        <div className="commit-header">
          <div className="commit-header-top">
            <span className="commit-hash-full">{commit.hash}</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {formatDate(commit.date)}
            </span>
          </div>
          <h2 className="commit-message-full">{commit.message}</h2>
          <div className="commit-info">
            <div className="commit-info-item">
              <Icon name="user" size={14} />
              <span>{commit.author}</span>
            </div>
            <div className="commit-info-item">
              <Icon name="mail" size={14} />
              <span>{commit.email}</span>
            </div>
            <div className="commit-info-item">
              <Icon name="clock" size={14} />
              <span>{new Date(commit.date).toLocaleString()}</span>
            </div>
          </div>
        </div>

        {diffFiles.length > 0 && (
          <div className="diff-view">
            {diffFiles.map((file, i) => (
              <div key={i} className="diff-file">
                <div className="diff-header">
                  <Icon name="file" size={14} />
                  <span>{file.file}</span>
                </div>
                <div className="diff-content" dangerouslySetInnerHTML={{ __html: highlightDiff(file.header + '\n' + file.content) }} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}