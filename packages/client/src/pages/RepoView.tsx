import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api';
import { RepoInfo } from '../types';
import { Icon } from '../components/Icons';
import { FileTree } from '../components/FileTree';
import { CommitList } from '../components/CommitList';
import { BranchList } from '../components/BranchList';
import { TagList } from '../components/TagList';

const TABS = [
  { id: 'tree', label: '文件', icon: 'file' },
  { id: 'commits', label: '提交', icon: 'history' },
  { id: 'branches', label: '分支', icon: 'branch' },
  { id: 'tags', label: '标签', icon: 'tag' },
] as const;

type TabId = typeof TABS[number]['id'];

export function RepoView() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('tree');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name) return;
    loadRepoInfo();
  }, [name]);

  const loadRepoInfo = async () => {
    try {
      setLoading(true);
      const data = await api.getRepoInfo(name!);
      setRepoInfo(data);
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
        加载仓库信息...
      </div>
    );
  }

  if (error || !repoInfo) {
    return (
      <div className="empty-state">
        <Icon name="repo" size={64} />
        <h3>加载失败</h3>
        <p>{error || '仓库不存在'}</p>
        <Link to="/" className="btn btn-primary">返回列表</Link>
      </div>
    );
  }

  const currentBranch = repoInfo.currentBranch || 'main';
  const branches = Array.isArray(repoInfo.branches) ? repoInfo.branches : ['main'];

  return (
    <div>
      <div className="page-header">
        <div className="breadcrumb">
          <Link to="/"><Icon name="home" size={16} /></Link>
          <Icon name="chevronRight" size={14} className="breadcrumb-separator" />
          <Link to={`/repo/${name}`}>{name}</Link>
          <Icon name="chevronRight" size={14} className="breadcrumb-separator" />
          <span>{currentBranch}</span>
        </div>
        <div className="toolbar">
          <div className="toolbar-group">
            <BranchSelector 
              currentBranch={currentBranch}
              branches={branches}
              onChange={(branch) => navigate(`/repo/${name}/tree/${branch}`)}
            />
          </div>
          <div className="toolbar-group">
            <Link to={`/repo/${name}/commits/${currentBranch}`} className="btn btn-secondary btn-sm">
              <Icon name="history" size={14} />
              查看提交历史
            </Link>
          </div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <Icon name={tab.icon} size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'tree' && (
        <FileTree 
          repoName={name!} 
          ref={currentBranch} 
          path=""
        />
      )}
      {activeTab === 'commits' && (
        <CommitList repoName={name!} ref={currentBranch} />
      )}
      {activeTab === 'branches' && (
        <BranchList repoName={name!} branches={repoInfo.branches} current={currentBranch} />
      )}
      {activeTab === 'tags' && (
        <TagList repoName={name!} />
      )}
    </div>
  );
}

function BranchSelector({ currentBranch, branches, onChange }: { 
  currentBranch: string; 
  branches: string[]; 
  onChange: (branch: string) => void; 
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="branch-selector">
      <button className="branch-btn" onClick={() => setOpen(!open)}>
        <Icon name="branch" size={14} />
        {currentBranch}
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="branch-dropdown">
          {branches.map(branch => (
            <div 
              key={branch} 
              className={`branch-item ${branch === currentBranch ? 'current' : ''}`}
              onClick={() => { onChange(branch); setOpen(false); }}
            >
              {branch}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}