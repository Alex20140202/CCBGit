import { Icon } from '../components/Icons';

interface TagListProps {
  repoName: string;
}

export function TagList({ repoName: _repoName }: TagListProps) {
  // Tags would be loaded from API in real implementation
  // For now, showing placeholder
  return (
    <div className="file-tree" style={{ maxHeight: '70vh', overflow: 'auto' }}>
      <div className="empty-state" style={{ padding: '32px' }}>
        <Icon name="tag" size={48} />
        <h3>暂无标签</h3>
        <p>此仓库还没有创建标签</p>
      </div>
    </div>
  );
}