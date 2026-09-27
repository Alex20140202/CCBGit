export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) {
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours === 0) {
      const minutes = Math.floor(diff / (1000 * 60));
      return minutes <= 1 ? '刚刚' : `${minutes}分钟前`;
    }
    return `${hours}小时前`;
  }
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length - 1) + '…';
}

export function getFileIcon(name: string, isDir: boolean): string {
  if (isDir) return 'folder';
  const ext = name.split('.').pop()?.toLowerCase();
  const icons: Record<string, string> = {
    js: 'file-code',
    ts: 'file-code',
    jsx: 'file-code',
    tsx: 'file-code',
    json: 'file-code',
    html: 'file-code',
    css: 'file-code',
    scss: 'file-code',
    md: 'file-text',
    txt: 'file-text',
    py: 'file-code',
    rs: 'file-code',
    go: 'file-code',
    java: 'file-code',
    c: 'file-code',
    cpp: 'file-code',
    h: 'file-code',
    sh: 'file-code',
    yml: 'file-code',
    yaml: 'file-code',
    toml: 'file-code',
    xml: 'file-code',
    svg: 'file-image',
    png: 'file-image',
    jpg: 'file-image',
    jpeg: 'file-image',
    gif: 'file-image',
    webp: 'file-image',
    mp4: 'file-video',
    mp3: 'file-audio',
    pdf: 'file-pdf',
    zip: 'file-archive',
    tar: 'file-archive',
    gz: 'file-archive',
  };
  return icons[ext || ''] || 'file';
}

export function highlightDiff(diff: string): string {
  return diff
    .split('\n')
    .map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return `<span class="diff-line diff-line-header">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith('+')) {
        return `<span class="diff-line diff-line-added">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith('-')) {
        return `<span class="diff-line diff-line-removed">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith('@@')) {
        return `<span class="diff-line diff-line-header">${escapeHtml(line)}</span>`;
      }
      return `<span class="diff-line diff-line-context">${escapeHtml(line)}</span>`;
    })
    .join('\n');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function parseDiff(diff: string): { file: string; header: string; content: string }[] {
  const files: { file: string; header: string; content: string }[] = [];
  const parts = diff.split(/^diff --git /m).filter(Boolean);
  
  for (const part of parts) {
    const lines = part.split('\n');
    const fileMatch = lines[0].match(/a\/(.+) b\/(.+)/);
    const file = fileMatch ? fileMatch[2] : 'unknown';
    const header = lines.slice(0, 5).join('\n');
    const content = lines.slice(5).join('\n');
    files.push({ file, header, content });
  }
  
  return files;
}