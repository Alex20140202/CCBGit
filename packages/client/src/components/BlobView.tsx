import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icons';
import { getFileIcon } from '../utils/helpers';

interface BlobViewProps {
  repoName: string;
  ref: string;
  path: string;
}

export function BlobView({ repoName, ref, path }: BlobViewProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBlob();
  }, [repoName, ref, path]);

  const loadBlob = async () => {
    try {
      setLoading(true);
      const data = await api.getBlob(repoName, ref, path);
      setContent(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const lines = content.split('\n');
  const iconName = getFileIcon(path, false);

  const breadcrumbParts = path.split('/').filter(Boolean);
  const breadcrumbs = [
    { name: '/', path: '' },
    ...breadcrumbParts.map((_, i) => ({
      name: breadcrumbParts[i],
      path: breadcrumbParts.slice(0, i + 1).join('/')
    }))
  ];

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        加载文件...
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <Icon name="file" size={64} />
        <h3>加载失败</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="breadcrumb" style={{ marginBottom: '12px' }}>
        {breadcrumbs.map((part, i) => (
          <span key={part.path}>
            {i > 0 && <Icon name="chevronRight" size={12} className="breadcrumb-separator" />}
            {i === breadcrumbs.length - 1 ? (
              <span>{part.name}</span>
            ) : (
              <Link to={`/repo/${repoName}/tree/${ref}/${part.path}`}>{part.name}</Link>
            )}
          </span>
        ))}
      </div>

      <div className="blob-view">
        <div className="blob-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Icon name={iconName} size={18} />
            <span style={{ fontWeight: 500 }}>{path}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-ghost btn-sm" title="复制路径">
              <Icon name="copy" size={14} />
            </button>
            <button className="btn btn-ghost btn-sm" title="下载文件">
              <Icon name="download" size={14} />
            </button>
          </div>
        </div>
        <div className="blob-content">
          {lines.map((line, i) => (
            <div key={i} className="blob-line">
              <span className="blob-line-number">{i + 1}</span>
              <span className="blob-line-content">{line || ' '}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}