import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { TreeEntry, TreeResponse } from '../types';
import { Icon } from '../components/Icons';
import { formatBytes, getFileIcon } from '../utils/helpers';

interface FileTreeProps {
  repoName: string;
  ref: string;
  path: string;
}

export function FileTree({ repoName, ref, path }: FileTreeProps) {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set([path]));

  useEffect(() => {
    loadTree();
  }, [repoName, ref, path]);

  const loadTree = async () => {
    try {
      setLoading(true);
      const data = await api.getTree(repoName, ref, path);
      setTree(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (entryPath: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  };

  const isExpanded = (entryPath: string) => expandedPaths.has(entryPath);

  const folders = useMemo(() => 
    tree?.entries.filter(e => e.type === 'tree') || [], [tree]);
  const files = useMemo(() => 
    tree?.entries.filter(e => e.type === 'blob') || [], [tree]);

  const breadcrumbParts = useMemo(() => {
    if (!path) return [{ name: '/', path: '' }];
    const parts = path.split('/').filter(Boolean);
    return [
      { name: '/', path: '' },
      ...parts.map((_, i) => ({
        name: parts[i],
        path: parts.slice(0, i + 1).join('/')
      }))
    ];
  }, [path]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        加载文件树...
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <Icon name="folder" size={64} />
        <h3>加载失败</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="breadcrumb" style={{ marginBottom: '12px' }}>
        {breadcrumbParts.map((part, i) => (
          <span key={part.path}>
            {i > 0 && <Icon name="chevronRight" size={12} className="breadcrumb-separator" />}
            <Link to={`/repo/${repoName}/tree/${ref}/${part.path}`}>
              {part.name || '/'}
            </Link>
          </span>
        ))}
      </div>

      <div className="file-tree">
        {folders.map(entry => (
          <FileTreeFolder
            key={entry.hash}
            entry={entry}
            repoName={repoName}
            ref={ref}
            basePath={path}
            isExpanded={isExpanded(entry.name)}
            onToggle={toggleExpand}
          />
        ))}
        {files.map(entry => (
          <FileTreeFile
            key={entry.hash}
            entry={entry}
            repoName={repoName}
            ref={ref}
            basePath={path}
          />
        ))}
        {folders.length === 0 && files.length === 0 && (
          <div className="empty-state" style={{ padding: '32px' }}>
            <Icon name="folder" size={48} />
            <h3>空目录</h3>
            <p>此目录下没有文件</p>
          </div>
        )}
      </div>
    </div>
  );
}

function FileTreeFolder({ 
  entry, 
  repoName, 
  ref, 
  basePath, 
  isExpanded, 
  onToggle 
}: { 
  entry: TreeEntry; 
  repoName: string; 
  ref: string; 
  basePath: string; 
  isExpanded: boolean;
  onToggle: (path: string) => void;
}) {
  const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

  return (
    <div className="tree-item">
      <button 
        className="tree-icon folder"
        onClick={(e) => { e.stopPropagation(); onToggle(entryPath); }}
        aria-label={isExpanded ? '折叠' : '展开'}
      >
        <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      <Link 
        to={`/repo/${repoName}/tree/${ref}/${entryPath}`}
        className="tree-name"
        style={{ flex: 1 }}
      >
        {entry.name}/
      </Link>
    </div>
  );
}

function FileTreeFile({ 
  entry, 
  repoName, 
  ref, 
  basePath 
}: { 
  entry: TreeEntry; 
  repoName: string; 
  ref: string; 
  basePath: string; 
}) {
  const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
  const iconName = getFileIcon(entry.name, false);

  return (
    <Link 
      to={`/repo/${repoName}/blob/${ref}/${entryPath}`}
      className="tree-item"
    >
      <Icon name={iconName} className="tree-icon" />
      <span className="tree-name">{entry.name}</span>
      <span className="tree-size">{formatBytes(entry.size)}</span>
    </Link>
  );
}