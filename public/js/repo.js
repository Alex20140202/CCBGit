/* Repository page: lazy branch list, line anchors, file size column. */
(() => {
  'use strict';

  const repoId = document.body.dataset.repoId || window.location.pathname.split('/').slice(1, 3).join('/');

  /* ------------------------------------------------- branch switcher */

  const branchList = document.getElementById('branch-list');
  if (branchList) {
    const apiUrl = `/api/repos/${repoId}/refs`;

    const render = (data) => {
      const items = [
        ...data.branches.map((branch) => ({ ...branch, remote: false })),
        ...data.remotes.map((branch) => ({ ...branch, remote: true })),
      ];
      if (!items.length) return;

      const params = new URLSearchParams(window.location.search);
      const current = params.get('ref') || data.head;

      branchList.replaceChildren(...items.map((branch) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = `side-ref${branch.name === current || branch.shortName === current ? ' is-current' : ''}`;
        a.href = `/${repoId}/tree/${encodeURIComponent(branch.name)}${restOfPath()}`;
        a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12a3 3 0 0 0 3 3h7m0 0-3-3m3 3-3 3"></path></svg>';
        const name = document.createElement('span');
        name.className = 'ref-name';
        name.textContent = branch.name;
        a.appendChild(name);
        if (branch.remote) {
          const tag = document.createElement('span');
          tag.className = 'tree-hint';
          tag.textContent = 'remote';
          a.appendChild(tag);
        }
        li.appendChild(a);
        return li;
      }));

      // Tags deserve their own group underneath the branches.
      if (data.tags && data.tags.length) {
        const heading = document.createElement('li');
        heading.className = 'side-heading';
        heading.textContent = `Tags (${data.tags.length})`;
        branchList.appendChild(heading);

        for (const tag of data.tags.slice(0, 12)) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.className = 'side-ref';
          a.href = `/${repoId}/tree/${encodeURIComponent(tag.name)}${restOfPath()}`;
          a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v10H4zM9 7v10M4 12h16"></path></svg>';
          const name = document.createElement('span');
          name.className = 'ref-name';
          name.textContent = tag.name;
          a.appendChild(name);
          li.appendChild(a);
          branchList.appendChild(li);
        }
      }
    };

    /** Keep the current file/directory when switching branch, when possible. */
    function restOfPath() {
      const match = window.location.pathname.match(/\/tree\/[^/]+\/?(.*)$/)
        || window.location.pathname.match(/\/blob\/[^/]+\/?(.*)$/);
      if (!match || !match[1]) return '';
      return `/${match[1]}${window.location.search}`;
    }

    fetch(apiUrl)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then(render)
      .catch(() => { /* the static list already links to the current ref */ });
  }

  /* ------------------------------------------------- #L12 line anchors */

  const anchor = window.location.hash.match(/^#L(\d+)$/);
  if (anchor) {
    const lineNumber = Number(anchor[1]);
    const wrap = document.querySelector('.code-wrap');
    const gutter = wrap && wrap.querySelector('.code-gutter');
    if (gutter && gutter.children[lineNumber - 1]) {
      const target = gutter.children[lineNumber - 1];
      target.scrollIntoView({ block: 'center' });
      target.style.color = 'var(--accent)';
      target.style.fontWeight = '700';
    }
  }

  /* -------------------------------------------- diff: collapse all/none */

  const diffs = document.querySelectorAll('.diff-file');
  if (diffs.length > 1) {
    const makeButton = (label, open) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost-button';
      button.textContent = label;
      button.addEventListener('click', () => {
        diffs.forEach((node) => { node.open = open; });
      });
      return button;
    };

    const group = document.createElement('span');
    group.className = 'diff-toggle';
    group.append(makeButton('Expand all', true), makeButton('Collapse all', false));

    // The view already renders a summary bar with the add/delete counts, so the
    // controls join it rather than stacking a second bar on top of it.
    const bar = document.querySelector('.diff-summary');
    if (bar) bar.appendChild(group);
    else {
      const created = document.createElement('div');
      created.className = 'diff-summary';
      created.appendChild(group);
      diffs[0].before(created);
    }
  }

  /* ------------------------------------------- file sizes in the tree */

  const treeRoot = document.querySelector('[data-tree-root]');
  if (treeRoot) {
    fetch(`/api/repos/${repoId}/tree?ref=${encodeURIComponent(new URLSearchParams(window.location.search).get('ref') || 'HEAD')}&path=${encodeURIComponent(treeRoot.dataset.treeRoot || '')}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || !data.entries) return;
        const rows = treeRoot.querySelectorAll('.tree-row');
        data.entries.forEach((entry, i) => {
          const cell = rows[i] && rows[i].querySelector('.tree-commit');
          if (cell) cell.textContent = entry.isDir ? '' : formatBytes(entry.size);
        });
      })
      .catch(() => { /* sizes are a nicety, not a requirement */ });
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }
})();
