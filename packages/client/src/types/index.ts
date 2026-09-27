export interface Repo {
  name: string;
  path: string;
}

export interface RepoInfo {
  name: string;
  currentBranch: string;
  branches: string[];
  remotes: Remote[];
  recentCommits: Commit[];
}

export interface Remote {
  name: string;
  refs: { [key: string]: string };
}

export interface Commit {
  hash: string;
  author: string;
  email: string;
  date: number;
  message: string;
}

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  hash: string;
  size: number;
  name: string;
}

export interface TreeResponse {
  ref: string;
  path: string;
  entries: TreeEntry[];
}

export interface BlobContent {
  content: string;
}

export interface CommitsResponse {
  commits: Commit[];
  ref: string;
  path: string;
}

export interface CommitDetail extends Commit {
  diff: string;
}

export interface DiffResponse {
  from: string;
  to: string;
  path: string;
  diff: string;
}

export interface BranchInfo {
  current: string;
  all: string[];
}

export type ViewMode = 'repos' | 'repo' | 'tree' | 'blob' | 'commits' | 'commit' | 'diff' | 'branches' | 'tags';