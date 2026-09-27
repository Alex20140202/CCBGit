import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { DiffResponse } from '../types';
import { Icon } from '../components/Icons';
import { parseDiff, highlightDiff } from '../utils/helpers';

interface DiffViewProps {
  repoName: string;
  from: string;
  to: string;
  path?: string;
}

export function DiffView({ repoName, from, to, path }: DiffViewProps) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDiff();
  }, [repoName, from, to, path]);

  const loadDiff = async () => {
    try {
      setLoading(true);
      const data = await api.getDiff(repoName, from, to, path);
      setDiff(data);
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
        加载差异...
      </div>
    );
  }

  if (error || !diff) {
    return (
      <div className="empty-state">
        <Icon name="diff" size={64} />
        <h3>加载失败</h3>
        <p>{error || '无差异'}</p>
      </div>
    );
  }

  const diffFiles = parseDiff(diff.diff);

  return (
    <div>
      <div className="page-header">
        <div className="breadcrumb">
          <Link to="/"><Icon name="home" size={16} /></Link>
          <Icon name="chevronRight" size={14} className="breadcrumb-separator" />
          <Link to={`/repo/${repoName}`}>{repoName}</Link>
          <Icon name="chevronRight" size={14} className="breadcrumb-separator" />
          <span>比较</span>
        </div>
        <h1 className="page-title">
          <code>{from.slice(0, 8)}</code> → <code>{to.slice(0, 8)}</code>
          {path && <span style={{ marginLeft: '12px', color: 'var(--text-secondary)' }}>{path}</span>}
        </h1>
      </div>

      <div className="diff-view">
        {diffFiles.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px' }}>
            <Icon name="diff" size={48} />
            <h3>无差异</h3>
            <p>两个版本之间没有文件变更</p>
          </div>
        ) : (
          diffFiles.map((file, i) => (
            <div key={i} className="diff-file">
              <div className="diff-header">
                <Icon name="file" size={14} />
                <span>{file.file}</span>
              </div>
              <div className="diff-content" dangerouslySetInnerHTML={{ __html: highlightDiff(file.header + '\n' + file.content) }} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}