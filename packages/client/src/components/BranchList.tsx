import { Link } from 'react-router-dom';
import { Icon } from '../components/Icons';

interface BranchListProps {
  repoName: string;
  branches: string[];
  current: string;
}

export function BranchList({ repoName, branches, current }: BranchListProps) {
  return (
    <div className="file-tree" style={{ maxHeight: '70vh', overflow: 'auto' }}>
      {branches.map(branch => (
        <Link 
          key={branch} 
          to={`/repo/${repoName}/tree/${branch}`}
          className={`tree-item ${branch === current ? 'selected' : ''}`}
        >
          <Icon name="branch" className="tree-icon folder" />
          <span className="tree-name">{branch}</span>
          {branch === current && (
            <span className="tree-size" style={{ color: 'var(--accent)' }}>当前</span>
          )}
        </Link>
      ))}
      {branches.length === 0 && (
        <div className="empty-state" style={{ padding: '32px' }}>
          <Icon name="branch" size={48} />
          <h3>暂无分支</h3>
        </div>
      )}
    </div>
  );
}