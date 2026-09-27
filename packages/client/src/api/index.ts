const API_BASE = '/api';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export const api = {
  getRepos: () => fetchJson<{ name: string; path: string }[]>(`${API_BASE}/repos`),
  
  getRepoInfo: (name: string) => fetchJson<import('../types').RepoInfo>(`${API_BASE}/repos/${name}/info`),
  
  getTree: (name: string, ref = 'HEAD', path = '') => 
    fetchJson<import('../types').TreeResponse>(`${API_BASE}/repos/${name}/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`),
  
  getBlob: (name: string, ref: string, path: string) => 
    fetch(`${API_BASE}/repos/${name}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`).then(r => r.text()),
  
  getCommits: (name: string, params: { ref?: string; path?: string; limit?: number; skip?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.ref) q.set('ref', params.ref);
    if (params.path) q.set('path', params.path);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.skip) q.set('skip', String(params.skip));
    return fetchJson<import('../types').CommitsResponse>(`${API_BASE}/repos/${name}/commits?${q}`);
  },
  
  getCommit: (name: string, hash: string) => 
    fetchJson<import('../types').CommitDetail>(`${API_BASE}/repos/${name}/commit/${hash}`),
  
  getDiff: (name: string, from: string, to: string, path?: string) => {
    const q = new URLSearchParams();
    q.set('from', from);
    q.set('to', to);
    if (path) q.set('path', path);
    return fetchJson<import('../types').DiffResponse>(`${API_BASE}/repos/${name}/diff?${q}`);
  },
  
  getBranches: (name: string) => 
    fetchJson<import('../types').BranchInfo>(`${API_BASE}/repos/${name}/branches`),
  
  getTags: (name: string) => 
    fetchJson<string[]>(`${API_BASE}/repos/${name}/tags`),
};