import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { api } from './api';
import { Layout } from './components/Layout';
import { RepoList } from './pages/RepoList';
import { RepoView } from './pages/RepoView';
import { BlobView } from './components/BlobView';
import { CommitDetailView } from './components/CommitDetail';
import { DiffView } from './components/DiffView';
import { ErrorBoundary } from './components/ErrorBoundary';

function BlobViewWrapper() {
  const { name, ref, '*': path } = useParams<{ name: string; ref: string; '*': string }>();
  return <BlobView repoName={name!} ref={ref!} path={path?.slice(1) || ''} />;
}

function CommitDetailWrapper() {
  const { name, hash } = useParams<{ name: string; hash: string }>();
  return <CommitDetailView repoName={name!} hash={hash!} />;
}

function DiffViewWrapper() {
  const { name, from, to, path } = useParams<{ name: string; from: string; to: string; path?: string }>();
  return <DiffView repoName={name!} from={from!} to={to!} path={path} />;
}

function App() {
  const [repos, setRepos] = useState<{ name: string }[]>([]);
  const [currentRepo, setCurrentRepo] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadRepos();
  }, []);

  const loadRepos = async () => {
    try {
      const data = await api.getRepos();
      setRepos(data);
    } catch (e) {
      console.error('Failed to load repos:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectRepo = (name: string) => {
    setCurrentRepo(name);
  };

  const handleRefresh = () => {
    loadRepos();
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: 32, height: 32 }}></div>
      </div>
    );
  }

  return (
    <Layout 
      repos={repos} 
      currentRepo={currentRepo}
      onSelectRepo={handleSelectRepo}
      onRefresh={handleRefresh}
    >
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<RepoList />} />
          <Route path="/repo/:name" element={<RepoView />} />
          <Route path="/repo/:name/tree/:ref/*" element={<RepoView />} />
          <Route path="/repo/:name/blob/:ref/*" element={<BlobViewWrapper />} />
          <Route path="/repo/:name/commits/:ref" element={<RepoView />} />
          <Route path="/repo/:name/commit/:hash" element={<CommitDetailWrapper />} />
          <Route path="/repo/:name/diff/:from/:to" element={<DiffViewWrapper />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </Layout>
  );
}

export default App;